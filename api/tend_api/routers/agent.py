from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query

from ..deps import ServicesDep
from ..models import AgentAnswerRequest, AgentCheckRequest, AgentConfirmRequest, AgentPayRequest

router = APIRouter(prefix="/agent", tags=["agent"])


@router.post("/answer")
def answer(body: AgentAnswerRequest, svc: ServicesDep) -> dict[str, Any]:
    """A cited answer from one state's verified rules, or a refusal when no rule supports one."""
    return svc.agent.answer(body.question, body.st)


@router.post("/check")
def check(body: AgentCheckRequest, svc: ServicesDep) -> dict[str, Any]:
    """The Check summary: deadline, police report, what is covered with caps, and the program's contact."""
    return svc.agent.check(body)


@router.get("/check")
def check_get(
    svc: ServicesDep,
    st: Annotated[str, Query(pattern=r"^[A-Za-z]{2}$")],
    incident_date: dt.date | None = None,
    forensic_exam: bool | None = None,
    police_report: Literal["yes", "no", "not_yet", "unknown"] = "unknown",
) -> dict[str, Any]:
    return svc.agent.check(AgentCheckRequest(st=st, incident_date=incident_date, forensic_exam=forensic_exam, police_report=police_report))


@router.post("/pay")
def pay(body: AgentPayRequest, svc: ServicesDep) -> dict[str, Any]:
    """Set up a payment. Nothing moves until the survivor types the amount back (POST /agent/confirm)."""
    return svc.agent.pay(body)


@router.post("/confirm")
def confirm(body: AgentConfirmRequest, svc: ServicesDep) -> dict[str, Any]:
    return svc.agent.confirm(body)
