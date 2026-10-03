from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from ..deps import ServicesDep, SharePath
from ..models import ShareCreate

router = APIRouter(prefix="/shares", tags=["shares"])


@router.post("", status_code=201)
def seal(body: ShareCreate, svc: ServicesDep) -> dict[str, Any]:
    """Store a packet sealed in the browser: ciphertext and IV only. The key never reaches the server."""
    return svc.shares.seal(body)


@router.get("/{share_id}")
def open_share(share_id: SharePath, svc: ServicesDep) -> dict[str, Any]:
    """The ciphertext and IV. An open-once share is gone after this read."""
    return svc.shares.open(share_id)


@router.delete("/{share_id}", status_code=204, response_class=Response)
def delete_share(share_id: SharePath, svc: ServicesDep) -> Response:
    svc.shares.delete(share_id)
    return Response(status_code=204)
