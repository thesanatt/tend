from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header

from ..agent import AgentError
from ..deps import ServicesDep, StatePath
from ..models import AgentConfirmRequest, AgentLinkRequest, AgentPayRequest, AgentRedeemRequest

router = APIRouter(prefix="/agent", tags=["agent"])


def session_claim(svc: ServicesDep, authorization: Annotated[str | None, Header()] = None) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise AgentError("Send the agent token as: Authorization: Bearer <token>.", 401)
    return svc.agent.session_claim(token.strip())


SessionClaim = Annotated[str, Depends(session_claim)]


@router.get("/checklist/{st}")
def checklist(
    st: StatePath,
    svc: ServicesDep,
    incident_date: dt.date | None = None,
    forensic_exam: bool | None = None,
    police_report: Literal["yes", "no", "unknown"] = "unknown",
) -> dict[str, Any]:
    return svc.agent.checklist(st.upper(), incident_date, forensic_exam, police_report)


@router.post("/link")
def create_link(body: AgentLinkRequest, svc: ServicesDep) -> dict[str, Any]:
    return svc.agent.create_link(body.claim_id)


@router.post("/redeem")
def redeem(body: AgentRedeemRequest, svc: ServicesDep) -> dict[str, Any]:
    return svc.agent.redeem(body.link_code)


@router.get("/claim")
def claim_summary(claim_id: SessionClaim, svc: ServicesDep) -> dict[str, Any]:
    return svc.agent.summary(claim_id)


@router.post("/pay")
def pay(body: AgentPayRequest, claim_id: SessionClaim, svc: ServicesDep) -> dict[str, Any]:
    return svc.agent.pay(claim_id, body)


@router.post("/confirm")
def confirm(body: AgentConfirmRequest, claim_id: SessionClaim, svc: ServicesDep) -> dict[str, Any]:
    return svc.agent.confirm(claim_id, body)
