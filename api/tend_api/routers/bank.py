from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Path, Query, Response

from ..deps import PersonaPath, ServicesDep

router = APIRouter(prefix="/bank", tags=["bank relay"])


@router.get("/{persona}/transactions")
def transactions(
    persona: PersonaPath,
    svc: ServicesDep,
    start: Annotated[dt.date | None, Query(alias="from")] = None,
    end: Annotated[dt.date | None, Query(alias="to")] = None,
    account: Literal["checking", "cushion", "savings"] = "checking",
) -> dict[str, Any]:
    """A demo persona's statement as StatementTxn rows (money out positive). Relayed, never stored or logged."""
    return svc.relay.transactions(persona, start, end, account)


@router.get("/{persona}/bills/{bill_id}/document", response_class=Response)
def bill_document(persona: PersonaPath, bill_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9\-]{1,64}$")], svc: ServicesDep) -> Response:
    """The persona's itemized bill, so the device can read it with on-device AI."""
    data, media_type = svc.relay.bill_document(persona, bill_id)
    return Response(data, media_type=media_type, headers={"Content-Disposition": 'inline; filename="itemized-bill.pdf"'})
