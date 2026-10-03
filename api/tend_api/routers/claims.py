from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Response

from ..deps import CLAIM_HEADER, ENGINE_HEADER, EnginePref, IdPath, ServicesDep
from ..models import ClaimInput

router = APIRouter(tags=["claims"])


@router.post("/claim")
def evaluate_claim(
    body: ClaimInput,
    response: Response,
    svc: ServicesDep,
    scan_id: Annotated[str | None, Query(pattern=r"^[A-Za-z0-9_\-]{1,64}$", description="check every line against this scan")] = None,
    engine: EnginePref = "auto",
) -> dict[str, Any]:
    result, engine_name = svc.claims.evaluate(body, scan_id, engine)
    response.headers[ENGINE_HEADER] = engine_name
    response.headers[CLAIM_HEADER] = result["claim_id"]
    return result


@router.get("/claims/{claim_id}")
def get_claim(claim_id: IdPath, svc: ServicesDep) -> dict[str, Any]:
    return svc.claims.view(svc.claims.get(claim_id))
