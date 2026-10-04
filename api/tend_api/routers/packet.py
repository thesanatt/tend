from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Response

from ..deps import ENGINE_HEADER, LAW_VERSION_HEADER, EnginePref, ServicesDep
from ..law import version_ref
from ..models import ClaimInput
from ..packet import render_packet

router = APIRouter(tags=["packet"])


@router.post("/packet", response_class=Response)
def packet(
    body: ClaimInput,
    svc: ServicesDep,
    engine: EnginePref = "auto",
    persona_id: Annotated[str | None, Query(pattern=r"^[a-z0-9][a-z0-9\-]{0,39}$", description="labels a demo packet as fictional")] = None,
) -> Response:
    """The cited packet PDF for a claim, rendered and returned. Nothing is kept on the server."""
    output, engine_name, payload = svc.claims.evaluate(body, engine)
    view = svc.claims.view(payload, output, engine_name, persona_id)
    version = svc.law.version_for(view["jurisdiction"]) if svc.law else None
    view["law_version"] = version_ref(version)
    data = render_packet(view, svc.rules.get(view["jurisdiction"]) or {}, svc.settings.forms_dir, svc.clock())
    headers = {"Content-Disposition": 'inline; filename="tend-packet.pdf"', ENGINE_HEADER: engine_name}
    if version:
        headers[LAW_VERSION_HEADER] = version["name"]
    return Response(data, media_type="application/pdf", headers=headers)
