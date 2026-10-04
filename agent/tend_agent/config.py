"""Local settings and secrets. The repo .env wins over the shell (the shell may export stale keys).

AGENT_SEED fixes the Navigator's address. The Law and Bank+Packet agents' seeds are derived from it, so all three
addresses stay the same on every run and no new secret is needed. No seed is ever printed or logged.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from .settings import Settings

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
AGENT_NAME = "Tend Navigator"
LAW_NAME = "Tend Law"
BANK_NAME = "Tend Bank and Packet"
DESCRIPTION = (
    "Cited answers about crime victim compensation for sexual assault survivors in all 50 states and DC, a 2-minute "
    "eligibility Check, and a fictional demo claim run end to end: a bill line held under the law, a mock payment "
    "approved with a typed code, and an encrypted link for an advocate. No account, no name, no story."
)
LAW_DESCRIPTION = "Tend's Law agent: cited answers and Checks from verified crime victim compensation rules for 50 states and DC."
BANK_DESCRIPTION = "Tend's Bank and Packet agent: runs Tend's fictional demo claim on a mock bank and seals packets for advocates."

__all__ = ["Settings", "Seeds", "ensure_seed", "find_env_file", "inspector_url", "load_env", "seeds_from"]


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


@dataclass(frozen=True)
class Seeds:
    navigator: str
    law: str
    bank: str


def seeds_from(seed: str) -> Seeds:
    """The Navigator keeps AGENT_SEED itself; each sub-agent gets a seed derived from it with its own label."""

    def derive(label: str) -> str:
        return hashlib.sha256(f"tend-agent/{label}/{seed}".encode()).hexdigest()

    return Seeds(navigator=seed, law=derive("law"), bank=derive("bank"))


def inspector_url(address: str, port: int, agentverse: str = "https://agentverse.ai") -> str:
    # Same link uAgents logs at startup; opening it lets you connect the mailbox on Agentverse.
    return f"{agentverse}/inspect/?uri={quote(f'http://127.0.0.1:{port}')}&address={address}"
