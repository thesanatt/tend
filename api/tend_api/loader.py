"""Load the public law corpus (rules/verified + rules/ir) into the database, Neon by default.

usage (from api/):
  uv run python -m tend_api.loader                 # migrate, then load every jurisdiction that changed
  uv run python -m tend_api.loader --states MI,NY  # only these
  uv run python -m tend_api.loader --force         # reload even when the file hashes match
  uv run python -m tend_api.loader --no-images     # skip compiling law images for their hashes
  uv run python -m tend_api.loader --db sqlite:///tmp/tend.sqlite3

The database is chosen the way the API chooses it (TEND_DB, then DATABASE_URL_POOLED and
DATABASE_URL from the .env, which wins over the shell). Migrations run over the direct endpoint.
"""

from __future__ import annotations

import argparse
import sys
import time

from .config import Settings, load_env_file
from .db import describe_url, open_repository
from .engine import LawIR, NativeEngine
from .rulebook import Rulebook
from .rules import RulesStore
from .services import law_image_info


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", help="database URL or SQLite path (default: as the API picks it)")
    parser.add_argument("--schema", help="Postgres schema (default: TEND_DB_SCHEMA or public)")
    parser.add_argument("--states", help="comma-separated codes, e.g. MI,NY (default: all)")
    parser.add_argument("--force", action="store_true", help="reload even when nothing changed")
    parser.add_argument("--no-images", action="store_true", help="do not compile law images for their hashes")
    args = parser.parse_args(argv)

    load_env_file()
    settings = Settings.from_env()
    url = args.db or settings.database_url
    migrate_url = None if args.db else settings.migrate_url
    started = time.monotonic()
    repo = open_repository(url, schema=args.schema or settings.db_schema, migrate_url=migrate_url, migrate=False)
    applied = repo.migrate()
    print(f"database: {describe_url(url)}; migrations applied now: {', '.join(applied) or 'none'}")

    rules = RulesStore(settings.rules_dir)
    ir = LawIR(settings.ir_dir, rules)
    images, problems = None, []
    if not args.no_images:
        native = NativeEngine(settings.engine_lib, settings.law_dirs, settings.tendc, rules, settings.cache_dir, ir)
        status = native.status()
        if status["available"]:
            images = law_image_info(native, problems)
            print(f"engine: {status['version']}")
        else:
            print(f"engine: not available, so no image hashes this run ({status['reason'][:120]})")
    book = Rulebook(repo, rules, ir, images)
    states = [s.strip().upper() for s in args.states.split(",")] if args.states else None
    result = book.load(states, force=args.force)
    counts = result["counts"]
    print(f"loaded {len(result['loaded'])} jurisdictions, unchanged {len(result['unchanged'])}")
    print("rows: " + ", ".join(f"{table} {n}" for table, n in counts.items()))
    if problems:
        print(f"law images: {len(problems)} states could not be compiled by this engine build, for example {problems[0][:160]}")
    stale = book.stale()
    print(f"stale after load: {', '.join(stale) if stale else 'none'}; {time.monotonic() - started:.1f} s")
    repo.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
