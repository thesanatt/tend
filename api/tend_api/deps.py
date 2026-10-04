from __future__ import annotations

from typing import Annotated, Literal

from fastapi import Depends, Path, Query, Request

from .services import Services

ENGINE_HEADER = "X-Tend-Engine"
LAW_VERSION_HEADER = "X-Tend-Law-Version"


def get_services(request: Request) -> Services:
    return request.app.state.services


ServicesDep = Annotated[Services, Depends(get_services)]
EnginePref = Annotated[Literal["auto", "native", "reference"], Query(description="auto tries native, then the Python reference")]
StatePath = Annotated[str, Path(pattern=r"^[A-Za-z]{2}$")]
IdPath = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$")]
ActionPath = Annotated[str, Path(pattern=r"^act_[0-9a-f]{20}$")]
SharePath = Annotated[str, Path(pattern=r"^[A-Za-z0-9_\-]{22,64}$")]
PersonaPath = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9\-]{0,39}$")]
