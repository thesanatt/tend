"""Shared by the scripts in scripts/neon: the .env file, git history of the corpus, and Neon connections.

Run the scripts with the API's environment (they import tend_api):
  cd api && uv run python ../scripts/neon/<script>.py ...
Nothing here prints a password or an API key.
"""

from __future__ import annotations

import io
import subprocess
import tarfile
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

from dotenv import dotenv_values

REPO = Path(__file__).resolve().parents[2]
CORPUS_PATHS = ("rules/verified", "rules/ir")


def env_file() -> Path:
    """The nearest .env above the repo (a worktree's lives in the main checkout)."""
    for d in (REPO, *REPO.parents):
        if (d / ".env").is_file():
            return d / ".env"
    raise SystemExit("no .env file found above the repo")


def load_env() -> dict[str, str]:
    return {k: v for k, v in dotenv_values(env_file()).items() if v}


def append_env(key: str, value: str) -> None:
    """Adds KEY=value to the .env file, refusing to overwrite a key that is already there. Prints nothing secret."""
    path = env_file()
    text = path.read_text()
    if any(line.split("=", 1)[0].strip() == key for line in text.splitlines()):
        raise SystemExit(f"{key} is already in {path}; remove it first to replace it")
    with path.open("a") as f:
        if text and not text.endswith("\n"):
            f.write("\n")
        f.write(f"{key}={value}\n")


def replace_env(key: str, value: str) -> None:
    """Replaces KEY=... in the .env file (for a rotated password). Prints nothing secret."""
    path = env_file()
    lines = path.read_text().splitlines(keepends=True)
    hits = [i for i, line in enumerate(lines) if line.split("=", 1)[0].strip() == key]
    if len(hits) != 1:
        raise SystemExit(f"expected exactly one {key} line in {path}, found {len(hits)}")
    lines[hits[0]] = f"{key}={value}\n"
    path.write_text("".join(lines))


def url_password(url: str) -> str | None:
    pw = urllib.parse.urlsplit(url).password
    return urllib.parse.unquote(pw) if pw else None


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True).stdout


def corpus_commits() -> list[str]:
    """Every commit that changed rules/verified or rules/ir, oldest first, as full shas."""
    return list(reversed(git("log", "--format=%H", "--", *CORPUS_PATHS).split()))


def commit_info(ref: str) -> dict[str, Any]:
    sha, day, when, subject = git("show", "-s", "--format=%H%x00%cs%x00%cI%x00%s", ref).strip().split("\x00", 3)
    return {"git_sha": sha, "day": day, "committed_at": when, "subject": subject, "name": f"law-{day}-{sha[:7]}"}


def export_corpus(sha: str, dest: Path) -> tuple[Path, Path | None]:
    """The corpus files exactly as committed (git archive keeps the bytes, so the sha256s match)."""
    present = [p for p in CORPUS_PATHS if git("ls-tree", "--name-only", sha, p).strip()]
    data = subprocess.run(["git", "-C", str(REPO), "archive", "--format=tar", sha, *present], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(dest, filter="data")
    ir = dest / "rules" / "ir"
    return dest / "rules" / "verified", ir if ir.is_dir() else None


AHEAD = ("0004_law_versions", "0005_quote_search")


def apply_ahead(owner_url: str) -> list[str]:
    """Runs this branch's new migrations on a database without recording them in schema_migrations. Code that
    predates them refuses to start against a database that lists migrations it does not know, so production keeps
    its bookkeeping until the API from this branch migrates it with the owner URL. Both files are idempotent."""
    import psycopg

    from tend_api.db.base import migration_files

    files = {version: text for version, text, _ in migration_files("postgres")}
    with psycopg.connect(owner_url, connect_timeout=20, autocommit=True) as conn:
        recorded = {r[0] for r in conn.execute("SELECT version FROM public.schema_migrations").fetchall()}
        made = conn.execute(
            "SELECT to_regclass('public.law_versions') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_attribute"
            " WHERE attrelid = 'public.rules'::regclass AND attname = 'quote_search')"
        ).fetchone()[0]
        todo = [] if made else [v for v in AHEAD if v not in recorded]
        with conn.transaction():
            for version in todo:
                conn.execute(files[version])
    return todo


def bundles_at(sha: str) -> list[Any]:
    from tend_api.db import read_bundles

    with tempfile.TemporaryDirectory(prefix="tend-law-") as tmp:
        verified, ir = export_corpus(sha, Path(tmp))
        return read_bundles(verified, ir)
