"""Settings shared by every Tend agent. Plain values only, so the Agentverse-hosted build can set them from constants."""

from __future__ import annotations

import os
from dataclasses import dataclass

PUBLIC_SITE = "https://youreowed.tech"


def _flag(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    api_url: str = "http://127.0.0.1:8000"
    app_url: str = ""  # the Tend web app; share links open there (default: the API's own origin)
    port: int = 8001
    handle: str | None = None
    demo_persona: str = "rowan-mi"
    agent_key: str = ""
    timeout_s: float = 30.0
    share_hours: int = 72
    # Navigator -> sub-agent calls: seconds per attempt and how many attempts before the fallback message.
    law_timeout_s: float = 15.0
    bank_timeout_s: float = 25.0
    attempts: int = 2
    subagent_mailbox: bool = False  # also list the Law and Bank agents on Agentverse (connect each once)

    @property
    def share_origin(self) -> str:
        """Where an advocate opens a share link. The web app and the API share one origin in production."""
        return (self.app_url or self.api_url).rstrip("/")

    @property
    def app_origin(self) -> str:
        """The web app to point people at after a Check: TEND_PUBLIC_URL, or the API's origin unless it is local."""
        if self.app_url:
            return self.app_url.rstrip("/")
        local = any(host in self.api_url for host in ("127.0.0.1", "localhost"))
        return "" if local else self.api_url.rstrip("/")

    @classmethod
    def from_env(cls) -> "Settings":  # noqa: UP037 - quoted: the hosted build evaluates annotations eagerly
        env = os.environ
        return cls(
            api_url=env.get("TEND_API_URL", cls.api_url).rstrip("/"),
            app_url=env.get("TEND_PUBLIC_URL", "").rstrip("/"),
            port=int(env.get("AGENT_PORT", cls.port)),
            handle=env.get("AGENT_HANDLE") or None,
            demo_persona=env.get("TEND_DEMO_PERSONA", cls.demo_persona),
            agent_key=env.get("TEND_AGENT_KEY", ""),
            timeout_s=float(env.get("TEND_API_TIMEOUT", cls.timeout_s)),
            share_hours=int(env.get("TEND_SHARE_HOURS", cls.share_hours)),
            law_timeout_s=float(env.get("TEND_LAW_TIMEOUT", cls.law_timeout_s)),
            bank_timeout_s=float(env.get("TEND_BANK_TIMEOUT", cls.bank_timeout_s)),
            attempts=max(1, int(env.get("TEND_AGENT_ATTEMPTS", cls.attempts))),
            subagent_mailbox=_flag(env.get("TEND_SUBAGENT_MAILBOX")),
        )
