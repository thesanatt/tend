from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import ENGINE_HEADER, EnginePref, ServicesDep
from ..models import BillAuditRequest

router = APIRouter(tags=["bill"])


@router.post("/bill/audit")
def audit_bill(body: BillAuditRequest, response: Response, svc: ServicesDep, engine: EnginePref = "auto") -> dict[str, Any]:
    result, engine_name = svc.claims.audit_bill(body, engine)
    response.headers[ENGINE_HEADER] = engine_name
    return result
