"""Three real uAgents (Navigator, Law, Bank+Packet) and a stand-in for ASI:One on one event loop, talking the Agent
Chat Protocol and the typed agent-to-agent messages through the uAgents dispatcher.

Fully offline: no mailbox, no endpoints, and Agentverse pointed at a closed local port, so registration and manifest
calls fail fast instead of reaching the internet.
"""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from conftest import SITE, TODAY, settings
from fake_api import CODE, FakeTend
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    MetadataContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import create_card_response_content

from tend_agent.agents import build_team, start_sub_agents
from tend_agent.api import TendApi
from tend_agent.config import seeds_from
from tend_agent.messages import LawAnswerRequest, LawReply
from tend_agent.navigator import Navigator
from tend_agent.share import open_sealed

DEAD = "http://127.0.0.1:9"
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning", "ignore::RuntimeWarning")


@dataclasses.dataclass
class World:
    loop: asyncio.AbstractEventLoop
    team: Any
    user: Agent
    fake: FakeTend
    inbox: list[ChatMessage]
    acks: list[ChatAcknowledgement]
    other: list[Any]

    async def say(self, *content: Any, settle: float = 0.3) -> list[ChatMessage]:
        """Send one message and collect every reply until the chat goes quiet."""
        before = len(self.inbox)
        await self.user._build_context().send(self.team.navigator.address, ChatMessage(content=list(content)))  # noqa: SLF001
        for _ in range(1500):
            if len(self.inbox) > before:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("no reply from the Navigator")
        count = -1
        while count != len(self.inbox):
            count = len(self.inbox)
            await asyncio.sleep(settle)
        return self.inbox[before:]


def text(msgs: list[ChatMessage]) -> str:
    return "\n".join(c.text for m in msgs for c in m.content if isinstance(c, TextContent))


def card_kinds(msgs: list[ChatMessage]) -> list[str]:
    return [c.metadata.get("card_kind") for m in msgs for c in m.content if isinstance(c, MetadataContent)]


class SlowTransport(httpx.AsyncBaseTransport):
    """The mocked API, with some paths that take a while (without blocking the event loop)."""

    def __init__(self, fake: FakeTend, slow: dict[str, float]):
        self.fake = fake
        self.slow = slow

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(self.slow.get(request.url.path, 0))
        return self.fake.handle(request)


def world(
    scenario: Callable[[World], Any],
    *,
    fake: FakeTend | None = None,
    slow: dict[str, float] | None = None,
    seed: str = "tend-team-test",
    **s: Any,
) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    fake = fake or FakeTend()
    st = settings(**{"port": 18071, **s})
    transport = SlowTransport(fake, slow) if slow else fake.transport()
    api = TendApi(st.api_url, transport=transport, retry_delay_s=0)
    nav = Navigator(None, st, today=lambda: TODAY, team=True)
    common = {"agentverse": DEAD, "loop": loop, "enable_agent_inspector": False}
    team = build_team(st, seeds_from(seed), api=api, navigator=nav, mailbox=False, **common)
    team.link.retry_pause_s = 0.05
    user = Agent(name="asi-one-stand-in", seed=f"{seed}-user", **common)
    inbox: list[ChatMessage] = []
    acks: list[ChatAcknowledgement] = []
    other: list[Any] = []
    proto = Protocol(spec=chat_protocol_spec)

    @proto.on_message(ChatMessage)
    async def on_reply(ctx: Context, sender: str, msg: ChatMessage) -> None:
        inbox.append(msg)
        await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))

    @proto.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        acks.append(msg)

    user.include(proto)
    direct = Protocol(name="test-direct", version="1.0.0")

    @direct.on_message(LawReply)
    async def on_law(ctx: Context, sender: str, msg: LawReply) -> None:
        other.append(msg)

    user.include(direct)
    w = World(loop, team, user, fake, inbox, acks, other)

    async def main() -> None:
        team.navigator.setup()
        start_sub_agents(team, st, servers=False)
        user.setup()
        await scenario(w)

    try:
        loop.run_until_complete(asyncio.wait_for(main(), 60))
    finally:
        tasks = [t for t in asyncio.all_tasks(loop) if not t.done()]
        for t in tasks:
            t.cancel()
        loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
        loop.run_until_complete(api.aclose())
        loop.close()
        asyncio.set_event_loop(None)


def test_the_whole_loop_in_one_chat_through_three_agents():
    async def scenario(w: World) -> None:
        team = w.team
        assert len({team.navigator.address, team.law.address, team.bank.address}) == 3
        hello = await w.say(StartSessionContent(), TextContent(text="hi"))
        assert "Three agents work on this" in text(hello) and card_kinds(hello) == ["detail"]

        check = await w.say(TextContent(text="check Michigan, June 14 2026, had an exam, not reported"))
        assert "apply by **June 14, 2031**" in text(check) and "MCL 18.355a(10)" in text(check)

        demo = await w.say(TextContent(text="show me the demo claim"))
        assert card_kinds(demo) == ["review"] and "$443.00" in text(demo)

        counted = await w.say(create_card_response_content(selection={"action": "count_costs"}))
        assert len(counted) == 2 and "**Amount Rowan Hale can ask for: $4,008.00. The program decides.**" in text(counted)
        assert "**Letter to the billing office.**" in text(counted) and "(MCL 18.355a(2))" in text(counted)

        review = await w.say(TextContent(text="pay the bill"))
        assert card_kinds(review) == ["review"] and CODE in text(review)
        assert w.fake.bodies("/api/actions/confirm") == []
        done = await w.say(TextContent(text=CODE))
        assert "**Done.** Paid $118.00" in text(done)

        shared = await w.say(create_card_response_content(selection={"action": "share"}))
        link = next(word for word in text(shared).split() if word.startswith(f"{SITE}/share#"))
        share_id, key = link.split("#", 1)[1].split(".")
        stored = w.fake.shares[share_id]
        packet = open_sealed(stored["ciphertext"], stored["iv"], key)
        assert packet["output"]["totals"]["held_cents"] == 32500
        assert len(w.acks) >= 7  # the Navigator acknowledged every message

        # Every API call came from the sub-agents: the Navigator itself never touched the API.
        paths = w.fake.paths()
        assert "/api/agent/check" in paths and "/api/actions/confirm" in paths and "/api/shares" in paths

    world(scenario)


def test_a_sub_agent_that_never_answers_gets_a_clear_fallback():
    async def scenario(w: World) -> None:
        w.team.link.addresses["law"] = "agent1qwyc2stbsn8pzj8wkdpz0uzrrgnwqnz94zxuvh05ewqk3lcd5ucvqd7qk4m"  # nobody is there
        out = await w.say(TextContent(text="What is the deadline to apply in Michigan?"), settle=0.2)
        assert "The Law agent isn't answering right now, so I can't look up the rules." in text(out)
        assert "no money moved" in text(out).lower()
        demo = await w.say(TextContent(text="show me the demo claim"))  # the other agent still works
        assert card_kinds(demo) == ["review"]

    world(scenario, law_timeout_s=0.5, attempts=2)


def test_a_slow_sub_agent_times_out_and_the_payment_is_never_reported_as_failed():
    async def scenario(w: World) -> None:
        await w.say(TextContent(text="demo"))
        await w.say(TextContent(text="yes"))
        await w.say(TextContent(text="pay the bill"))
        unsure = await w.say(TextContent(text=CODE), settle=0.5)
        assert "can't tell yet whether the payment went through" in text(unsure)
        assert "nothing can be paid twice" in text(unsure)
        await asyncio.sleep(1.5)  # the bank agent finished in the meantime
        status = await w.say(TextContent(text="check the payment"))
        assert "**Done.** Paid $118.00" in text(status)
        assert len(w.fake.bodies("/api/actions/confirm")) == 1  # the code went to the API once

    # The bank takes 1.2 s to confirm, longer than both attempts (0.4 s each): the Navigator stops waiting.
    world(scenario, slow={"/api/actions/confirm": 1.2}, bank_timeout_s=0.4, attempts=2)


def test_sub_agents_take_requests_from_the_navigator_only():
    async def scenario(w: World) -> None:
        ctx = w.user._build_context()  # noqa: SLF001
        await ctx.send(w.team.law.address, LawAnswerRequest(request_id="r1", st="MI", question="What is the deadline?"))
        for _ in range(300):
            if w.other:
                break
            await asyncio.sleep(0.01)
        assert w.other and w.other[0].ok is False and w.other[0].error == "not_allowed"
        assert "/api/agent/answer" not in w.fake.paths()

    world(scenario)
