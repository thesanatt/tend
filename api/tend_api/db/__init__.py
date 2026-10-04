"""Storage for the API: Neon Postgres in production, SQLite offline. See base.py for what is kept."""

from __future__ import annotations

from .base import GENESIS_HASH, MAX_SHARE_BYTES, MigrationError, Repository, audit_hash, verify_chain
from .corpus import CATEGORIES, CorpusBundle, bundle_hashes, corpus_sha256, read_bundle, read_bundles

__all__ = [
    "CATEGORIES",
    "GENESIS_HASH",
    "MAX_SHARE_BYTES",
    "CorpusBundle",
    "MigrationError",
    "Repository",
    "audit_hash",
    "bundle_hashes",
    "corpus_sha256",
    "describe_url",
    "is_postgres",
    "open_repository",
    "read_bundle",
    "read_bundles",
    "verify_chain",
]


def is_postgres(url: str) -> bool:
    return url.startswith(("postgres://", "postgresql://"))


def sqlite_path(url: str) -> str:
    return url.removeprefix("sqlite:///").removeprefix("sqlite://") if url.startswith("sqlite:") else url


def describe_url(url: str) -> str:
    """Where the data lives, without the password."""
    if is_postgres(url):
        host = url.split("@", 1)[-1].split("/", 1)[0].split("?", 1)[0]
        return f"postgres ({host.split('.', 1)[0]})"
    return f"sqlite ({sqlite_path(url)})"


def open_repository(
    url: str, *, schema: str = "public", migrate_url: str | None = None, migrate: bool = True, reader_url: str | None = None
) -> Repository:
    """reader_url: a read-only role for the public corpus (Neon only). Shares and payments always use url."""
    if is_postgres(url):
        from .postgres import PostgresRepository

        return PostgresRepository(url, schema=schema, migrate_url=migrate_url, migrate=migrate, reader_url=reader_url)
    from .sqlite import SQLiteRepository

    return SQLiteRepository(sqlite_path(url), migrate=migrate)
