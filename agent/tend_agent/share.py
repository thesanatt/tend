"""End-to-end encrypted share links in the exact format the Tend web app opens (web/lib/share).

A fresh 256-bit key and a 12-byte IV seal {"format": "tend.share/1", "packet": SharedPacket} with AES-256-GCM
(additional data "tend.share.v1", 128-bit tag). Tend's server gets the ciphertext and the IV only. The key goes in
the link's fragment (/share#<id>.<key>), which browsers never send to a server. The agent keeps no copy of the key.
"""

from __future__ import annotations

import base64
import json
import re
import secrets
from typing import Any

FORMAT = "tend.share/1"
AAD = b"tend.share.v1"
KEY_BYTES = 32
IV_BYTES = 12
TAG_BYTES = 16
VIEWER_PATH = "/share"
ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUSES = {"out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible"}


class ShareFormatError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def from_b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def aes_gcm_encrypt(key: bytes, iv: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """Ciphertext followed by the 16-byte tag, as WebCrypto's AES-GCM produces and expects."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        from Crypto.Cipher import AES

        cipher = AES.new(key, AES.MODE_GCM, nonce=iv, mac_len=TAG_BYTES)
        cipher.update(aad)
        body, tag = cipher.encrypt_and_digest(plaintext)
        return body + tag
    return AESGCM(key).encrypt(iv, plaintext, aad)


def aes_gcm_decrypt(key: bytes, iv: bytes, sealed: bytes, aad: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        from Crypto.Cipher import AES

        cipher = AES.new(key, AES.MODE_GCM, nonce=iv, mac_len=TAG_BYTES)
        cipher.update(aad)
        return cipher.decrypt_and_verify(sealed[:-TAG_BYTES], sealed[-TAG_BYTES:])
    return AESGCM(key).decrypt(iv, sealed, aad)


def _cents(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2**53 - 1


def _strings(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def check_packet(p: Any) -> None:
    """The checks the web viewer runs before it shows a shared claim (web/lib/share isPacket). A packet that would
    fail there is refused here, before anything is sealed."""

    def need(ok: bool, what: str) -> None:
        if not ok:
            raise ShareFormatError(what)

    need(isinstance(p, dict), "packet")
    st = p.get("st")
    need(isinstance(st, str) and re.fullmatch(r"[A-Z]{2}", st) is not None, "st")
    need(isinstance(p.get("created_at"), str), "created_at")
    # The viewer refuses null where it expects a missing key, so optional fields are left out, never null.
    need("notes" not in p or (isinstance(p["notes"], str) and len(p["notes"]) <= 4000), "notes")
    inp, out = p.get("input"), p.get("output")
    need(isinstance(inp, dict) and isinstance(out, dict), "input and output")
    need(str(inp.get("jurisdiction", "")).upper() == st and str(out.get("jurisdiction", "")).upper() == st, "jurisdiction")
    ctx = inp.get("context") or {}
    need(isinstance(ctx.get("incident_date"), str) and DAY.match(ctx["incident_date"]) is not None, "incident_date")
    need(isinstance(ctx.get("as_of_date"), str) and DAY.match(ctx["as_of_date"]) is not None, "as_of_date")
    need(ctx.get("police_report") in ("yes", "no", "unknown") and isinstance(ctx.get("forensic_exam"), bool), "context")
    items = inp.get("items")
    need(isinstance(items, list), "items")
    for i in items:
        need(
            isinstance(i, dict)
            and isinstance(i.get("item_id"), str)
            and isinstance(i.get("date"), str)
            and DAY.match(i["date"]) is not None
            and _cents(i.get("amount_cents"))
            and isinstance(i.get("expense"), str)
            and ("description" not in i or isinstance(i["description"], str))
            and ("insurance_paid_cents" not in i or _cents(i["insurance_paid_cents"]))
            and ("units" not in i or _cents(i["units"])),
            "item",
        )
    ids = {i["item_id"] for i in items}
    lines = out.get("lines")
    need(isinstance(lines, list), "lines")
    for ln in lines:
        need(
            isinstance(ln, dict)
            and ln.get("item_id") in ids
            and isinstance(ln.get("expense"), str)
            and ln.get("status") in STATUSES
            and _cents(ln.get("requested_cents"))
            and _cents(ln.get("allowed_cents"))
            and _strings(ln.get("rule_ids"))
            and (ln.get("cap_rule_id") is None or isinstance(ln["cap_rule_id"], str))
            and _strings(ln.get("flags")),
            "line",
        )
    totals = out.get("totals") or {}
    need(all(_cents(totals.get(k)) for k in ("allowed_cents", "held_cents", "requested_cents")), "totals")
    checks = out.get("checks") or {}
    for name in ("deadline", "minimum_loss", "reporting"):
        c = checks.get(name)
        need(isinstance(c, dict) and isinstance(c.get("status"), str) and _strings(c.get("rule_ids")), f"checks.{name}")
    need(out.get("info_rule_ids") is None or _strings(out["info_rule_ids"]), "info_rule_ids")


def seal(packet: dict[str, Any], *, rand: Any = secrets.token_bytes) -> tuple[str, str, str]:
    """(ciphertext, iv, key), each base64url without padding. The caller sends the first two and puts the key
    only in the link."""
    check_packet(packet)
    key, iv = rand(KEY_BYTES), rand(IV_BYTES)
    plain = json.dumps({"format": FORMAT, "packet": packet}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b64url(aes_gcm_encrypt(key, iv, plain, AAD)), b64url(iv), b64url(key)


def open_sealed(ciphertext: str, iv: str, key: str) -> dict[str, Any]:
    """The reverse of seal, as the advocate's browser does it. Used by tests and by the rehearsal's own check."""
    try:
        doc = json.loads(aes_gcm_decrypt(from_b64url(key), from_b64url(iv), from_b64url(ciphertext), AAD))
    except Exception as exc:  # a wrong key or changed data fails the tag check, whichever library is installed
        raise ShareFormatError("this link's key does not open this ciphertext") from exc
    if doc.get("format") != FORMAT:
        raise ShareFormatError("format")
    check_packet(doc.get("packet"))
    return doc["packet"]


def share_link(origin: str, share_id: str, key: str) -> str:
    if not ID.match(share_id) or len(key) != 43:
        raise ShareFormatError("link")
    return f"{origin.rstrip('/')}{VIEWER_PATH}#{share_id}.{key}"
