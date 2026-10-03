from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import Settings, load_env_file
from .deps import ENGINE_HEADER
from .engine import EngineError, EngineUnavailable
from .errors import TendError
from .routers import actions, agent, ai, bank, bill, claims, jurisdictions, packet, rules, scan, shares, system
from .services import Services, build_services

MAX_BODY_BYTES = 16 * 1024 * 1024
# Requests whose very path is private: a share's id, a bank relay read, a cloud AI call. Their access-log
# lines are dropped so the server keeps no record that they happened (docs/PRIVACY.md).
QUIET_PREFIXES = ("/api/shares", "/api/bank/", "/api/ai/", "/api/claim", "/api/packet", "/api/agent/")


class QuietPaths(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args if isinstance(record.args, tuple) else ()
        path = str(args[2]) if len(args) >= 3 else ""
        return not path.startswith(QUIET_PREFIXES)


def quiet_access_log() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, QuietPaths) for f in access.filters):
        access.addFilter(QuietPaths())


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
        yield
        if owns_services:  # the database pool belongs to this app; services passed in belong to the caller
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
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(services.settings.cors_origins),
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
        expose_headers=[ENGINE_HEADER, "Content-Disposition"],
    )

    @app.middleware("http")
    async def private_by_default(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "That request is too large."})
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

    for module in (system, jurisdictions, rules, claims, scan, bill, bank, actions, shares, ai, agent, packet):
        app.include_router(module.router, prefix="/api")
    return app
