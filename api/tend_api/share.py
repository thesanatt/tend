from __future__ import annotations

import datetime as dt
import hashlib
import secrets
from typing import Any

from .clock import Clock, iso, parse_iso
from .errors import TendError
from .storage import Repository


class ShareError(TendError):
    pass


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class ShareService:
    """Read-only advocate links. Only a hash of each token is stored, so the database alone cannot open a claim."""

    def __init__(self, repo: Repository, clock: Clock, public_url: str = ""):
        self.repo = repo
        self.clock = clock
        self.public_url = public_url

    def create(self, claim_id: str, ttl_hours: int) -> dict[str, Any]:
        if self.repo.get_claim(claim_id) is None:
            raise ShareError(f"claim {claim_id} not found", 404)
        token = secrets.token_urlsafe(24)
        now = self.clock()
        expires_at = iso(now + dt.timedelta(hours=ttl_hours))
        self.repo.insert_share({"token_hash": token_hash(token), "claim_id": claim_id, "created_at": iso(now), "expires_at": expires_at})
        return {
            "token": token,
            "path": f"/share/{token}",
            "url": f"{self.public_url}/share/{token}" if self.public_url else None,
            "api_path": f"/api/share/{token}",
            "expires_at": expires_at,
            "read_only": True,
        }

    def resolve(self, token: str) -> dict[str, Any]:
        share = self.repo.get_share(token_hash(token))
        if share is None:
            raise ShareError("This link is not valid.", 404)
        if share["revoked_at"]:
            raise ShareError("This link was turned off by the person who shared it.", 410)
        if parse_iso(share["expires_at"]) <= self.clock():
            raise ShareError("This link has expired.", 410)
        return share

    def revoke(self, token: str) -> None:
        if not self.repo.revoke_share(token_hash(token), iso(self.clock())):
            raise ShareError("This link is not valid or was already turned off.", 404)
