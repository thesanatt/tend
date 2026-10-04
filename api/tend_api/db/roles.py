"""Least privilege in Neon: one role per kind of access, created with SQL so it starts with no rights at all.

  tend_reader  SELECT on the public corpus and the law version index. Read-only by default at the role level
               (default_transaction_read_only), so even a grant added by mistake cannot let it write. Public
               reads (rules, search, law versions, diffs) and every read of a published law branch use it.
  tend_app     What the API's own writes need: sealed shares and pending payments (read and write), the
               audit log and the meta table (read and append only: no UPDATE, DELETE, or TRUNCATE), and
               SELECT on the corpus. It cannot create tables, change the corpus, or rewrite the audit log.
  neondb_owner Migrations and the corpus loader only. The running API never needs it.

Roles made in the Neon console or API join neon_superuser; roles made with SQL do not, which is why these
are made here. Passwords are random (256 bits) and live only in the .env file.
"""

from __future__ import annotations

import secrets
import urllib.parse
from typing import Any

from psycopg import sql

READER = "tend_reader"
APP = "tend_app"
ROLES = (READER, APP)
CORPUS_TABLES = ("categories", "jurisdictions", "sources", "rules", "law_images", "law_versions", "law_version_files")
APP_READ_WRITE = ("sealed_shares", "pending_actions")
APP_APPEND_ONLY = ("audit_log", "meta")
ROLE_SETTINGS: dict[str, dict[str, str]] = {
    READER: {"default_transaction_read_only": "on", "statement_timeout": "5s", "idle_in_transaction_session_timeout": "10s"},
    APP: {"statement_timeout": "15s", "idle_in_transaction_session_timeout": "30s"},
}


def new_password() -> str:
    return secrets.token_urlsafe(32)


def existing_roles(conn: Any) -> set[str]:
    rows = conn.execute("SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)", (list(ROLES),)).fetchall()
    return {r[0] if isinstance(r, tuple) else r["rolname"] for r in rows}


def ensure_role(conn: Any, role: str, password: str | None) -> bool:
    """Creates the role, or sets its password when one is given. True when the role was created. The password goes
    to the server over TLS inside the statement; it is never printed."""
    if role not in ROLES:
        raise ValueError(f"not a Tend role: {role}")
    created = role not in existing_roles(conn)
    if created:
        if not password:
            raise ValueError(f"{role} does not exist yet and needs a password")
        conn.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
    elif password:
        conn.execute(sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
    for key, value in ROLE_SETTINGS[role].items():
        conn.execute(sql.SQL("ALTER ROLE {} SET {} = {}").format(sql.Identifier(role), sql.Identifier(key), sql.Literal(value)))
    return created


def grant_statements(schema: str, owner: str, tables: set[str]) -> list[sql.Composed]:
    """Exactly what each role may do in one schema. Only tables that exist are named, so this runs on a law branch
    (corpus only) as well as on the production branch. Safe to run again: GRANT and REVOKE are idempotent."""
    s = sql.Identifier(schema)
    both = sql.SQL(", ").join(map(sql.Identifier, ROLES))
    app = sql.Identifier(APP)

    def names(group: tuple[str, ...]) -> sql.Composable | None:
        present = [t for t in group if t in tables]
        return sql.SQL(", ").join(sql.SQL("{}.{}").format(s, sql.Identifier(t)) for t in present) if present else None

    out = [sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(s, both)]
    corpus = names(CORPUS_TABLES + ("schema_migrations",))
    if corpus is not None:
        out += [
            sql.SQL("GRANT SELECT ON {} TO {}").format(corpus, both),
            sql.SQL("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON {} FROM {}").format(corpus, both),
        ]
    read_write = names(APP_READ_WRITE)
    if read_write is not None:
        out += [
            sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON {} TO {}").format(read_write, app),
            sql.SQL("REVOKE TRUNCATE, REFERENCES, TRIGGER ON {} FROM {}").format(read_write, app),
        ]
    append_only = names(APP_APPEND_ONLY)
    if append_only is not None:
        out += [
            sql.SQL("GRANT SELECT, INSERT ON {} TO {}").format(append_only, app),
            sql.SQL("REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON {} FROM {}").format(append_only, app),
        ]
    private = names(APP_READ_WRITE + APP_APPEND_ONLY)
    if private is not None:
        out.append(sql.SQL("REVOKE ALL ON {} FROM {}").format(private, sql.Identifier(READER)))
    # Tables a later migration adds (as the owner) give the app read and write, never DDL, so a new feature works
    # without a grant step; the reader sees nothing new until it is named above.
    out += [
        sql.SQL("ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA {} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}").format(
            sql.Identifier(owner), s, app
        ),
        sql.SQL("ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA {} GRANT USAGE, SELECT ON SEQUENCES TO {}").format(
            sql.Identifier(owner), s, app
        ),
    ]
    return out


def apply_grants(conn: Any, schema: str = "public") -> list[str]:
    """Grants for both roles in one schema, when the roles exist. Returns the roles it granted to."""
    present = existing_roles(conn)
    if present != set(ROLES):
        return []
    row = conn.execute("SELECT current_user AS u, current_database() AS d").fetchone()
    owner, database = (row[0], row[1]) if isinstance(row, tuple) else (row["u"], row["d"])
    tables = {
        r[0] if isinstance(r, tuple) else r["tablename"]
        for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = %s", (schema,)).fetchall()
    }
    conn.execute(
        sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), sql.SQL(", ").join(map(sql.Identifier, ROLES)))
    )
    for stmt in grant_statements(schema, owner, tables):
        conn.execute(stmt)
    return sorted(present)


def role_url(base_url: str, role: str, password: str) -> str:
    """base_url with another role's name and password: same host (pooled or direct), database, and options."""
    parts = urllib.parse.urlsplit(base_url)
    host = parts.netloc.rsplit("@", 1)[-1]
    userinfo = f"{urllib.parse.quote(role, safe='')}:{urllib.parse.quote(password, safe='')}"
    return urllib.parse.urlunsplit((parts.scheme, f"{userinfo}@{host}", parts.path, parts.query, parts.fragment))


# What each role should be able to do, tried for real. Every statement either reads or cannot change a row even
# when it is allowed (WHERE false, or rolled back), so the check is safe on the production branch.
CHECKS: tuple[tuple[str, str, str], ...] = (  # (what, statement, who may: both, app, or none)
    ("read the rules", "SELECT count(*) FROM rules", "both"),
    ("search the quotes", "SELECT count(*) FROM rules WHERE quote_search @@ websearch_to_tsquery('english', 'counseling')", "both"),
    ("read the law version index", "SELECT count(*) FROM law_versions", "both"),
    ("change a rule", "UPDATE rules SET quote = quote WHERE false", "none"),
    ("delete rules", "DELETE FROM rules WHERE false", "none"),
    ("read sealed shares", "SELECT count(*) FROM sealed_shares", "app"),
    ("write a sealed share", "DELETE FROM sealed_shares WHERE false", "app"),
    ("read the audit log", "SELECT count(*) FROM audit_log", "app"),
    ("append to the audit log", "INSERT INTO audit_log SELECT * FROM audit_log WHERE false", "app"),
    ("rewrite the audit log", "UPDATE audit_log SET event = event WHERE false", "none"),
    ("delete from the audit log", "DELETE FROM audit_log WHERE false", "none"),
    ("truncate the audit log", "TRUNCATE audit_log", "none"),
    ("create a table", "CREATE TABLE tend_role_check (i int)", "none"),
    ("create a schema", "CREATE SCHEMA tend_role_check", "none"),
)
EXPECT = {
    READER: {name: who == "both" for name, _, who in CHECKS},
    APP: {name: who in ("both", "app") for name, _, who in CHECKS},
}


def privilege_matrix(urls: dict[str, str], schema: str = "public") -> list[dict[str, Any]]:
    """Runs every check as each role, each in its own transaction that is rolled back. One row per check and role:
    allowed (True or False), what was expected, and the error class when refused."""
    import psycopg

    out = []
    for role, url in urls.items():
        with psycopg.connect(url, connect_timeout=20, prepare_threshold=None) as conn:
            for name, statement, _ in CHECKS:
                try:
                    with conn.transaction(force_rollback=True):
                        if schema != "public":
                            conn.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(schema)))
                        conn.execute(statement)
                    allowed, error = True, None
                except psycopg.Error as exc:
                    allowed, error = False, type(exc).__name__
                out.append({"role": role, "check": name, "allowed": allowed, "expected": EXPECT[role][name], "error": error})
    return out
