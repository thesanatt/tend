"""Neon Postgres behind the Repository protocol.

The app talks to Neon's pooled endpoint (PgBouncer in transaction mode), so every unit of work is
one transaction, session state is never relied on, and prepared statements are off. Migrations run
over the direct endpoint when one is configured. A non-public schema keeps a test run apart from
the real tables; it is set with SET LOCAL inside each transaction.

With a reader_url, public corpus reads go through a second pool as a role that can only SELECT the
corpus (docs/NEON.md, roles.py); shares and payments keep the app's role.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import secrets
import time
import weakref
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from ..clock import iso, parse_iso
from .base import (
    ACTION_FIELDS,
    FINAL_STATUSES,
    GENESIS_HASH,
    MARK_CLOSE,
    MARK_OPEN,
    VERSION_COLUMNS,
    MigrationError,
    ShareState,
    audit_body,
    check_applied,
    marks,
    migration_files,
)
from .corpus import CATEGORIES, CorpusBundle, image_rows, jurisdiction_row, rule_rows, source_rows
from .roles import apply_grants

_SCHEMA = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
RULE_COLUMNS = (
    "r.st, r.id, r.ord, r.category, r.expense, r.params, r.summary, r.quote, r.pinpoint, r.source_id, r.fragment_url, r.ir, r.ir_kind,"
    " s.title AS source_title, s.url AS source_url, s.sha256 AS source_sha256"
)
FINISHED_KEEP = dt.timedelta(days=1)
FRESH_S = 30.0  # a pooled connection used this recently is trusted without a round trip to check it
# ts_headline wraps each matched word in the base module's marks, which marks() turns into offsets.
HEADLINE = f"HighlightAll=true, StartSel={MARK_OPEN}, StopSel={MARK_CLOSE}"

# The law version index and quote search. Idempotent DDL kept out of the numbered migrations on purpose: API code
# from before them refuses a database whose schema_migrations lists a version it does not know, and every API build
# shares the one production database. Created here where missing, never recorded (docs/NEON.md).
ENSURE_SQL = tuple((p.stem, p.read_text(encoding="utf-8")) for p in sorted((Path(__file__).parent / "ensure").glob("*.sql")))


def law_schema_missing(conn: psycopg.Connection, schema: str) -> list[str]:
    row = conn.execute(
        "SELECT to_regclass(%s) IS NOT NULL AS law_versions, EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(%s)"
        " AND attname = 'quote_search' AND NOT attisdropped) AS quote_search",
        (f"{schema}.law_versions", f"{schema}.rules"),
    ).fetchone()
    present = dict(row) if isinstance(row, dict) else {"law_versions": row[0], "quote_search": row[1]}
    return [name for name, _ in ENSURE_SQL if not present.get(name)]


def ensure_law_schema(conn: psycopg.Connection, schema: str) -> list[str]:
    """Creates whatever of the law objects is missing in this schema (the connection's search_path must name it).
    Returns what it created."""
    missing = law_schema_missing(conn, schema)
    for name, text in ENSURE_SQL:
        if name in missing:
            conn.execute(text)
    return missing


def _plain(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Timestamps come back as datetimes; the rest of the API speaks fixed-width ISO strings."""
    if row is None:
        return None
    return {k: iso(v) if isinstance(v, dt.datetime) else v for k, v in row.items()}


def _ts(value: str | None) -> dt.datetime | None:
    return parse_iso(value) if value else None


class PostgresRepository:
    backend = "postgres"

    def __init__(
        self,
        url: str,
        *,
        schema: str = "public",
        migrate: bool = True,
        migrate_url: str | None = None,
        pool_size: int = 4,
        reader_url: str | None = None,
    ):
        if not _SCHEMA.match(schema):
            raise ValueError(f"not a safe schema name: {schema!r}")
        self.schema = schema
        self.migrate_url = migrate_url or url
        self._used: weakref.WeakKeyDictionary[psycopg.Connection, float] = weakref.WeakKeyDictionary()
        self._pool = self._make_pool(url, pool_size, "tend")
        # Public corpus reads go through a role that can only SELECT the corpus, when one is configured.
        self._reader = self._make_pool(reader_url, pool_size, "tend-reader") if reader_url and reader_url != url else None
        if migrate:
            self.migrate()

    def _make_pool(self, url: str, size: int, name: str) -> ConnectionPool:
        return ConnectionPool(
            url,
            min_size=0,
            max_size=size,
            # Autocommit: a read is one round trip; writes open their own transaction explicitly.
            kwargs={"row_factory": dict_row, "prepare_threshold": None, "connect_timeout": 15, "autocommit": True},
            check=self._check,
            max_idle=120,
            timeout=30,
            open=True,
            name=name,
        )

    @property
    def split_roles(self) -> bool:
        """True when corpus reads use their own read-only role."""
        return self._reader is not None

    def _check(self, conn: psycopg.Connection) -> None:
        # Neon drops idle connections when its compute sleeps; one quiet for a while is checked before use.
        if time.monotonic() - self._used.get(conn, 0.0) > FRESH_S:
            ConnectionPool.check_connection(conn)

    @contextmanager
    def _tx(self, pool: ConnectionPool | None = None) -> Iterator[psycopg.Connection]:
        with (pool or self._pool).connection() as conn:
            try:
                with conn.transaction():
                    if self.schema != "public":
                        conn.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(self.schema)))
                    yield conn
            finally:
                self._used[conn] = time.monotonic()

    def _all(self, query: str, args: dict[str, Any] | tuple[Any, ...] = (), *, read: bool = False) -> list[dict[str, Any]]:
        pool = self._reader if read and self._reader is not None else self._pool
        if self.schema != "public":  # a test schema is set per transaction
            with self._tx(pool) as c:
                return [_plain(r) for r in c.execute(query, args).fetchall()]
        with pool.connection() as conn:
            try:
                return [_plain(r) for r in conn.execute(query, args).fetchall()]
            finally:
                self._used[conn] = time.monotonic()

    def _one(self, query: str, args: dict[str, Any] | tuple[Any, ...] = (), *, read: bool = False) -> dict[str, Any] | None:
        rows = self._all(query, args, read=read)
        return rows[0] if rows else None

    def _read(self, query: str, args: dict[str, Any] | tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        """A public corpus read: through the read-only role when there is one."""
        return self._all(query, args, read=True)

    def close(self) -> None:
        self._pool.close()
        if self._reader is not None:
            self._reader.close()

    # schema

    def _bookkeeping(self) -> tuple[list[str] | None, list[str]]:
        """(migrations still to run, or None when this schema was never migrated; law objects still missing), read
        without any DDL, so a role that cannot create tables can still start the app when nothing is due."""
        files = migration_files("postgres")
        with psycopg.connect(self.migrate_url, row_factory=dict_row, prepare_threshold=None, connect_timeout=15, autocommit=True) as conn:
            table = conn.execute("SELECT to_regclass(%s) AS t", (f"{self.schema}.schema_migrations",)).fetchone()["t"]
            if table is None:
                return None, [name for name, _ in ENSURE_SQL]
            applied = {
                r["version"]: r["sha256"]
                for r in conn.execute(sql.SQL("SELECT version, sha256 FROM {}.schema_migrations").format(sql.Identifier(self.schema)))
            }
            missing = law_schema_missing(conn, self.schema)
        return [v for v, _, _ in check_applied(applied, files)], missing

    def pending_migrations(self) -> list[str] | None:
        return self._bookkeeping()[0]

    def migrate(self) -> list[str]:
        pending_now, missing = self._bookkeeping()
        if pending_now == [] and not missing:
            return []
        files = migration_files("postgres")
        try:
            with psycopg.connect(self.migrate_url, row_factory=dict_row, prepare_threshold=None, connect_timeout=15) as conn:
                with conn.transaction():
                    conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(self.schema)))
                    conn.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(self.schema)))
                    # One migrator at a time per schema; the lock ends with the transaction.
                    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{self.schema}:migrate",))
                    conn.execute(
                        "CREATE TABLE IF NOT EXISTS schema_migrations"
                        " (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
                    )
                    applied = {r["version"]: r["sha256"] for r in conn.execute("SELECT version, sha256 FROM schema_migrations")}
                    pending = check_applied(applied, files)
                    for version, text, digest in pending:
                        conn.execute(text)
                        conn.execute("INSERT INTO schema_migrations (version, sha256) VALUES (%s, %s)", (version, digest))
                    created = ensure_law_schema(conn, self.schema)
                    if pending or created:
                        # New tables get each role's rights in the same transaction (a no-op where the roles do not exist).
                        apply_grants(conn, self.schema)
        except psycopg.errors.InsufficientPrivilege as exc:
            raise MigrationError(
                "migrations are pending and this role cannot run them; run `uv run python -m tend_api.loader` with the owner's"
                " DATABASE_URL first"
            ) from exc
        return [v for v, _, _ in pending] + created

    def drop_schema(self) -> None:
        """Only for test schemas: removes everything a test run made."""
        if self.schema == "public":
            raise ValueError("refusing to drop the public schema")
        with psycopg.connect(self.migrate_url, connect_timeout=15) as conn:
            conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(self.schema)))

    def ping(self) -> dict[str, Any]:
        started = time.monotonic()
        row = self._one("SELECT current_setting('server_version') AS version")
        return {"backend": self.backend, "ok": True, "server_version": row["version"], "ms": round((time.monotonic() - started) * 1000)}

    def secret(self) -> bytes:
        with self._tx() as c:
            c.execute(
                "INSERT INTO meta (key, value) VALUES ('secret', %s) ON CONFLICT (key) DO NOTHING",
                (secrets.token_bytes(32).hex(),),
            )
            return bytes.fromhex(c.execute("SELECT value FROM meta WHERE key = 'secret'").fetchone()["value"])

    # the public corpus

    def load_corpus(self, bundles: Iterable[CorpusBundle], *, force: bool = False) -> dict[str, Any]:
        loaded, unchanged = [], []
        with self._tx() as c:
            with c.cursor() as cur:
                cur.executemany(
                    "INSERT INTO categories (name, meaning, decides) VALUES (%s, %s, %s)"
                    " ON CONFLICT (name) DO UPDATE SET meaning = excluded.meaning, decides = excluded.decides",
                    [(name, meaning, decides) for name, (meaning, decides) in CATEGORIES.items()],
                )
            current = {
                r["st"]: (r["verified_sha256"], r["ir_sha256"])
                for r in c.execute("SELECT st, verified_sha256, ir_sha256 FROM jurisdictions").fetchall()
            }
            for b in bundles:
                if not force and current.get(b.st) == (b.verified_sha256, b.ir_sha256):
                    unchanged.append(b.st)
                else:
                    self._replace(c, b)
                    loaded.append(b.st)
                images = image_rows(b)
                if images:
                    with c.cursor() as cur:
                        cur.executemany(
                            "INSERT INTO law_images (st, image_sha256, engine_version, verified_sha256, ir_sha256, bytes)"
                            " VALUES (%(st)s, %(image_sha256)s, %(engine_version)s, %(verified_sha256)s, %(ir_sha256)s, %(bytes)s)"
                            " ON CONFLICT (st, image_sha256) DO NOTHING",
                            images,
                        )
        return {"loaded": loaded, "unchanged": unchanged, "counts": self.corpus_counts()}

    @staticmethod
    def _replace(c: psycopg.Connection, b: CorpusBundle) -> None:
        j = jurisdiction_row(b)
        c.execute("DELETE FROM rules WHERE st = %s", (b.st,))
        c.execute("DELETE FROM sources WHERE st = %s", (b.st,))
        c.execute(
            "INSERT INTO jurisdictions (st, name, program, coverage, confidence, verified_sha256, ir_sha256, ir_version, rule_count,"
            " source_count, skipped_count, loaded_at) VALUES (%(st)s, %(name)s, %(program)s, %(coverage)s, %(confidence)s,"
            " %(verified_sha256)s, %(ir_sha256)s, %(ir_version)s, %(rule_count)s, %(source_count)s, %(skipped_count)s, now())"
            " ON CONFLICT (st) DO UPDATE SET name = excluded.name, program = excluded.program, coverage = excluded.coverage,"
            " confidence = excluded.confidence, verified_sha256 = excluded.verified_sha256, ir_sha256 = excluded.ir_sha256,"
            " ir_version = excluded.ir_version, rule_count = excluded.rule_count, source_count = excluded.source_count,"
            " skipped_count = excluded.skipped_count, loaded_at = excluded.loaded_at",
            {**j, "program": Jsonb(j["program"]), "coverage": Jsonb(j["coverage"]) if j["coverage"] is not None else None},
        )
        with c.cursor() as cur:
            cur.executemany(
                "INSERT INTO sources (st, id, title, url, kind, retrieved_at, raw_path, text_path, sha256) VALUES (%(st)s, %(id)s,"
                " %(title)s, %(url)s, %(kind)s, %(retrieved_at)s, %(raw_path)s, %(text_path)s, %(sha256)s)",
                [{**s, "retrieved_at": _ts(s["retrieved_at"])} for s in source_rows(b)],
            )
            cur.executemany(
                "INSERT INTO rules (st, id, ord, category, expense, params, summary, quote, pinpoint, source_id, fragment_url, ir, ir_kind,"
                " skipped_reason, heading) VALUES (%(st)s, %(id)s, %(ord)s, %(category)s, %(expense)s, %(params)s, %(summary)s,"
                " %(quote)s, %(pinpoint)s, %(source_id)s, %(fragment_url)s, %(ir)s, %(ir_kind)s, %(skipped_reason)s, %(heading)s)",
                [{**r, "params": Jsonb(r["params"]), "ir": Jsonb(r["ir"]) if r["ir"] is not None else None} for r in rule_rows(b)],
            )

    def corpus_counts(self) -> dict[str, int]:
        row = self._one(
            "SELECT (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM jurisdictions) AS jurisdictions,"
            " (SELECT count(*) FROM sources) AS sources, (SELECT count(*) FROM rules) AS rules,"
            " (SELECT count(*) FROM law_images) AS law_images",
            read=True,
        )
        return {k: int(v) for k, v in row.items()}

    def corpus_hashes(self) -> dict[str, dict[str, str | None]]:
        rows = self._read("SELECT st, verified_sha256, ir_sha256 FROM jurisdictions ORDER BY st")
        return {r["st"]: {"verified_sha256": r["verified_sha256"], "ir_sha256": r["ir_sha256"]} for r in rows}

    def jurisdiction(self, st: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM jurisdictions WHERE st = %s", (st,), read=True)

    @staticmethod
    def _rule(row: dict[str, Any]) -> dict[str, Any]:
        row["rule_id"] = row["id"]
        row["score"] = float(row.get("score") or 0.0)
        return row

    def search_rules(self, terms: list[str], st: str | None, limit: int) -> list[dict[str, Any]]:
        if not terms:
            return []
        rows = self._read(
            f"SELECT {RULE_COLUMNS}, ts_rank_cd(r.search, q.query, 32) AS score"
            " FROM rules r JOIN sources s ON s.st = r.st AND s.id = r.source_id"
            " CROSS JOIN to_tsquery('english', %(tsq)s) AS q(query)"
            " WHERE r.search @@ q.query AND (%(st)s::text IS NULL OR r.st = %(st)s)"
            " ORDER BY score DESC, r.st, r.ord LIMIT %(limit)s",
            {"tsq": " | ".join(terms), "st": st, "limit": limit},
        )
        return [self._rule(r) for r in rows]

    def rules_where(self, st: str, categories: Iterable[str], expenses: Iterable[str]) -> list[dict[str, Any]]:
        cats, exps = sorted(set(categories)), sorted(set(expenses))
        if not cats and not exps:
            return []
        rows = self._read(
            f"SELECT {RULE_COLUMNS}, 0.0 AS score FROM rules r JOIN sources s ON s.st = r.st AND s.id = r.source_id"
            " WHERE r.st = %(st)s AND (r.category = ANY(%(cats)s) OR r.expense = ANY(%(exps)s)) ORDER BY r.ord",
            {"st": st, "cats": cats, "exps": exps},
        )
        return [self._rule(r) for r in rows]

    def source(self, st: str, source_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM sources WHERE st = %s AND id = %s", (st, source_id), read=True)

    def law_images(self, st: str) -> list[dict[str, Any]]:
        return self._read(
            "SELECT st, image_sha256, engine_version, verified_sha256, ir_sha256, bytes, compiled_at FROM law_images WHERE st = %s"
            " ORDER BY compiled_at DESC, image_sha256",
            (st,),
        )

    # quote search and law versions

    def law_search(self, q: str, st: str | None, limit: int) -> list[dict[str, Any]]:
        """websearch_to_tsquery reads what someone types ("quoted phrases", or, -word) and never raises on it; the
        GIN index on quote_search finds the rules; ts_headline marks the matched words for the page to highlight."""
        rows = self._read(
            "SELECT r.st, r.id AS rule_id, r.quote, r.pinpoint, r.source_id, r.fragment_url,"
            " ts_rank_cd(r.quote_search, q.query, 32) AS rank, ts_headline('english', r.quote, q.query, %(opts)s) AS marked"
            " FROM rules r CROSS JOIN websearch_to_tsquery('english', %(q)s) AS q(query)"
            " WHERE r.quote_search @@ q.query AND (%(st)s::text IS NULL OR r.st = %(st)s)"
            " ORDER BY rank DESC, r.st, r.ord LIMIT %(limit)s",
            {"q": q, "st": st, "limit": limit, "opts": HEADLINE},
        )
        for r in rows:
            r["rank"] = round(float(r["rank"]), 6)
            r["marks"] = marks(r["quote"], r.pop("marked") or "")
        return rows

    def corpus_rules(self, st: str | None) -> list[dict[str, Any]]:
        return self._read(
            "SELECT r.st, r.id, r.ord, r.category, r.expense, r.params, r.summary, r.quote, r.pinpoint, r.source_id, r.fragment_url,"
            " r.ir, r.ir_kind, r.skipped_reason, s.title AS source_title, s.url AS source_url, s.sha256 AS source_sha256"
            " FROM rules r JOIN sources s ON s.st = r.st AND s.id = r.source_id"
            " WHERE (%(st)s::text IS NULL OR r.st = %(st)s) ORDER BY r.st, r.ord",
            {"st": st},
        )

    def corpus_sources(self, st: str | None) -> list[dict[str, Any]]:
        return self._read(
            "SELECT st, id, title, url, kind, sha256, retrieved_at FROM sources WHERE (%(st)s::text IS NULL OR st = %(st)s) ORDER BY st, id",
            {"st": st},
        )

    def law_versions(self) -> list[dict[str, Any]]:
        return self._read(f"SELECT {VERSION_COLUMNS} FROM law_versions ORDER BY seq")

    def law_version_files(self, version: str | None = None, st: str | None = None) -> list[dict[str, Any]]:
        return self._read(
            "SELECT version, st, verified_sha256, ir_sha256, rule_count FROM law_version_files"
            " WHERE (%(v)s::text IS NULL OR version = %(v)s) AND (%(st)s::text IS NULL OR st = %(st)s) ORDER BY version, st",
            {"v": version, "st": st},
        )

    def register_law_version(self, version: dict[str, Any], files: list[dict[str, Any]]) -> bool:
        """Adds a published version to the index. False when it is already there with the same corpus; a name that
        is already taken by a different corpus is refused, since a published version never changes."""
        with self._tx() as c:
            row = c.execute("SELECT corpus_sha256 FROM law_versions WHERE name = %s FOR UPDATE", (version["name"],)).fetchone()
            if row is not None:
                if row["corpus_sha256"] != version["corpus_sha256"]:
                    raise ValueError(f"{version['name']} is already published with a different corpus")
                return False
            c.execute(
                f"INSERT INTO law_versions ({VERSION_COLUMNS}) VALUES (%(name)s, %(seq)s, %(git_sha)s, %(committed_at)s, %(subject)s,"
                " %(parent)s, %(branch_id)s, %(endpoint_host)s, %(corpus_sha256)s, %(jurisdictions)s, %(rules)s, %(sources)s,"
                " %(load_ms)s, coalesce(%(published_at)s, now()))",
                {
                    **version,
                    "committed_at": _ts(version["committed_at"]),
                    "published_at": _ts(version.get("published_at")),
                    "load_ms": version.get("load_ms"),
                },
            )
            with c.cursor() as cur:
                cur.executemany(
                    "INSERT INTO law_version_files (version, st, verified_sha256, ir_sha256, rule_count)"
                    " VALUES (%(version)s, %(st)s, %(verified_sha256)s, %(ir_sha256)s, %(rule_count)s)",
                    [{**f, "version": version["name"]} for f in files],
                )
        return True

    # sealed shares

    def insert_share(self, share: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO sealed_shares (id, ciphertext, iv, size_bytes, once, created_at, expires_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    share["id"],
                    share["ciphertext"],
                    share["iv"],
                    len(share["ciphertext"]),
                    share["once"],
                    _ts(share["created_at"]),
                    _ts(share["expires_at"]),
                ),
            )

    def open_share(self, share_id: str, now: str) -> tuple[ShareState, dict[str, Any] | None]:
        with self._tx() as c:
            # FOR UPDATE: a second reader of an open-once share waits here, then sees it opened.
            row = _plain(c.execute("SELECT * FROM sealed_shares WHERE id = %s FOR UPDATE", (share_id,)).fetchone())
            if row is None:
                return "missing", None
            if row["expires_at"] <= now:
                c.execute("DELETE FROM sealed_shares WHERE id = %s", (share_id,))
                return "expired", None
            if row["once"]:
                if row["opened_at"] is not None:
                    return "opened", None
                c.execute("UPDATE sealed_shares SET ciphertext = NULL, iv = NULL, opened_at = %s WHERE id = %s", (_ts(now), share_id))
                row["opened_at"] = now
            return "ok", row

    def delete_share(self, share_id: str) -> bool:
        with self._tx() as c:
            return c.execute("DELETE FROM sealed_shares WHERE id = %s", (share_id,)).rowcount == 1

    # payments

    def insert_action(self, action: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO pending_actions (action_id, status, amount_cents, from_account, payee, payee_tag, code_mac, channel, dry_run,"
                " bill_id, item_ids, created_at, expires_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    action["action_id"],
                    action["status"],
                    action["amount_cents"],
                    action["from_account"],
                    action["payee"],
                    action["payee_tag"],
                    action["code_mac"],
                    action.get("channel", "app"),
                    action["dry_run"],
                    action.get("bill_id"),
                    Jsonb(action.get("item_ids") or []),
                    _ts(action["created_at"]),
                    _ts(action["expires_at"]),
                ),
            )

    def get_action(self, action_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM pending_actions WHERE action_id = %s", (action_id,))
        if row:
            row["amount_cents"] = int(row["amount_cents"])
        return row

    def count_failed_attempt(self, action_id: str, lock_at: int) -> int:
        with self._tx() as c:
            row = c.execute(
                "UPDATE pending_actions SET attempts = attempts + 1 WHERE action_id = %s AND status = 'proposed' RETURNING attempts",
                (action_id,),
            ).fetchone()
            if row is None:
                return int(c.execute("SELECT attempts FROM pending_actions WHERE action_id = %s", (action_id,)).fetchone()["attempts"])
            if row["attempts"] >= lock_at:
                c.execute(
                    "UPDATE pending_actions SET status = 'locked', payee = NULL WHERE action_id = %s AND status = 'proposed'", (action_id,)
                )
            return int(row["attempts"])

    def transition_action(
        self, action_id: str, from_status: str, to_status: str, fields: dict[str, Any], not_expired_at: str | None = None
    ) -> bool:
        bad = set(fields) - ACTION_FIELDS
        if bad:
            raise ValueError(f"cannot set {sorted(bad)} on an action")
        if to_status in FINAL_STATUSES:
            fields = {**fields, "payee": None}
        sets = [sql.SQL("status = %(to_status)s")]
        args: dict[str, Any] = {"to_status": to_status, "action_id": action_id, "from_status": from_status}
        for key, value in fields.items():
            sets.append(sql.SQL("{} = %({})s").format(sql.Identifier(key), sql.SQL(key)))
            if key == "readback" and value is not None:
                value = Jsonb(value)
            elif key in ("confirmed_at", "finished_at"):
                value = _ts(value)
            args[key] = value
        query = sql.SQL("UPDATE pending_actions SET {} WHERE action_id = %(action_id)s AND status = %(from_status)s").format(
            sql.SQL(", ").join(sets)
        )
        if not_expired_at is not None:
            query += sql.SQL(" AND expires_at > %(not_expired_at)s")
            args["not_expired_at"] = _ts(not_expired_at)
        with self._tx() as c:
            return c.execute(query, args).rowcount == 1

    def append_audit(self, event: str, action_id: str, data: dict[str, Any], ts: str) -> dict[str, Any]:
        with self._tx() as c:
            # The same lock the insert trigger takes: read the head and extend it as one step.
            c.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{self.schema}:audit_log",))
            last = c.execute("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").fetchone()
            seq = int(last["seq"]) + 1 if last else 1
            prev = last["hash"] if last else GENESIS_HASH
            body, digest = audit_body(seq, ts, event, action_id, data, prev)
            c.execute(
                "INSERT INTO audit_log (seq, ts, event, action_id, body, prev_hash, hash) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (seq, _ts(ts), event, action_id, body, prev, digest),
            )
        return {"seq": seq, "ts": ts, "event": event, "action_id": action_id, "data": data, "prev_hash": prev, "hash": digest}

    def audit_rows(self, action_id: str | None = None) -> list[dict[str, Any]]:
        if action_id is None:
            rows = self._all("SELECT * FROM audit_log ORDER BY seq")
        else:
            rows = self._all("SELECT * FROM audit_log WHERE action_id = %s ORDER BY seq", (action_id,))
        out = []
        for r in rows:
            body = json.loads(r["body"])
            # The canonical body holds the timestamp exactly as it was hashed.
            out.append({**r, "seq": int(r["seq"]), "ts": body.get("ts", r["ts"]), "data": body.get("data"), "body": body})
        return out

    def sweep(self, now: str) -> dict[str, int]:
        at = _ts(now)
        with self._tx() as c:
            shares = c.execute("DELETE FROM sealed_shares WHERE expires_at <= %s", (at,)).rowcount
            expired = c.execute(
                "UPDATE pending_actions SET status = 'expired', payee = NULL, finished_at = %s WHERE status = 'proposed' AND expires_at <= %s",
                (at, at),
            ).rowcount
            dropped = c.execute(
                "DELETE FROM pending_actions WHERE status = ANY(%s) AND expires_at <= %s",
                (sorted(FINAL_STATUSES), at - FINISHED_KEEP),
            ).rowcount
        return {"shares": shares, "expired_actions": expired, "dropped_actions": dropped}
