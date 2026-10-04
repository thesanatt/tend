from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import ENGINE_HEADER, LAW_VERSION_HEADER, EnginePref, ServicesDep
from ..law import version_ref
from ..models import ClaimInput

router = APIRouter(tags=["claims"])


@router.post("/claim")
def evaluate_claim(body: ClaimInput, response: Response, svc: ServicesDep, engine: EnginePref = "auto") -> dict[str, Any]:
    """Engine input in, engine output out (SPEC v1.2). Evaluated and returned; nothing is stored. `law_version` names the
    published law version (a Neon branch) whose files match the rules this claim was checked with, or is null."""
    output, engine_name, _ = svc.claims.evaluate(body, engine)
    response.headers[ENGINE_HEADER] = engine_name
    version = svc.law.version_for(body.jurisdiction) if svc.law else None
    if version:
        response.headers[LAW_VERSION_HEADER] = version["name"]
    return {**output, "law_version": version_ref(version)}
