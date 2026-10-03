from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import ServicesDep, TokenPath
from ..models import ShareRequest
from ..packet import render_packet, still_needed
from ..share import ShareError

router = APIRouter(tags=["share"])
COMPARED = ("lines", "totals", "checks", "info_rule_ids")


@router.post("/share")
def create_share(body: ShareRequest, svc: ServicesDep) -> dict[str, Any]:
    if body.ciphertext is not None:
        return svc.shares.create_sealed(body.ciphertext, body.nonce or "", body.alg, body.ttl_hours, body.open_once)
    if body.claim_id is not None:
        return svc.shares.create(body.claim_id, body.ttl_hours)
    # A claim computed on the device: the server runs it again and shares its own result, never the device's.
    result, engine = svc.claims.evaluate(body.input)
    matches = None if body.output is None else all(result.get(k) == body.output.get(k) for k in COMPARED)
    link = svc.shares.create(result["claim_id"], body.ttl_hours)
    return {**link, "claim_id": result["claim_id"], "engine": engine, "matches_client": matches}


@router.get("/share/{token}")
def read_share(token: TokenPath, svc: ServicesDep) -> dict[str, Any]:
    share = svc.shares.resolve(token)
    if share["kind"] == "sealed":
        return {
            "token": token,
            "sealed": True,
            "read_only": True,
            "alg": share["alg"],
            "nonce": share["nonce"],
            "ciphertext": share["ciphertext"],
            "open_once": share["open_once"],
            "created_at": share["created_at"],
            "expires_at": share["expires_at"],
        }
    claim = svc.claims.get(share["claim_id"])
    view = svc.claims.view(claim)
    rules_doc = svc.rules.get(view["jurisdiction"]) or {}
    return {
        **view,
        "token": token,
        "sealed": False,
        "read_only": True,
        "created_at": share["created_at"],
        "expires_at": share["expires_at"],
        "claim_created_at": claim["created_at"],
        "input": claim["input"],
        "output": claim["output"],
        "needed": still_needed(view, rules_doc),
    }


@router.get("/share/{token}/packet.pdf", response_class=Response)
def shared_packet(token: TokenPath, svc: ServicesDep) -> Response:
    share = svc.shares.resolve(token, consume=False)
    if share["kind"] == "sealed":
        raise ShareError("This share is encrypted. Open the link in Tend to read the packet inside it.", 409)
    view = svc.claims.view(svc.claims.get(share["claim_id"]))
    data = render_packet(view, svc.rules.get(view["jurisdiction"]) or {}, svc.settings.forms_dir, svc.clock())
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="tend-shared-packet.pdf"'})


@router.delete("/share/{token}", status_code=204, response_class=Response)
def revoke_share(token: TokenPath, svc: ServicesDep) -> Response:
    svc.shares.revoke(token)
    return Response(status_code=204)
