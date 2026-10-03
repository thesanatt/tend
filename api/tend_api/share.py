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
    """Expiring, revocable, read-only links. Only a hash of each token is stored.

    A sealed share holds ciphertext made in the browser (docs/PRIVACY.md); its key travels in the
    link's fragment, so the server cannot read it. A claim share serves a claim the server holds.
    """

    def __init__(self, repo: Repository, clock: Clock, public_url: str = ""):
        self.repo = repo
        self.clock = clock
        self.public_url = public_url

    def _link(self, token: str, expires_at: str, **extra: Any) -> dict[str, Any]:
        return {
            "token": token,
            "path": f"/share/{token}",
            "url": f"{self.public_url}/share/{token}" if self.public_url else None,
            "api_path": f"/api/share/{token}",
            "expires_at": expires_at,
            "read_only": True,
            **extra,
        }

    def create(self, claim_id: str, ttl_hours: int) -> dict[str, Any]:
        if self.repo.get_claim(claim_id) is None:
            raise ShareError(f"claim {claim_id} not found", 404)
        token = secrets.token_urlsafe(24)
        now = self.clock()
        expires_at = iso(now + dt.timedelta(hours=ttl_hours))
        self.repo.insert_share({"token_hash": token_hash(token), "claim_id": claim_id, "created_at": iso(now), "expires_at": expires_at})
        return self._link(token, expires_at, sealed=False)

    def create_sealed(self, ciphertext: str, nonce: str, alg: str, ttl_hours: int, open_once: bool) -> dict[str, Any]:
        token = secrets.token_urlsafe(24)
        now = self.clock()
        expires_at = iso(now + dt.timedelta(hours=ttl_hours))
        self.repo.insert_sealed_share(
            {
                "token_hash": token_hash(token),
                "ciphertext": ciphertext,
                "nonce": nonce,
                "alg": alg,
                "open_once": open_once,
                "created_at": iso(now),
                "expires_at": expires_at,
            }
        )
        return self._link(token, expires_at, sealed=True, open_once=open_once)

    def _check_live(self, share: dict[str, Any]) -> None:
        if share["revoked_at"]:
            raise ShareError("This link was turned off by the person who shared it.", 410)
        if parse_iso(share["expires_at"]) <= self.clock():
            raise ShareError("This link has expired.", 410)

    def resolve(self, token: str, consume: bool = True) -> dict[str, Any]:
        """The share behind a token. Opening a sealed open-once share uses it up."""
        digest = token_hash(token)
        sealed = self.repo.get_sealed_share(digest)
        if sealed is not None:
            self._check_live(sealed)
            if sealed["open_once"]:
                if sealed["opened_at"] or (consume and not self.repo.mark_sealed_opened(digest, iso(self.clock()))):
                    raise ShareError("This link could be opened once, and it has been.", 410)
            return {**sealed, "kind": "sealed"}
        share = self.repo.get_share(digest)
        if share is None:
            raise ShareError("This link is not valid.", 404)
        self._check_live(share)
        return {**share, "kind": "claim"}

    def revoke(self, token: str) -> None:
        if not self.repo.revoke_share(token_hash(token), iso(self.clock())):
            raise ShareError("This link is not valid or was already turned off.", 404)
