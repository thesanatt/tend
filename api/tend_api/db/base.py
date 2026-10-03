"""What the API stores, behind one protocol: Neon Postgres in production, SQLite offline.

The server holds three things (docs/PRIVACY.md): the public law corpus, the ciphertext of shared
packets, and an append-only, hash-chained log of confirmed payments. A payment waiting for its
confirm code is the only other state, and it lasts ten minutes. Claims, scans, and plaintext
shares are never stored.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal, Protocol

from ..money import canonical_json, sha256_hex

GENESIS_HASH = "0" * 64
MIGRATIONS = Path(__file__).parent / "migrations"
MAX_SHARE_BYTES = 2 * 1024 * 1024
ACTION_FIELDS = frozenset({"confirmed_at", "finished_at", "withdrawal_id", "readback", "error_kind", "payee"})
FINAL_STATUSES = frozenset({"done", "unverified", "failed", "expired", "locked"})

ShareState = Literal["ok", "missing", "expired", "opened"]


class MigrationError(RuntimeError):
    """A migration that already ran has changed on disk, or the database is ahead of this code."""


class Repository(Protocol):
    backend: str

    def close(self) -> None: ...
    def migrate(self) -> list[str]: ...
    def ping(self) -> dict[str, Any]: ...
    def secret(self) -> bytes: ...

    # the public corpus
    def load_corpus(self, bundles: Iterable[Any], *, force: bool = False) -> dict[str, Any]: ...
    def corpus_counts(self) -> dict[str, int]: ...
    def corpus_hashes(self) -> dict[str, dict[str, str | None]]: ...
    def jurisdiction(self, st: str) -> dict[str, Any] | None: ...
    def search_rules(self, terms: list[str], st: str | None, limit: int) -> list[dict[str, Any]]: ...
    def rules_where(self, st: str, categories: Iterable[str], expenses: Iterable[str]) -> list[dict[str, Any]]: ...
    def source(self, st: str, source_id: str) -> dict[str, Any] | None: ...
    def law_images(self, st: str) -> list[dict[str, Any]]: ...

    # sealed shares
    def insert_share(self, share: dict[str, Any]) -> None: ...
    def open_share(self, share_id: str, now: str) -> tuple[ShareState, dict[str, Any] | None]: ...
    def delete_share(self, share_id: str) -> bool: ...

    # payments
    def insert_action(self, action: dict[str, Any]) -> None: ...
    def get_action(self, action_id: str) -> dict[str, Any] | None: ...
    def count_failed_attempt(self, action_id: str, lock_at: int) -> int: ...
    def transition_action(
        self, action_id: str, from_status: str, to_status: str, fields: dict[str, Any], not_expired_at: str | None = None
    ) -> bool: ...
    def append_audit(self, event: str, action_id: str, data: dict[str, Any], ts: str) -> dict[str, Any]: ...
    def audit_rows(self, action_id: str | None = None) -> list[dict[str, Any]]: ...

    # housekeeping: expired shares lose their rows, expired proposals lose their payee
    def sweep(self, now: str) -> dict[str, int]: ...


def migration_files(dialect: str) -> list[tuple[str, str, str]]:
    """(version, sql, sha256) for each migration of one dialect, in order."""
    out = []
    for path in sorted((MIGRATIONS / dialect).glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        out.append((path.stem, text, hashlib.sha256(text.encode("utf-8")).hexdigest()))
    return out


def check_applied(applied: dict[str, str], files: list[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    """The migrations still to run. Refuses when a file that already ran was edited, or the database knows more."""
    known = {version for version, _, _ in files}
    unknown = sorted(set(applied) - known)
    if unknown:
        raise MigrationError(f"the database has migrations this code does not know: {', '.join(unknown)}")
    for version, _, digest in files:
        if version in applied and applied[version] != digest:
            raise MigrationError(f"migration {version} changed after it ran; add a new migration instead of editing it")
    return [f for f in files if f[0] not in applied]


def audit_body(seq: int, ts: str, event: str, action_id: str, data: dict[str, Any], prev_hash: str) -> tuple[str, str]:
    """The canonical body of one audit row and its sha256. The hash covers the previous row's hash."""
    body = {"seq": seq, "ts": ts, "event": event, "action_id": action_id, "data": data, "prev_hash": prev_hash}
    encoded = canonical_json(body)
    return encoded.decode("utf-8"), sha256_hex(encoded)


def audit_hash(body: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(body))


def verify_chain(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Recompute every hash from the stored canonical body and check each row names the one before."""
    prev = GENESIS_HASH
    for row in rows:
        body = row["body"]
        if body.get("prev_hash") != prev or row["prev_hash"] != prev:
            return {"ok": False, "rows": len(rows), "broken_at": row["seq"], "reason": "prev_hash does not match the previous row"}
        if audit_hash(body) != row["hash"]:
            return {"ok": False, "rows": len(rows), "broken_at": row["seq"], "reason": "hash does not match the row body"}
        prev = row["hash"]
    return {"ok": True, "rows": len(rows), "head": prev}
