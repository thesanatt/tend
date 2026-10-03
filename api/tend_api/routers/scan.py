from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..deps import ServicesDep
from ..errors import TendError
from ..models import ScanRequest

router = APIRouter(tags=["scan"])


@router.post("/scan")
def scan(body: ScanRequest, svc: ServicesDep) -> dict[str, Any]:
    if svc.rules.get(body.st) is None:
        raise TendError(f"No verified rules for {body.st}.", 404)
    return svc.scans.scan(body)
