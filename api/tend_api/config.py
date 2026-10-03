from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parent


def load_env_file() -> Path | None:
    """Load secrets from TEND_ENV_FILE, or the nearest .env above the repo. Never overrides set vars."""
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

    load_dotenv(path, override=False)
    return path


def _path(var: str, default: Path) -> Path:
    value = os.environ.get(var)
    return Path(value).expanduser() if value else default


def _flag(var: str, default: bool = False) -> bool:
    value = os.environ.get(var)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _lib_name() -> str:
    return "libtend.dylib" if sys.platform == "darwin" else "libtend.so"


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
    db_path: str
    bank_mode: str = "dry_run"  # "dry_run" or "nessie"; live writes only when set explicitly
    live_scan: bool = False  # allow /scan by customer_id to call Nessie when no snapshot matches
    public_url: str = ""
    cors_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    secret_hex: str = ""

    @classmethod
    def from_env(cls) -> Settings:
        build = _path("TEND_ENGINE_BUILD", REPO_ROOT / "engine" / "build")
        law_dir = os.environ.get("TEND_LAW_DIR")
        law_dirs = (Path(law_dir),) if law_dir else (build / "laws", REPO_ROOT / "build" / "laws")
        origins = os.environ.get("TEND_CORS_ORIGINS")
        bank_mode = os.environ.get("TEND_BANK", "dry_run").strip().lower()
        if bank_mode not in {"dry_run", "nessie"}:
            raise ValueError(f"TEND_BANK must be dry_run or nessie, got {bank_mode!r}")
        return cls(
            rules_dir=_path("TEND_RULES_DIR", REPO_ROOT / "rules" / "verified"),
            seed_dir=_path("TEND_SEED_DIR", REPO_ROOT / "seed"),
            engine_lib=_path("TEND_ENGINE_LIB", build / _lib_name()),
            law_dirs=law_dirs,
            tendc=_path("TEND_TENDC", build / "tendc"),
            refengine_dir=_path("TEND_REFENGINE_DIR", REPO_ROOT / "refengine"),
            forms_dir=_path("TEND_FORMS_DIR", API_DIR / "forms"),
            cache_dir=_path("TEND_CACHE_DIR", API_DIR / ".cache"),
            db_path=os.environ.get("TEND_DB", str(API_DIR / ".data" / "tend.sqlite3")),
            bank_mode=bank_mode,
            live_scan=_flag("TEND_LIVE_SCAN"),
            public_url=os.environ.get("TEND_PUBLIC_URL", "").rstrip("/"),
            cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()) if origins else cls.cors_origins,
            secret_hex=os.environ.get("TEND_SECRET", ""),
        )
