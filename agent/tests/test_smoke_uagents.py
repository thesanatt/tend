"""Two real uAgents on one event loop, talking the Agent Chat Protocol through the uAgents dispatcher.

Fully offline: no mailbox, no endpoints, and Agentverse pointed at a closed local port, so the status and
manifest calls fail fast instead of reaching the internet.
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import TODAY
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

from tend_agent.agent import build_agent
from tend_agent.api import TendApi
from tend_agent.config import Settings
from tend_agent.navigator import Navigator

DEAD = "http://127.0.0.1:9"


@pytest.mark.filterwarnings("ignore::DeprecationWarning")
def test_chat_protocol_round_trip_with_cards_and_a_typed_code():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    f = FakeTend()
    api = TendApi("http://tend.test", transport=f.transport())
    nav = Navigator(api, Settings(api_url="http://tend.test"), today=lambda: TODAY)
    tend = build_agent(
        Settings(api_url="http://tend.test", port=18071),
        "tend-navigator-smoke-seed",
        navigator=nav,
        api=api,
        mailbox=False,
        agentverse=DEAD,
        loop=loop,
        enable_agent_inspector=False,
    )
    user = Agent(name="smoke-user", seed="tend-navigator-smoke-user", agentverse=DEAD, loop=loop, enable_agent_inspector=False)
    inbox: list[ChatMessage] = []
    acks: list[ChatAcknowledgement] = []
    proto = Protocol(spec=chat_protocol_spec)

    @proto.on_message(ChatMessage)
    async def on_reply(ctx: Context, sender: str, msg: ChatMessage) -> None:
        inbox.append(msg)
        await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))

    @proto.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        acks.append(msg)

    user.include(proto)

    async def say(*content) -> ChatMessage:
        before = len(inbox)
        await user._build_context().send(tend.address, ChatMessage(content=list(content)))  # noqa: SLF001
        for _ in range(200):
            if len(inbox) > before:
                return inbox[-1]
            await asyncio.sleep(0.02)
        raise AssertionError("no reply from the agent")

    def text(msg: ChatMessage) -> str:
        return " ".join(c.text for c in msg.content if isinstance(c, TextContent))

    def card_kind(msg: ChatMessage) -> str | None:
        meta = next((c for c in msg.content if isinstance(c, MetadataContent)), None)
        return meta.metadata.get("card_kind") if meta else None

    async def scenario() -> None:
        tend.setup()
        user.setup()
        answer = await say(StartSessionContent(), TextContent(text="What is the deadline in Michigan?"))
        assert "MCL 18.355(2)" in text(answer)
        demo = await say(TextContent(text="show me the demo claim"))
        assert card_kind(demo) == "review"
        counted = await say(create_card_response_content(selection={"action": "count_costs"}))
        assert "$2,760.00" in text(counted)
        review = await say(TextContent(text="pay the bill"))
        assert card_kind(review) == "review" and CODE in text(review)
        assert f.bodies("/api/actions/confirm") == []
        done = await say(TextContent(text=CODE))
        assert text(done).startswith("**Done.**")
        assert len(acks) >= 5  # the agent acknowledged every message

    try:
        loop.run_until_complete(asyncio.wait_for(scenario(), 30))
    finally:
        tasks = [t for t in asyncio.all_tasks(loop) if not t.done()]
        for t in tasks:
            t.cancel()
        loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
        loop.close()
        asyncio.set_event_loop(None)
