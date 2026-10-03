from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import Settings, load_env_file
from .deps import CLAIM_HEADER, ENGINE_HEADER
from .engine import EngineError, EngineUnavailable
from .errors import TendError
from .routers import actions, agent, bill, claims, jurisdictions, packet, scan, share, system
from .services import Services, build_services


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    if services is None:
        if settings is None:
            load_env_file()
            settings = Settings.from_env()
        services = build_services(settings)

    app = FastAPI(title="Tend API", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.state.services = services
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(services.settings.cors_origins),
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
        expose_headers=[ENGINE_HEADER, CLAIM_HEADER, "Content-Disposition"],
    )

    @app.middleware("http")
    async def private_by_default(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        # Claims and share links carry sensitive data; nothing should be cached or leak a share token via Referer.
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

    for module in (system, jurisdictions, scan, claims, bill, actions, packet, share, agent):
        app.include_router(module.router, prefix="/api")
    return app
