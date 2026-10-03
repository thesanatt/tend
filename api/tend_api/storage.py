from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Protocol

from .money import canonical_json, sha256_hex

GENESIS_HASH = "0" * 64


class Repository(Protocol):
    """Storage the API needs. SQLite today; a Postgres (Neon) class can implement the same methods."""

    def secret(self) -> bytes: ...

    def save_scan(self, scan: dict[str, Any], evidence: list[dict[str, Any]]) -> None: ...
    def add_evidence(self, scan_id: str, evidence: list[dict[str, Any]]) -> None: ...
    def get_scan(self, scan_id: str) -> dict[str, Any] | None: ...
    def evidence(self, scan_id: str) -> dict[str, dict[str, Any]]: ...

    def save_claim(self, claim: dict[str, Any]) -> None: ...
    def get_claim(self, claim_id: str) -> dict[str, Any] | None: ...

    def insert_action(self, action: dict[str, Any]) -> None: ...
    def get_action(self, action_id: str) -> dict[str, Any] | None: ...
    def count_failed_attempt(self, action_id: str, lock_at: int) -> int: ...
    def transition_action(
        self, action_id: str, from_status: str, to_status: str, fields: dict[str, Any], not_expired_at: str | None = None
    ) -> bool: ...

    def append_audit(self, event: str, action_id: str | None, data: dict[str, Any], ts: str) -> dict[str, Any]: ...
    def audit_rows(self, action_id: str | None = None) -> list[dict[str, Any]]: ...

    def insert_share(self, share: dict[str, Any]) -> None: ...
    def get_share(self, token_hash: str) -> dict[str, Any] | None: ...
    def revoke_share(self, token_hash: str, at: str) -> bool: ...


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scans (
    scan_id TEXT PRIMARY KEY,
    persona_id TEXT,
    customer_id TEXT,
    jurisdiction TEXT NOT NULL,
    fictional INTEGER NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
    scan_id TEXT NOT NULL REFERENCES scans(scan_id),
    item_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (scan_id, item_id)
);
CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    jurisdiction TEXT NOT NULL,
    scan_id TEXT,
    persona_id TEXT,
    fictional INTEGER NOT NULL,
    display_name TEXT,
    engine TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT NOT NULL,
    refused_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    from_account TEXT NOT NULL,
    payee TEXT NOT NULL,
    claim_id TEXT,
    item_id TEXT,
    code_mac TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    dry_run INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    confirmed_at TEXT,
    finished_at TEXT,
    nessie_id TEXT,
    readback_json TEXT,
    error TEXT
);
CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    event TEXT NOT NULL,
    action_id TEXT,
    body TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS shares (
    token_hash TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(claim_id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);
"""


def audit_hash(body: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(body))


def verify_chain(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Recompute every hash from the stored canonical body and check each row points at the one before."""
    prev = GENESIS_HASH
    for row in rows:
        body = row["body"]
        if body.get("prev_hash") != prev or row["prev_hash"] != prev:
            return {"ok": False, "rows": len(rows), "broken_at": row["seq"], "reason": "prev_hash does not match the previous row"}
        if audit_hash(body) != row["hash"]:
            return {"ok": False, "rows": len(rows), "broken_at": row["seq"], "reason": "hash does not match the row body"}
        prev = row["hash"]
    return {"ok": True, "rows": len(rows), "head": prev}


class SQLiteRepository:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            if path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def _one(self, sql: str, args: tuple[Any, ...]) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, args).fetchone()
        return dict(row) if row else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def secret(self) -> bytes:
        with self._tx() as c:
            row = c.execute("SELECT value FROM meta WHERE key = 'secret'").fetchone()
            if row:
                return bytes.fromhex(row["value"])
            value = secrets.token_bytes(32)
            c.execute("INSERT INTO meta (key, value) VALUES ('secret', ?)", (value.hex(),))
            return value

    # scans and the evidence a claim line must point to

    def save_scan(self, scan: dict[str, Any], evidence: list[dict[str, Any]]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO scans (scan_id, persona_id, customer_id, jurisdiction, fictional, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    scan["scan_id"],
                    scan.get("persona_id"),
                    scan.get("customer_id"),
                    scan["jurisdiction"],
                    int(scan["fictional"]),
                    scan.get("display_name"),
                    scan["created_at"],
                ),
            )
            self._insert_evidence(c, scan["scan_id"], evidence)

    def add_evidence(self, scan_id: str, evidence: list[dict[str, Any]]) -> None:
        with self._tx() as c:
            self._insert_evidence(c, scan_id, evidence)

    @staticmethod
    def _insert_evidence(c: sqlite3.Connection, scan_id: str, evidence: list[dict[str, Any]]) -> None:
        c.executemany(
            "INSERT OR REPLACE INTO evidence (scan_id, item_id, amount_cents, date, source) VALUES (?, ?, ?, ?, ?)",
            [(scan_id, e["item_id"], e["amount_cents"], e["date"], e["source"]) for e in evidence],
        )

    def get_scan(self, scan_id: str) -> dict[str, Any] | None:
        scan = self._one("SELECT * FROM scans WHERE scan_id = ?", (scan_id,))
        if scan:
            scan["fictional"] = bool(scan["fictional"])
        return scan

    def evidence(self, scan_id: str) -> dict[str, dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM evidence WHERE scan_id = ?", (scan_id,)).fetchall()
        return {r["item_id"]: dict(r) for r in rows}

    # claims

    def save_claim(self, claim: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO claims (claim_id, jurisdiction, scan_id, persona_id, fictional, display_name, engine, input_json, output_json, refused_json, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    claim["claim_id"],
                    claim["jurisdiction"],
                    claim.get("scan_id"),
                    claim.get("persona_id"),
                    int(claim["fictional"]),
                    claim.get("display_name"),
                    claim["engine"],
                    json.dumps(claim["input"]),
                    json.dumps(claim["output"]),
                    json.dumps(claim["refused"]),
                    claim["created_at"],
                ),
            )

    def get_claim(self, claim_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM claims WHERE claim_id = ?", (claim_id,))
        if row is None:
            return None
        return {
            "claim_id": row["claim_id"],
            "jurisdiction": row["jurisdiction"],
            "scan_id": row["scan_id"],
            "persona_id": row["persona_id"],
            "fictional": bool(row["fictional"]),
            "display_name": row["display_name"],
            "engine": row["engine"],
            "input": json.loads(row["input_json"]),
            "output": json.loads(row["output_json"]),
            "refused": json.loads(row["refused_json"]),
            "created_at": row["created_at"],
        }

    # actions: every state change is a compare-and-set on status

    def insert_action(self, action: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO actions (action_id, status, amount_cents, from_account, payee, claim_id, item_id, code_mac, dry_run, created_at, expires_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    action["action_id"],
                    action["status"],
                    action["amount_cents"],
                    action["from_account"],
                    action["payee"],
                    action.get("claim_id"),
                    action.get("item_id"),
                    action["code_mac"],
                    int(action["dry_run"]),
                    action["created_at"],
                    action["expires_at"],
                ),
            )

    def get_action(self, action_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM actions WHERE action_id = ?", (action_id,))
        if row:
            row["dry_run"] = bool(row["dry_run"])
            row["readback"] = json.loads(row.pop("readback_json")) if row.get("readback_json") else None
        return row

    def count_failed_attempt(self, action_id: str, lock_at: int) -> int:
        with self._tx() as c:
            c.execute("UPDATE actions SET attempts = attempts + 1 WHERE action_id = ? AND status = 'proposed'", (action_id,))
            attempts = c.execute("SELECT attempts FROM actions WHERE action_id = ?", (action_id,)).fetchone()["attempts"]
            if attempts >= lock_at:
                c.execute("UPDATE actions SET status = 'locked' WHERE action_id = ? AND status = 'proposed'", (action_id,))
            return attempts

    def transition_action(
        self, action_id: str, from_status: str, to_status: str, fields: dict[str, Any], not_expired_at: str | None = None
    ) -> bool:
        allowed = {"confirmed_at", "finished_at", "nessie_id", "readback", "error"}
        if set(fields) - allowed:
            raise ValueError(f"cannot set {sorted(set(fields) - allowed)} on an action")
        cols = ["status = ?"]
        args: list[Any] = [to_status]
        for key, value in fields.items():
            if key == "readback":
                cols.append("readback_json = ?")
                args.append(json.dumps(value))
            else:
                cols.append(f"{key} = ?")
                args.append(value)
        sql = f"UPDATE actions SET {', '.join(cols)} WHERE action_id = ? AND status = ?"
        args += [action_id, from_status]
        if not_expired_at is not None:
            sql += " AND expires_at > ?"
            args.append(not_expired_at)
        with self._tx() as c:
            return c.execute(sql, tuple(args)).rowcount == 1

    # audit: append-only, each row's hash covers the previous row's hash

    def append_audit(self, event: str, action_id: str | None, data: dict[str, Any], ts: str) -> dict[str, Any]:
        with self._tx() as c:
            last = c.execute("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").fetchone()
            seq = (last["seq"] + 1) if last else 1
            prev = last["hash"] if last else GENESIS_HASH
            body = {"seq": seq, "ts": ts, "event": event, "action_id": action_id, "data": data, "prev_hash": prev}
            encoded = canonical_json(body)
            digest = sha256_hex(encoded)
            c.execute(
                "INSERT INTO audit (seq, ts, event, action_id, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (seq, ts, event, action_id, encoded.decode("utf-8"), prev, digest),
            )
            return {"seq": seq, "ts": ts, "event": event, "action_id": action_id, "data": data, "prev_hash": prev, "hash": digest}

    def audit_rows(self, action_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            if action_id is None:
                rows = self._conn.execute("SELECT * FROM audit ORDER BY seq").fetchall()
            else:
                rows = self._conn.execute("SELECT * FROM audit WHERE action_id = ? ORDER BY seq", (action_id,)).fetchall()
        out = []
        for r in rows:
            body = json.loads(r["body"])
            out.append(
                {
                    "seq": r["seq"],
                    "ts": r["ts"],
                    "event": r["event"],
                    "action_id": r["action_id"],
                    "data": body.get("data"),
                    "prev_hash": r["prev_hash"],
                    "hash": r["hash"],
                    "body": body,
                }
            )
        return out

    # shares: only the sha256 of a token is stored

    def insert_share(self, share: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO shares (token_hash, claim_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (share["token_hash"], share["claim_id"], share["created_at"], share["expires_at"]),
            )

    def get_share(self, token_hash: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM shares WHERE token_hash = ?", (token_hash,))

    def revoke_share(self, token_hash: str, at: str) -> bool:
        with self._tx() as c:
            return c.execute("UPDATE shares SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", (at, token_hash)).rowcount == 1
