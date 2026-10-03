from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from ..deps import ServicesDep, StatePath
from ..errors import TendError
from ..money import sha256_hex

router = APIRouter(tags=["jurisdictions"])


def _require(svc: ServicesDep, st: str) -> dict[str, Any]:
    doc = svc.rules.get(st)
    if doc is None:
        raise TendError(f"No verified rules for {st.upper()}.", 404)
    return doc


@router.get("/jurisdictions")
def list_jurisdictions(svc: ServicesDep) -> dict[str, Any]:
    return {"jurisdictions": [svc.rules.summary(st) for st in svc.rules.codes()]}


@router.get("/jurisdictions/{st}")
def get_jurisdiction(st: StatePath, svc: ServicesDep) -> dict[str, Any]:
    doc = _require(svc, st)
    return {**doc, "rules_sha256": svc.rules.file_sha256(st)}


@router.get("/jurisdictions/{st}/asm", response_model=None)
def disassembly(st: StatePath, svc: ServicesDep, format: Literal["json", "text"] = "json") -> dict[str, Any] | PlainTextResponse:
    st = st.upper()
    _require(svc, st)
    native = svc.engines.native
    listing = native.disasm(st)
    if format == "text":
        return PlainTextResponse(listing)
    image, _ = native.law_image(st)
    return {
        "jurisdiction": st,
        "engine_version": native.version(),
        "image_sha256": sha256_hex(image),
        "image_bytes": len(image),
        "rules_sha256": svc.rules.file_sha256(st),
        "listing": listing,
    }
