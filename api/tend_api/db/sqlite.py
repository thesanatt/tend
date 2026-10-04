"""SQLite behind the Repository protocol: offline runs and the test suite. Same tables as Neon."""

from __future__ import annotations

import datetime as dt
import json
import secrets
import sqlite3
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..clock import iso, parse_iso, utcnow
from .base import (
    ACTION_FIELDS,
    FINAL_STATUSES,
    GENESIS_HASH,
    MARK_CLOSE,
    MARK_OPEN,
    VERSION_COLUMNS,
    VERSION_KEYS,
    MigrationError,
    ShareState,
    audit_body,
    check_applied,
    fts5_query,
    marks,
    migration_files,
)
from .corpus import CATEGORIES, CorpusBundle, image_rows, jurisdiction_row, rule_rows, source_rows

# Tables from the first version of the API, which kept claims, scans, and plaintext shares.
WAVE1_TABLES = ("agent_sessions", "agent_links", "shares", "sealed_shares", "claims", "evidence", "scans", "actions", "audit", "meta")
RULE_COLUMNS = (
    "r.st, r.id, r.ord, r.category, r.expense, r.params, r.summary, r.quote, r.pinpoint, r.source_id, r.fragment_url, r.ir, r.ir_kind"
)
FINISHED_KEEP = dt.timedelta(days=1)


class SQLiteRepository:
    backend = "sqlite"

    def __init__(self, path: str, *, migrate: bool = True):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            if path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
        if migrate:
            self.migrate()

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

    def _all(self, sql: str, args: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, args).fetchall()]

    def _one(self, sql: str, args: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        rows = self._all(sql, args)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # schema

    def migrate(self) -> list[str]:
        with self._lock:
            tables = {r["name"] for r in self._conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            if "schema_migrations" not in tables and "claims" in tables:
                self._retire_wave1(tables)
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)"
            )
            applied = {r["version"]: r["sha256"] for r in self._conn.execute("SELECT version, sha256 FROM schema_migrations")}
            pending = check_applied(applied, migration_files("sqlite"))
            for version, text, digest in pending:
                script = (
                    f"BEGIN IMMEDIATE;\n{text}\n"
                    f"INSERT INTO schema_migrations (version, sha256, applied_at) VALUES ('{version}', '{digest}', '{iso(utcnow())}');\n"
                    "COMMIT;"
                )
                try:
                    self._conn.executescript(script)
                except sqlite3.Error as exc:
                    if self._conn.in_transaction:
                        self._conn.execute("ROLLBACK")
                    raise MigrationError(f"migration {version} failed: {exc}") from exc
            return [v for v, _, _ in pending]

    def _retire_wave1(self, tables: set[str]) -> None:
        """A database from the first API kept claims and plaintext shares. Drop them; nothing reads them now."""
        self._conn.execute("PRAGMA foreign_keys=OFF")
        try:
            for name in WAVE1_TABLES:
                if name in tables:
                    self._conn.execute(f"DROP TABLE {name}")
        finally:
            self._conn.execute("PRAGMA foreign_keys=ON")

    def ping(self) -> dict[str, Any]:
        with self._lock:
            self._conn.execute("SELECT 1").fetchone()
        return {"backend": self.backend, "ok": True}

    def secret(self) -> bytes:
        with self._tx() as c:
            row = c.execute("SELECT value FROM meta WHERE key = 'secret'").fetchone()
            if row:
                return bytes.fromhex(row["value"])
            value = secrets.token_bytes(32)
            c.execute("INSERT INTO meta (key, value) VALUES ('secret', ?)", (value.hex(),))
            return value

    # the public corpus

    def load_corpus(self, bundles: Iterable[CorpusBundle], *, force: bool = False) -> dict[str, Any]:
        now = iso(utcnow())
        loaded, unchanged = [], []
        with self._tx() as c:
            c.executemany(
                "INSERT INTO categories (name, meaning, decides) VALUES (?, ?, ?)"
                " ON CONFLICT (name) DO UPDATE SET meaning = excluded.meaning, decides = excluded.decides",
                [(name, meaning, int(decides)) for name, (meaning, decides) in CATEGORIES.items()],
            )
            current = {
                r["st"]: (r["verified_sha256"], r["ir_sha256"])
                for r in c.execute("SELECT st, verified_sha256, ir_sha256 FROM jurisdictions")
            }
            for b in bundles:
                if not force and current.get(b.st) == (b.verified_sha256, b.ir_sha256):
                    unchanged.append(b.st)
                else:
                    self._replace(c, b, now)
                    loaded.append(b.st)
                c.executemany(
                    "INSERT INTO law_images (st, image_sha256, engine_version, verified_sha256, ir_sha256, bytes, compiled_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (st, image_sha256) DO NOTHING",
                    [
                        (i["st"], i["image_sha256"], i["engine_version"], i["verified_sha256"], i["ir_sha256"], i["bytes"], now)
                        for i in image_rows(b)
                    ],
                )
        return {"loaded": loaded, "unchanged": unchanged, "counts": self.corpus_counts()}

    @staticmethod
    def _replace(c: sqlite3.Connection, b: CorpusBundle, now: str) -> None:
        j = jurisdiction_row(b)
        c.execute("DELETE FROM rules_fts WHERE st = ?", (b.st,))
        c.execute("DELETE FROM rules WHERE st = ?", (b.st,))
        c.execute("DELETE FROM sources WHERE st = ?", (b.st,))
        c.execute(
            "INSERT INTO jurisdictions (st, name, program, coverage, confidence, verified_sha256, ir_sha256, ir_version,"
            " rule_count, source_count, skipped_count, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT (st) DO UPDATE SET name = excluded.name, program = excluded.program, coverage = excluded.coverage,"
            " confidence = excluded.confidence, verified_sha256 = excluded.verified_sha256, ir_sha256 = excluded.ir_sha256,"
            " ir_version = excluded.ir_version, rule_count = excluded.rule_count, source_count = excluded.source_count,"
            " skipped_count = excluded.skipped_count, loaded_at = excluded.loaded_at",
            (
                j["st"],
                j["name"],
                json.dumps(j["program"]),
                json.dumps(j["coverage"]),
                j["confidence"],
                j["verified_sha256"],
                j["ir_sha256"],
                j["ir_version"],
                j["rule_count"],
                j["source_count"],
                j["skipped_count"],
                now,
            ),
        )
        c.executemany(
            "INSERT INTO sources (st, id, title, url, kind, retrieved_at, raw_path, text_path, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (s["st"], s["id"], s["title"], s["url"], s["kind"], s["retrieved_at"], s["raw_path"], s["text_path"], s["sha256"])
                for s in source_rows(b)
            ],
        )
        rows = rule_rows(b)
        c.executemany(
            "INSERT INTO rules (st, id, ord, category, expense, params, summary, quote, pinpoint, source_id, fragment_url, ir, ir_kind,"
            " skipped_reason, heading) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    r["st"],
                    r["id"],
                    r["ord"],
                    r["category"],
                    r["expense"],
                    json.dumps(r["params"]),
                    r["summary"],
                    r["quote"],
                    r["pinpoint"],
                    r["source_id"],
                    r["fragment_url"],
                    json.dumps(r["ir"]) if r["ir"] is not None else None,
                    r["ir_kind"],
                    r["skipped_reason"],
                    r["heading"],
                )
                for r in rows
            ],
        )
        c.executemany(
            "INSERT INTO rules_fts (rule_id, st, heading, summary, quote, pinpoint) VALUES (?, ?, ?, ?, ?, ?)",
            [(r["id"], r["st"], r["heading"], r["summary"], r["quote"], r["pinpoint"]) for r in rows],
        )

    def corpus_counts(self) -> dict[str, int]:
        return {
            table: self._one(f"SELECT COUNT(*) AS n FROM {table}")["n"]
            for table in ("categories", "jurisdictions", "sources", "rules", "law_images")
        }

    def corpus_hashes(self) -> dict[str, dict[str, str | None]]:
        rows = self._all("SELECT st, verified_sha256, ir_sha256 FROM jurisdictions ORDER BY st")
        return {r["st"]: {"verified_sha256": r["verified_sha256"], "ir_sha256": r["ir_sha256"]} for r in rows}

    def jurisdiction(self, st: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM jurisdictions WHERE st = ?", (st,))
        if row:
            row["program"] = json.loads(row["program"] or "{}")
            row["coverage"] = json.loads(row["coverage"]) if row["coverage"] else None
        return row

    @staticmethod
    def _rule(row: dict[str, Any]) -> dict[str, Any]:
        row["params"] = json.loads(row["params"] or "{}")
        row["ir"] = json.loads(row["ir"]) if row.get("ir") else None
        row["rule_id"] = row["id"]
        return row

    def search_rules(self, terms: list[str], st: str | None, limit: int) -> list[dict[str, Any]]:
        if not terms:
            return []
        match = " OR ".join(f'"{t}"' for t in terms)
        rows = self._all(
            f"SELECT {RULE_COLUMNS}, s.title AS source_title, s.url AS source_url, s.sha256 AS source_sha256,"
            " -bm25(rules_fts, 0.0, 0.0, 10.0, 4.0, 2.0, 1.0) AS score"
            " FROM rules_fts JOIN rules r ON r.id = rules_fts.rule_id JOIN sources s ON s.st = r.st AND s.id = r.source_id"
            " WHERE rules_fts MATCH ? AND (? IS NULL OR r.st = ?) ORDER BY score DESC, r.st, r.ord LIMIT ?",
            (match, st, st, limit),
        )
        return [self._rule(r) for r in rows]

    def rules_where(self, st: str, categories: Iterable[str], expenses: Iterable[str]) -> list[dict[str, Any]]:
        cats, exps = sorted(set(categories)), sorted(set(expenses))
        if not cats and not exps:
            return []
        clauses, args = [], [st]
        if cats:
            clauses.append(f"r.category IN ({','.join('?' * len(cats))})")
            args += cats
        if exps:
            clauses.append(f"r.expense IN ({','.join('?' * len(exps))})")
            args += exps
        rows = self._all(
            f"SELECT {RULE_COLUMNS}, s.title AS source_title, s.url AS source_url, s.sha256 AS source_sha256, 0.0 AS score"
            f" FROM rules r JOIN sources s ON s.st = r.st AND s.id = r.source_id WHERE r.st = ? AND ({' OR '.join(clauses)}) ORDER BY r.ord",
            tuple(args),
        )
        return [self._rule(r) for r in rows]

    def source(self, st: str, source_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM sources WHERE st = ? AND id = ?", (st, source_id))

    def law_images(self, st: str) -> list[dict[str, Any]]:
        return self._all(
            "SELECT st, image_sha256, engine_version, verified_sha256, ir_sha256, bytes, compiled_at FROM law_images WHERE st = ?"
            " ORDER BY compiled_at DESC, image_sha256",
            (st,),
        )

    # quote search and law versions

    def law_search(self, q: str, st: str | None, limit: int) -> list[dict[str, Any]]:
        match = fts5_query(q, "quote")
        if match is None:
            return []
        rows = self._all(
            "SELECT r.st, r.id AS rule_id, r.quote, r.pinpoint, r.source_id, r.fragment_url,"
            " -bm25(rules_fts, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0) AS rank, highlight(rules_fts, 4, ?, ?) AS marked"
            " FROM rules_fts JOIN rules r ON r.id = rules_fts.rule_id"
            " WHERE rules_fts MATCH ? AND (? IS NULL OR r.st = ?) ORDER BY rank DESC, r.st, r.ord LIMIT ?",
            (MARK_OPEN, MARK_CLOSE, match, st, st, limit),
        )
        for r in rows:
            r["rank"] = round(float(r["rank"]), 6)
            r["marks"] = marks(r["quote"], r.pop("marked") or "")
        return rows

    def corpus_rules(self, st: str | None) -> list[dict[str, Any]]:
        rows = self._all(
            f"SELECT {RULE_COLUMNS}, r.skipped_reason, s.title AS source_title, s.url AS source_url, s.sha256 AS source_sha256"
            " FROM rules r JOIN sources s ON s.st = r.st AND s.id = r.source_id WHERE (? IS NULL OR r.st = ?) ORDER BY r.st, r.ord",
            (st, st),
        )
        for r in rows:
            r["params"] = json.loads(r["params"] or "{}")
            r["ir"] = json.loads(r["ir"]) if r.get("ir") else None
        return rows

    def corpus_sources(self, st: str | None) -> list[dict[str, Any]]:
        return self._all(
            "SELECT st, id, title, url, kind, sha256, retrieved_at FROM sources WHERE (? IS NULL OR st = ?) ORDER BY st, id", (st, st)
        )

    def law_versions(self) -> list[dict[str, Any]]:
        return self._all(f"SELECT {VERSION_COLUMNS} FROM law_versions ORDER BY seq")

    def law_version_files(self, version: str | None = None, st: str | None = None) -> list[dict[str, Any]]:
        return self._all(
            "SELECT version, st, verified_sha256, ir_sha256, rule_count FROM law_version_files"
            " WHERE (? IS NULL OR version = ?) AND (? IS NULL OR st = ?) ORDER BY version, st",
            (version, version, st, st),
        )

    def register_law_version(self, version: dict[str, Any], files: list[dict[str, Any]]) -> bool:
        with self._tx() as c:
            row = c.execute("SELECT corpus_sha256 FROM law_versions WHERE name = ?", (version["name"],)).fetchone()
            if row is not None:
                if row["corpus_sha256"] != version["corpus_sha256"]:
                    raise ValueError(f"{version['name']} is already published with a different corpus")
                return False
            values = {**version, "load_ms": version.get("load_ms"), "published_at": version.get("published_at") or iso(utcnow())}
            c.execute(
                f"INSERT INTO law_versions ({VERSION_COLUMNS}) VALUES ({', '.join('?' * len(VERSION_KEYS))})",
                tuple(values[k] for k in VERSION_KEYS),
            )
            c.executemany(
                "INSERT INTO law_version_files (version, st, verified_sha256, ir_sha256, rule_count) VALUES (?, ?, ?, ?, ?)",
                [(version["name"], f["st"], f["verified_sha256"], f["ir_sha256"], f["rule_count"]) for f in files],
            )
        return True

    # sealed shares

    def insert_share(self, share: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO sealed_shares (id, ciphertext, iv, size_bytes, once, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    share["id"],
                    share["ciphertext"],
                    share["iv"],
                    len(share["ciphertext"]),
                    int(share["once"]),
                    share["created_at"],
                    share["expires_at"],
                ),
            )

    def open_share(self, share_id: str, now: str) -> tuple[ShareState, dict[str, Any] | None]:
        with self._tx() as c:
            row = c.execute("SELECT * FROM sealed_shares WHERE id = ?", (share_id,)).fetchone()
            if row is None:
                return "missing", None
            share = dict(row)
            if share["expires_at"] <= now:
                c.execute("DELETE FROM sealed_shares WHERE id = ?", (share_id,))
                return "expired", None
            share["once"] = bool(share["once"])
            if share["once"]:
                if share["opened_at"] is not None:
                    return "opened", None
                # An open-once share hands over its ciphertext exactly once, in this transaction.
                c.execute("UPDATE sealed_shares SET ciphertext = NULL, iv = NULL, opened_at = ? WHERE id = ?", (now, share_id))
                share["opened_at"] = now
            return "ok", share

    def delete_share(self, share_id: str) -> bool:
        with self._tx() as c:
            return c.execute("DELETE FROM sealed_shares WHERE id = ?", (share_id,)).rowcount == 1

    # payments: every change of status is a compare-and-set

    def insert_action(self, action: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO pending_actions (action_id, status, amount_cents, from_account, payee, payee_tag, code_mac, channel,"
                " dry_run, bill_id, item_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    action["action_id"],
                    action["status"],
                    action["amount_cents"],
                    action["from_account"],
                    action["payee"],
                    action["payee_tag"],
                    action["code_mac"],
                    action.get("channel", "app"),
                    int(action["dry_run"]),
                    action.get("bill_id"),
                    json.dumps(action.get("item_ids") or []),
                    action["created_at"],
                    action["expires_at"],
                ),
            )

    def get_action(self, action_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM pending_actions WHERE action_id = ?", (action_id,))
        if row:
            row["dry_run"] = bool(row["dry_run"])
            row["item_ids"] = json.loads(row["item_ids"] or "[]")
            row["readback"] = json.loads(row["readback"]) if row["readback"] else None
        return row

    def count_failed_attempt(self, action_id: str, lock_at: int) -> int:
        with self._tx() as c:
            c.execute("UPDATE pending_actions SET attempts = attempts + 1 WHERE action_id = ? AND status = 'proposed'", (action_id,))
            attempts = c.execute("SELECT attempts FROM pending_actions WHERE action_id = ?", (action_id,)).fetchone()["attempts"]
            if attempts >= lock_at:
                c.execute(
                    "UPDATE pending_actions SET status = 'locked', payee = NULL WHERE action_id = ? AND status = 'proposed'", (action_id,)
                )
            return attempts

    def transition_action(
        self, action_id: str, from_status: str, to_status: str, fields: dict[str, Any], not_expired_at: str | None = None
    ) -> bool:
        bad = set(fields) - ACTION_FIELDS
        if bad:
            raise ValueError(f"cannot set {sorted(bad)} on an action")
        if to_status in FINAL_STATUSES:
            fields = {**fields, "payee": None}  # a finished action keeps only the keyed hash of its payee
        cols, args = ["status = ?"], [to_status]
        for key, value in fields.items():
            cols.append(f"{key} = ?")
            args.append(json.dumps(value) if key == "readback" and value is not None else value)
        sql = f"UPDATE pending_actions SET {', '.join(cols)} WHERE action_id = ? AND status = ?"
        args += [action_id, from_status]
        if not_expired_at is not None:
            sql += " AND expires_at > ?"
            args.append(not_expired_at)
        with self._tx() as c:
            return c.execute(sql, tuple(args)).rowcount == 1

    def append_audit(self, event: str, action_id: str, data: dict[str, Any], ts: str) -> dict[str, Any]:
        with self._tx() as c:
            last = c.execute("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").fetchone()
            seq = (last["seq"] + 1) if last else 1
            prev = last["hash"] if last else GENESIS_HASH
            body, digest = audit_body(seq, ts, event, action_id, data, prev)
            c.execute(
                "INSERT INTO audit_log (seq, ts, event, action_id, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (seq, ts, event, action_id, body, prev, digest),
            )
        return {"seq": seq, "ts": ts, "event": event, "action_id": action_id, "data": data, "prev_hash": prev, "hash": digest}

    def audit_rows(self, action_id: str | None = None) -> list[dict[str, Any]]:
        if action_id is None:
            rows = self._all("SELECT * FROM audit_log ORDER BY seq")
        else:
            rows = self._all("SELECT * FROM audit_log WHERE action_id = ? ORDER BY seq", (action_id,))
        out = []
        for r in rows:
            body = json.loads(r["body"])
            out.append({**r, "data": body.get("data"), "body": body})
        return out

    def sweep(self, now: str) -> dict[str, int]:
        cutoff = iso(parse_iso(now) - FINISHED_KEEP)
        with self._tx() as c:
            shares = c.execute("DELETE FROM sealed_shares WHERE expires_at <= ?", (now,)).rowcount
            expired = c.execute(
                "UPDATE pending_actions SET status = 'expired', payee = NULL, finished_at = ? WHERE status = 'proposed' AND expires_at <= ?",
                (now, now),
            ).rowcount
            dropped = c.execute(
                f"DELETE FROM pending_actions WHERE status IN ({','.join('?' * len(FINAL_STATUSES))}) AND expires_at <= ?",
                (*sorted(FINAL_STATUSES), cutoff),
            ).rowcount
        return {"shares": shares, "expired_actions": expired, "dropped_actions": dropped}
