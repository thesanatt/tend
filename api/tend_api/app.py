from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings, load_env_file
from .deps import ENGINE_HEADER, LAW_VERSION_HEADER
from .engine import EngineError, EngineUnavailable
from .errors import TendError
from .redact import PublicErrors, path_roots, secret_values
from .routers import actions, agent, ai, bank, bill, claims, jurisdictions, law, packet, rules, scan, shares, system
from .services import Services, build_services
from .sweep import sweep_forever

MAX_BODY_BYTES = 16 * 1024 * 1024
TOO_LARGE = "That request is too large."
# Requests whose very path is private: a share's id, a bank relay read, a cloud AI call, a search typed
# in someone's own words. Their access-log lines are dropped so the server keeps no record that they
# happened (docs/PRIVACY.md).
QUIET_PREFIXES = (
    "/api/shares",
    "/api/bank/",
    "/api/ai/",
    "/api/claim",
    "/api/packet",
    "/api/agent/",
    "/api/rules/search",
    "/api/law/search",
)


class QuietPaths(logging.Filter):
    """Every other access-log line keeps the method, the path without its query, and the status: no client
    address and no query string, so the log cannot show who looked something up or what they asked."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args if isinstance(record.args, tuple) else ()
        if len(args) < 3:
            return True
        path = str(args[2])
        if path.startswith(QUIET_PREFIXES):
            return False
        record.args = ("-", args[1], path.split("?", 1)[0], *args[3:])
        return True


def quiet_access_log() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, QuietPaths) for f in access.filters):
        access.addFilter(QuietPaths())
    # pypdf warns about a damaged PDF with bytes copied out of it ("invalid pdf header: b'Rowan'"), and Python
    # prints unhandled warnings to stderr, which is the server log. A file someone uploads must not land there.
    logging.getLogger("pypdf").setLevel(logging.CRITICAL + 1)


class BodyLimit:
    """Reads the request body up to the limit before the app sees it, so a body sent without a
    Content-Length (chunked) is refused with 413 instead of being read into memory whole."""

    def __init__(self, app: ASGIApp, limit: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":  # the client went away
                return
            body = message.get("body", b"")
            size += len(body)
            if size > self.limit:
                await JSONResponse(status_code=413, content={"detail": TOO_LARGE})(scope, receive, send)
                return
            chunks.append(body)
            if not message.get("more_body", False):
                break
        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    owns_services = services is None
    if services is None:
        if settings is None:
            load_env_file()
            settings = Settings.from_env()
        services = build_services(settings)
    quiet_access_log()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        sweeper = asyncio.create_task(sweep_forever(services))
        try:
            yield
        finally:
            sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sweeper
            if owns_services:  # the database pool belongs to this app; services passed in belong to the caller
                if services.law is not None:
                    services.law.close()
                services.repo.close()

    app = FastAPI(
        title="Tend API",
        version="0.2.0",
        summary="Local-first: the server holds the public law corpus, sealed shares, and the payment audit log.",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.services = services
    # Innermost, so a 413 from it still passes through CORS and the private headers below.
    app.add_middleware(BodyLimit, limit=MAX_BODY_BYTES)
    if services.settings.deployed:  # a public deployment's error messages name no file paths (docs/DEPLOY.md)
        app.add_middleware(PublicErrors, roots=path_roots(services.settings), secrets=secret_values(services.settings))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(services.settings.cors_origins),
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
        expose_headers=[ENGINE_HEADER, LAW_VERSION_HEADER, "Content-Disposition"],
    )

    @app.middleware("http")
    async def private_by_default(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": TOO_LARGE})
        response = await call_next(request)
        # Nothing should be cached, and a share link must never leak through a Referer header.
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    @app.exception_handler(TendError)
    async def tend_error(_: Request, exc: TendError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(EngineUnavailable)
    async def engine_unavailable(_: Request, exc: EngineUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(EngineError)
    async def engine_error(_: Request, exc: EngineError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    for module in (system, jurisdictions, rules, claims, scan, bill, bank, actions, shares, ai, agent, packet, law):
        app.include_router(module.router, prefix="/api")
    return app
