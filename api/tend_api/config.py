from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parent
DEFAULT_SQLITE = API_DIR / ".data" / "tend.sqlite3"


def load_env_file() -> Path | None:
    """Load secrets from TEND_ENV_FILE, or the nearest .env above the repo.

    The file wins over the shell: a stale GEMINI_API_KEY exported in a shell profile once shadowed
    the working key and every model call failed. TEND_ENV_FILE="" turns the file off.
    """
    explicit = os.environ.get("TEND_ENV_FILE")
    if explicit == "":
        return None
    if explicit:
        path: Path | None = Path(explicit)
    else:
        path = next((d / ".env" for d in (REPO_ROOT, *REPO_ROOT.parents) if (d / ".env").is_file()), None)
    if path is None or not path.is_file():
        return None
    from dotenv import load_dotenv

    load_dotenv(path, override=True)
    return path


def _path(var: str, default: Path) -> Path:
    value = os.environ.get(var)
    return Path(value).expanduser() if value else default


def _flag(var: str, default: bool = False) -> bool:
    value = os.environ.get(var)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _lib_name() -> str:
    return "libtend.dylib" if sys.platform == "darwin" else "libtend.so"


def database_from_env() -> tuple[str, str | None]:
    """(url the app uses, url migrations use). TEND_DB picks: a SQLite path, ":memory:", a postgres URL,
    or "neon", which is also the default whenever DATABASE_URL_APP, DATABASE_URL_POOLED, or DATABASE_URL is set.
    DATABASE_URL_APP is the least-privilege tend_app role (docs/NEON.md); DATABASE_URL stays the owner, for migrations."""
    choice = os.environ.get("TEND_DB", "").strip()
    app = os.environ.get("DATABASE_URL_APP", "").strip()
    pooled = os.environ.get("DATABASE_URL_POOLED", "").strip()
    direct = os.environ.get("DATABASE_URL", "").strip()
    if choice.startswith(("postgres://", "postgresql://")):
        return choice, direct or None
    if choice in ("", "neon", "postgres"):
        if app or pooled or direct:
            return app or pooled or direct, direct or None
        if choice:
            raise ValueError(f"TEND_DB={choice} needs DATABASE_URL or DATABASE_URL_POOLED")
        return str(DEFAULT_SQLITE), None
    return choice, None


@dataclass(frozen=True)
class Settings:
    rules_dir: Path
    seed_dir: Path
    engine_lib: Path
    law_dirs: tuple[Path, ...]
    tendc: Path
    refengine_dir: Path
    forms_dir: Path
    cache_dir: Path
    database_url: str  # postgresql://... (Neon) or a SQLite path; ":memory:" for throwaway runs
    migrate_url: str | None = None  # Neon's direct endpoint for migrations; the pooled one serves requests
    reader_url: str | None = None  # the SELECT-only tend_reader role for public corpus reads and law branches (Neon)
    migrate: bool = True  # TEND_MIGRATE=0: start without running migrations (a deploy whose role cannot run DDL)
    db_schema: str = "public"
    bank_mode: str = "dry_run"  # "dry_run" or "nessie"; live writes only when set explicitly
    relay_live: bool = False  # the bank relay reads live Nessie, falling back to the snapshot
    live_scan: bool = False  # /scan by customer_id may call Nessie when no snapshot matches
    public_url: str = ""
    cors_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    secret_hex: str = ""
    ir_dir: Path | None = None  # rules/ir, the law IR both engines read (SPEC v1.1)
    gemini_api_key: str = ""  # cloud AI, only when a request carries consent: true; empty turns it off
    autoload_corpus: bool = True  # SQLite only: load rules/verified into the database at startup when empty

    @classmethod
    def from_env(cls) -> Settings:
        build = _path("TEND_ENGINE_BUILD", REPO_ROOT / "engine" / "build")
        law_dir = os.environ.get("TEND_LAW_DIR")
        law_dirs = (Path(law_dir),) if law_dir else (build / "laws", REPO_ROOT / "build" / "laws")
        origins = os.environ.get("TEND_CORS_ORIGINS")
        bank_mode = os.environ.get("TEND_BANK", "dry_run").strip().lower()
        if bank_mode not in {"dry_run", "nessie"}:
            raise ValueError(f"TEND_BANK must be dry_run or nessie, got {bank_mode!r}")
        database_url, migrate_url = database_from_env()
        return cls(
            rules_dir=_path("TEND_RULES_DIR", REPO_ROOT / "rules" / "verified"),
            seed_dir=_path("TEND_SEED_DIR", REPO_ROOT / "seed"),
            engine_lib=_path("TEND_ENGINE_LIB", build / _lib_name()),
            law_dirs=law_dirs,
            tendc=_path("TEND_TENDC", build / "tendc"),
            refengine_dir=_path("TEND_REFENGINE_DIR", REPO_ROOT / "refengine"),
            forms_dir=_path("TEND_FORMS_DIR", API_DIR / "forms"),
            cache_dir=_path("TEND_CACHE_DIR", API_DIR / ".cache"),
            database_url=database_url,
            migrate_url=migrate_url,
            reader_url=(os.environ.get("DATABASE_URL_READER", "").strip() or None) if database_url.startswith("postgres") else None,
            migrate=_flag("TEND_MIGRATE", default=True),
            db_schema=os.environ.get("TEND_DB_SCHEMA", "public").strip() or "public",
            bank_mode=bank_mode,
            relay_live=_flag("TEND_RELAY_LIVE", default=bool(os.environ.get("NESSIE_API_KEY"))),
            live_scan=_flag("TEND_LIVE_SCAN"),
            public_url=os.environ.get("TEND_PUBLIC_URL", "").rstrip("/"),
            cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()) if origins else cls.cors_origins,
            secret_hex=os.environ.get("TEND_SECRET", ""),
            ir_dir=_path("TEND_IR_DIR", REPO_ROOT / "rules" / "ir"),
            gemini_api_key=os.environ.get("GEMINI_API_KEY", "").strip() if _flag("TEND_CLOUD_AI", default=True) else "",
        )
