from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import IdPath, ServicesDep
from ..errors import TendError
from ..forms import fill_application
from ..packet import render_packet, still_needed

router = APIRouter(tags=["packet"])


def _pdf(data: bytes, filename: str) -> Response:
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{filename}"'})


@router.get("/packet/{claim_id}.pdf", response_class=Response)
def packet_pdf(claim_id: IdPath, svc: ServicesDep) -> Response:
    view = svc.claims.view(svc.claims.get(claim_id))
    data = render_packet(view, svc.rules.get(view["jurisdiction"]) or {}, svc.settings.forms_dir, svc.clock())
    return _pdf(data, f"tend-{claim_id}.pdf")


@router.get("/packet/{claim_id}/application.pdf", response_class=Response)
def application_pdf(claim_id: IdPath, svc: ServicesDep) -> Response:
    view = svc.claims.view(svc.claims.get(claim_id))
    data = fill_application(svc.settings.forms_dir, view["jurisdiction"], view)
    if data is None:
        raise TendError(f"Tend does not have {view['jurisdiction']}'s application form yet.", 404)
    return _pdf(data, f"tend-{claim_id}-application.pdf")


@router.get("/packet/{claim_id}/needed")
def needed(claim_id: IdPath, svc: ServicesDep) -> dict[str, Any]:
    view = svc.claims.view(svc.claims.get(claim_id))
    return {"claim_id": claim_id, "needed": still_needed(view, svc.rules.get(view["jurisdiction"]) or {})}
