"""Rehearse the demo chat against a running Tend API, the way a person would type it.

    uv run python scripts/rehearse.py                 # uses TEND_API_URL, default http://127.0.0.1:8000

The script reads the code off the review card and types it back, like the person would. It moves money only
through the API's propose and confirm endpoints (a dry run unless the API runs with TEND_BANK=nessie).
"""

from __future__ import annotations

import asyncio
import os
import re
import sys

from tend_agent.api import TendApi
from tend_agent.config import Settings
from tend_agent.navigator import Navigator
from tend_agent.parse import Incoming

SCRIPT = [
    "hi",
    "What is the deadline to apply in Ohio?",
    "Does Michigan cover counseling, and is there a limit?",
    "check Michigan, June 14 2026, had an exam, not reported",
    "show me the demo claim",
    "yes",
    "pay the bill",
    "{code}",
]


async def main() -> int:
    settings = Settings(api_url=os.environ.get("TEND_API_URL", "http://127.0.0.1:8000").rstrip("/"))
    api = TendApi(settings.api_url, timeout=settings.timeout_s)
    nav = Navigator(api, settings)
    state: dict = {}
    code = ""
    try:
        for line in SCRIPT:
            text = line.format(code=code)
            print(f"\n**You:** {text}\n")
            turn = await nav.handle(state, Incoming(text=text))
            state = turn.state
            for reply in turn.replies:
                print(f"**Tend Navigator:** {reply.text}")
                if reply.card is not None:
                    print(f"\n_[{type(reply.card).__name__.replace('CardPayload', '')} card: {reply.card.title}]_")  # type: ignore[attr-defined]
                found = re.search(r"type \*\*(\d{6})\*\*", reply.text)
                code = found.group(1) if found else code
    finally:
        await api.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
