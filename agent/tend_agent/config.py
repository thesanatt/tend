"""Settings and secrets. The repo .env wins over the shell (the shell may export stale keys)."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
AGENT_NAME = "Tend Navigator"
DESCRIPTION = (
    "Cited answers about crime victim compensation for sexual assault survivors in all 50 states and DC, "
    "a 2-minute eligibility Check, and a walkthrough of a fictional demo claim with a confirm-coded mock payment. "
    "No account, no name, no story."
)


def find_env_file() -> Path | None:
    """TEND_ENV_FILE if set, else the nearest .env at or above the repo root (worktrees sit below the main checkout)."""
    explicit = os.environ.get("TEND_ENV_FILE")
    if explicit == "":
        return None
    if explicit:
        return Path(explicit).expanduser()
    return next((d / ".env" for d in (REPO_ROOT, *REPO_ROOT.parents) if (d / ".env").is_file()), None)


def load_env(path: Path | None = None) -> Path | None:
    from dotenv import load_dotenv

    path = path or find_env_file()
    if path is not None and path.is_file():
        load_dotenv(path, override=True)
        return path
    return None


def ensure_seed(env_path: Path | None) -> bool:
    """Make sure AGENT_SEED exists. Creates one and appends it to the .env file if missing.

    Returns True when a new seed was written. The seed itself is never printed or logged.
    """
    if os.environ.get("AGENT_SEED", "").strip():
        return False
    target = env_path or (REPO_ROOT / ".env")
    seed = secrets.token_hex(32)
    existing = target.read_bytes() if target.is_file() else b""
    prefix = b"" if not existing or existing.endswith(b"\n") else b"\n"
    with open(target, "ab") as f:
        f.write(prefix + f"AGENT_SEED={seed}\n".encode())
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass
    os.environ["AGENT_SEED"] = seed
    return True


def inspector_url(address: str, port: int, agentverse: str = "https://agentverse.ai") -> str:
    # Same link uAgents logs at startup; opening it lets you connect the mailbox on Agentverse.
    return f"{agentverse}/inspect/?uri={quote(f'http://127.0.0.1:{port}')}&address={address}"


@dataclass(frozen=True)
class Settings:
    api_url: str = "http://127.0.0.1:8000"
    port: int = 8001
    handle: str | None = None
    app_url: str = ""  # public web app, for "open this in Tend" links
    demo_persona: str = "rowan-mi"
    agent_key: str = ""
    timeout_s: float = 30.0

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            api_url=os.environ.get("TEND_API_URL", cls.api_url).rstrip("/"),
            port=int(os.environ.get("AGENT_PORT", cls.port)),
            handle=os.environ.get("AGENT_HANDLE") or None,
            app_url=os.environ.get("TEND_PUBLIC_URL", "").rstrip("/"),
            demo_persona=os.environ.get("TEND_DEMO_PERSONA", cls.demo_persona),
            agent_key=os.environ.get("TEND_AGENT_KEY", ""),
            timeout_s=float(os.environ.get("TEND_API_TIMEOUT", cls.timeout_s)),
        )
