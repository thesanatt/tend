from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import ServicesDep, TokenPath
from ..models import ShareRequest
from ..packet import render_packet, still_needed

router = APIRouter(tags=["share"])


@router.post("/share")
def create_share(body: ShareRequest, svc: ServicesDep) -> dict[str, Any]:
    return svc.shares.create(body.claim_id, body.ttl_hours)


@router.get("/share/{token}")
def read_share(token: TokenPath, svc: ServicesDep) -> dict[str, Any]:
    share = svc.shares.resolve(token)
    view = svc.claims.view(svc.claims.get(share["claim_id"]))
    rules_doc = svc.rules.get(view["jurisdiction"]) or {}
    return {**view, "read_only": True, "expires_at": share["expires_at"], "needed": still_needed(view, rules_doc)}


@router.get("/share/{token}/packet.pdf", response_class=Response)
def shared_packet(token: TokenPath, svc: ServicesDep) -> Response:
    share = svc.shares.resolve(token)
    view = svc.claims.view(svc.claims.get(share["claim_id"]))
    data = render_packet(view, svc.rules.get(view["jurisdiction"]) or {}, svc.settings.forms_dir, svc.clock())
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="tend-shared-packet.pdf"'})


@router.delete("/share/{token}", status_code=204, response_class=Response)
def revoke_share(token: TokenPath, svc: ServicesDep) -> Response:
    svc.shares.revoke(token)
    return Response(status_code=204)
