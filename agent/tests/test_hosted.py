"""hosted/navigator_hosted.py: up to date, only imports Agentverse allows, and the whole loop works the way Agentverse
runs it (every message a fresh run, session state only in the agent's storage)."""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest
import uagents
from fake_api import CODE, FakeTend
from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent
from uagents_core.contrib.protocols.chat.cards import create_card_response_content

from tend_agent.share import open_sealed

AGENT_DIR = Path(__file__).resolve().parents[1]
HOSTED = AGENT_DIR / "hosted" / "navigator_hosted.py"
ALLOWED = {"uagents", "uagents_core", "httpx", "pydantic", "Crypto", "cryptography"}


def build_script():
    spec = importlib.util.spec_from_file_location("build_hosted", AGENT_DIR / "scripts" / "build_hosted.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def test_the_hosted_file_is_built_from_the_current_code():
    assert HOSTED.read_text() == build_script().build(), "run: uv run python scripts/build_hosted.py"


def test_only_imports_agentverse_allows():
    tree = ast.parse(HOSTED.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            assert node.level == 0, "a relative import survived the bundle"
            roots = [(node.module or "").split(".")[0]]
        elif isinstance(node, ast.Import):
            roots = [a.name.split(".")[0] for a in node.names]
        else:
            continue
        for root in roots:
            assert root in ALLOWED or root in sys.stdlib_module_names or root == "__future__", root
    text = HOSTED.read_text()
    assert 'TEND_API_URL = "https://youreowed.tech"' in text and "agent = Agent()" in text
    assert "\u2014" not in text and "\u2013" not in text


class Storage:
    """Agentverse keeps ctx.storage between runs; it is JSON."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str) -> Any:
        return json.loads(self.data[key]) if key in self.data else None

    def set(self, key: str, value: Any) -> None:
        self.data[key] = json.dumps(value)

    def remove(self, key: str) -> None:
        self.data.pop(key, None)


class Ctx:
    def __init__(self, storage: Storage) -> None:
        import logging

        self.storage = storage
        self.sent: list[Any] = []
        self.logger = logging.getLogger("hosted-test")

    async def send(self, destination: str, message: Any, timeout: int = 30) -> None:
        self.sent.append(message)


class HostedAgent:
    """Stands in for the Agent() Agentverse provides."""

    def __init__(self, *a: Any, **kw: Any) -> None:
        self.protocols: list[tuple[Any, bool]] = []

    def include(self, protocol: Any, publish_manifest: bool = False) -> None:
        self.protocols.append((protocol, publish_manifest))


@pytest.fixture
def hosted(monkeypatch):
    """A fresh run of the hosted file for every message, like Agentverse, against the mocked API."""
    monkeypatch.setattr(uagents, "Agent", HostedAgent)
    fake = FakeTend()

    def fresh_run() -> dict[str, Any]:
        spec = importlib.util.spec_from_file_location("tend_hosted_run", HOSTED)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        real = module.TendApi

        class Mocked(real):  # type: ignore[misc, valid-type]
            def __init__(self, base_url: str, **kw: Any) -> None:
                kw.pop("transport", None)
                super().__init__(base_url, transport=fake.transport(), retry_delay_s=0, **kw)

        module.TendApi = Mocked
        return vars(module)

    return fake, fresh_run


def test_the_whole_loop_runs_hosted(hosted):
    fake, fresh_run = hosted
    storage = Storage()

    def say(*content: Any) -> list[ChatMessage]:
        ns = fresh_run()
        agent = ns["agent"]
        [(chat, published)] = agent.protocols
        assert published is True
        handler = next(iter(h for d, h in chat.signed_message_handlers.items() if chat.models[d] is ChatMessage))
        ctx = Ctx(storage)
        asyncio.run(handler(ctx, "agent1qasioneuser", ChatMessage(content=list(content))))
        return [m for m in ctx.sent if isinstance(m, ChatMessage)]

    def text(msgs: list[ChatMessage]) -> str:
        return "\n".join(c.text for m in msgs for c in m.content if isinstance(c, TextContent))

    def kinds(msgs: list[ChatMessage]) -> list[str]:
        return [c.metadata.get("card_kind") for m in msgs for c in m.content if isinstance(c, MetadataContent)]

    hello = say(TextContent(text="hi"))
    assert "I never ask for your name" in text(hello) and kinds(hello) == ["detail"]
    assert "MCL 18.355(2)" in text(say(TextContent(text="What is the deadline to apply in Michigan?")))
    assert kinds(say(TextContent(text="show me the demo claim"))) == ["review"]
    counted = say(create_card_response_content(selection={"action": "count_costs"}))
    assert "$4,008.00. The program decides." in text(counted) and "(MCL 18.355a(2))" in text(counted)
    review = say(TextContent(text="pay the bill"))
    assert CODE in text(review) and CODE not in json.dumps(storage.data)
    assert "**Done.** Paid $118.00" in text(say(TextContent(text=CODE)))
    shared = text(say(TextContent(text="share with an advocate")))
    link = next(word for word in shared.split() if word.startswith("https://youreowed.tech/share#"))
    share_id, key = link.split("#", 1)[1].split(".")
    assert open_sealed(fake.shares[share_id]["ciphertext"], fake.shares[share_id]["iv"], key)["st"] == "MI"
    assert key not in json.dumps(storage.data)
    assert fake.bodies("/api/actions/confirm") == [{"action_id": "act_00000000000000000001", "confirm_code": CODE}]
