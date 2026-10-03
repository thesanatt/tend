from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..deps import ActionPath, ServicesDep
from ..models import ConfirmRequest, ProposeRequest

router = APIRouter(tags=["actions"])


@router.post("/actions/propose")
def propose(body: ProposeRequest, svc: ServicesDep) -> dict[str, Any]:
    """A payment and its six-digit confirm code, good once for ten minutes. Nothing moves yet."""
    return svc.actions.propose(body)


@router.post("/actions/confirm")
def confirm(body: ConfirmRequest, svc: ServicesDep) -> dict[str, Any]:
    """Check the code, write the withdrawal tagged with the action id, read it back, and log it."""
    return svc.actions.confirm(body)


@router.get("/actions/{action_id}")
def get_action(action_id: ActionPath, svc: ServicesDep) -> dict[str, Any]:
    return svc.actions.view(action_id)
