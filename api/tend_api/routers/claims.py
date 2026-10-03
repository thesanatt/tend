from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import ENGINE_HEADER, EnginePref, ServicesDep
from ..models import ClaimInput

router = APIRouter(tags=["claims"])


@router.post("/claim")
def evaluate_claim(body: ClaimInput, response: Response, svc: ServicesDep, engine: EnginePref = "auto") -> dict[str, Any]:
    """Engine input in, engine output out (SPEC v1.2). Evaluated and returned; nothing is stored."""
    output, engine_name, _ = svc.claims.evaluate(body, engine)
    response.headers[ENGINE_HEADER] = engine_name
    return output
