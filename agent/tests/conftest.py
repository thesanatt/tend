from __future__ import annotations

import asyncio
import datetime as dt
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from fake_api import FakeTend  # noqa: E402

from tend_agent.api import TendApi  # noqa: E402
from tend_agent.config import Settings  # noqa: E402
from tend_agent.navigator import Navigator, Turn  # noqa: E402
from tend_agent.parse import Incoming  # noqa: E402

TODAY = dt.date(2026, 10, 3)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class Chat:
    """Drives the Navigator like a chat: keeps the session state between messages."""

    def __init__(self, nav: Navigator):
        self.nav = nav
        self.state: dict[str, Any] = {}
        self.turns: list[Turn] = []

    def say(self, text: str = "", selection: dict[str, Any] | None = None, cancelled: bool = False) -> Turn:
        turn = run(self.nav.handle(self.state, Incoming(text=text, selection=selection, cancelled=cancelled)))
        self.state = turn.state
        self.turns.append(turn)
        return turn


@pytest.fixture
def fake() -> FakeTend:
    return FakeTend()


@pytest.fixture
def make_chat(fake: FakeTend):
    def _make(f: FakeTend | None = None, **settings: Any) -> Chat:
        api = TendApi("http://tend.test", transport=(f or fake).transport())
        return Chat(Navigator(api, Settings(api_url="http://tend.test", **settings), today=lambda: TODAY))

    return _make


@pytest.fixture
def chat(make_chat) -> Chat:
    return make_chat()


def text_of(turn: Turn) -> str:
    return "\n".join(r.text for r in turn.replies)
