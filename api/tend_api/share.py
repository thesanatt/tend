"""End-to-end encrypted share links (docs/PRIVACY.md, "A packet you choose to share").

The browser seals the packet with a fresh AES-256-GCM key and sends only the ciphertext and IV.
The key stays in the link's fragment, which browsers never send to a server, so the server holds
nothing it can read. Links expire, can be deleted, and can be set to open once: the first read of
an open-once link takes the ciphertext with it.
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import secrets
from typing import Any

from .clock import Clock, iso
from .db import MAX_SHARE_BYTES, Repository
from .errors import TendError
from .models import MAX_SHARE_B64, ShareCreate
from .sweep import SweepSchedule

ALG = "AES-256-GCM"
# web/lib/share sends base64url without padding and reads the reply with a strict base64url decoder,
# which refuses "+", "/", and "=". The server answers in the same alphabet.
ENCODING = "base64url"
IV_BYTES = (12, 16)
TOO_LARGE = "This packet is too large to share. The limit is 2 MB."


class ShareError(TendError):
    pass


def b64decode_any(text: str, what: str = "ciphertext") -> bytes:
    """Standard or URL-safe base64, padded or not."""
    clean = text.strip().replace("-", "+").replace("_", "/")
    try:
        return base64.b64decode(clean + "=" * (-len(clean) % 4), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ShareError(f"The {what} is not valid base64.", 422) from exc


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


class ShareService:
    def __init__(self, repo: Repository, clock: Clock, public_url: str = "", sweeps: SweepSchedule | None = None):
        self.repo = repo
        self.clock = clock
        self.public_url = public_url
        self.sweeps = sweeps or SweepSchedule()

    def seal(self, req: ShareCreate) -> dict[str, Any]:
        # 413, not 422, so the browser can say the packet is too large rather than that the server refused it.
        if len(req.ciphertext.strip()) > MAX_SHARE_B64:
            raise ShareError(TOO_LARGE, 413)
        ciphertext = b64decode_any(req.ciphertext)
        iv = b64decode_any(req.iv, "IV")
        if len(ciphertext) > MAX_SHARE_BYTES:
            raise ShareError(TOO_LARGE, 413)
        if len(iv) not in IV_BYTES:
            raise ShareError("The IV must be 12 bytes (AES-GCM).", 422)
        if len(ciphertext) < 17:
            raise ShareError("That is too short to be an encrypted packet.", 422)
        now = self.clock()
        self.repo.sweep(iso(now))
        share_id = secrets.token_urlsafe(16)  # 128 random bits; the link's only locator
        expires = now + dt.timedelta(hours=req.expires_hours)
        expires_at = iso(expires)
        self.repo.insert_share(
            {"id": share_id, "ciphertext": ciphertext, "iv": iv, "once": req.once, "created_at": iso(now), "expires_at": expires_at}
        )
        self.sweeps.add(expires)
        return {
            "id": share_id,
            "created_at": iso(now),
            "expires_at": expires_at,
            "once": req.once,
            "size_bytes": len(ciphertext),
            "api_path": f"/api/shares/{share_id}",
            "path": f"/share/{share_id}",
            "url": f"{self.public_url}/share/{share_id}" if self.public_url else None,
        }

    def open(self, share_id: str) -> dict[str, Any]:
        state, row = self.repo.open_share(share_id, iso(self.clock()))
        if state == "missing":
            raise ShareError("This link is not valid. It may have been deleted.", 404)
        if state == "expired":
            raise ShareError("This link has expired.", 410)
        if state == "opened" or row is None:
            raise ShareError("This link could be opened once, and it has been.", 410)
        return {
            "id": share_id,
            "alg": ALG,
            "encoding": ENCODING,
            "ciphertext": b64url(bytes(row["ciphertext"])),
            "iv": b64url(bytes(row["iv"])),
            "created_at": row["created_at"],
            "expires_at": row["expires_at"],
            "once": bool(row["once"]),
        }

    def delete(self, share_id: str) -> None:
        if not self.repo.delete_share(share_id):
            raise ShareError("This link is not valid or was already deleted.", 404)
