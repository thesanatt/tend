from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..deps import ServicesDep
from ..models import AiBillRequest, AiClassifyRequest

router = APIRouter(prefix="/ai", tags=["cloud ai"])


@router.post("/classify")
def classify(body: AiClassifyRequest, svc: ServicesDep) -> dict[str, Any]:
    """Expense labels for statement lines, for a device without on-device AI. Needs consent: true."""
    return svc.ai.classify(body)


@router.post("/bill")
def read_bill(body: AiBillRequest, svc: ServicesDep) -> dict[str, Any]:
    """A bill's lines, which must add up to its total or the reading is marked unreliable. Needs consent: true."""
    return svc.ai.read_bill(body)
