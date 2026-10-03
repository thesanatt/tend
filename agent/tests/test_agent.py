from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import pytest
from conftest import TODAY, run
from fake_api import CODE, FakeTend
from uagents import Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import create_card_response_content, extract_card

from tend_agent.agent import build_agent, handle_chat, incoming_from, startup_lines, to_chat
from tend_agent.api import TendApi
from tend_agent.config import AGENT_NAME, Settings
from tend_agent.navigator import Navigator, Reply, Sessions

SENDER = "agent1qtestsenderaddress"


class FakeCtx:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []
        self.logs: list[str] = []
        self.logger = logging.getLogger("fake-ctx")
        self.logger.info = self.logs.append  # type: ignore[method-assign]
        self.logger.error = self.logs.append  # type: ignore[method-assign]

    async def send(self, destination: str, message: Any) -> None:
        self.sent.append((destination, message))


def chat_msg(*content: Any) -> ChatMessage:
    return ChatMessage(content=list(content))


def replies(ctx: FakeCtx) -> list[ChatMessage]:
    return [m for _, m in ctx.sent if isinstance(m, ChatMessage)]


def reply_text(m: ChatMessage) -> str:
    return " ".join(c.text for c in m.content if isinstance(c, TextContent))


def make(f: FakeTend | None = None) -> tuple[Navigator, Sessions, FakeTend]:
    f = f or FakeTend()
    api = TendApi("http://tend.test", transport=f.transport())
    return Navigator(api, Settings(api_url="http://tend.test"), today=lambda: TODAY), Sessions(), f


def test_incoming_text_and_session_markers():
    m = incoming_from(chat_msg(StartSessionContent(), TextContent(text="  hi ")))
    assert m.text == "hi" and m.start and m.selection is None
    assert incoming_from(chat_msg(StartSessionContent())).empty
    assert incoming_from(chat_msg(EndSessionContent())).end


def test_incoming_card_click_as_metadata():
    card_id = uuid.uuid4()
    m = incoming_from(chat_msg(create_card_response_content(card_id=card_id, selection={"action": "pay_confirm", "code": CODE})))
    assert m.selection == {"action": "pay_confirm", "code": CODE} and m.card_id == str(card_id)
    gone = incoming_from(chat_msg(create_card_response_content(cancelled=True)))
    assert gone.cancelled and not gone.empty


def test_incoming_card_click_as_json_text_from_a_direct_mention():
    m = incoming_from(chat_msg(TextContent(text='{"action": "count_costs", "scan_id": "scan_1"}')))
    assert m.selection == {"action": "count_costs", "scan_id": "scan_1"} and m.text == ""


def test_incoming_ignores_other_metadata_and_caps_length():
    m = incoming_from(chat_msg(MetadataContent(metadata={"mime_type": "text/plain"}), TextContent(text="x" * 5000)))
    assert m.selection is None and len(m.text) == 2000


def test_to_chat_carries_a_valid_card_and_end_session():
    from tend_agent import cards

    msg = to_chat(Reply("Pick", card=cards.welcome_card(), card_id=str(uuid.uuid4()), end_session=True))
    meta = next(c for c in msg.content if isinstance(c, MetadataContent))
    assert extract_card(meta) is not None and meta.metadata["card_kind"] == "detail"
    assert isinstance(msg.content[-1], EndSessionContent)
    plain = to_chat(Reply("Just text"))
    assert [type(c) for c in plain.content] == [TextContent]


def test_handle_chat_acks_first_then_replies_and_logs_no_text():
    nav, sessions, _ = make()
    ctx = FakeCtx()
    secret_words = "What is the deadline in Michigan?"
    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text=secret_words)), nav, sessions))
    assert isinstance(ctx.sent[0][1], ChatAcknowledgement)
    out = replies(ctx)
    assert len(out) == 1 and "MCL 18.355(2)" in reply_text(out[0])
    assert all(dest == SENDER for dest, _ in ctx.sent)
    assert ctx.logs == ["turn intent=answer replies=1 cards=0"]
    assert secret_words not in json.dumps(sessions.get(SENDER))


def test_handle_chat_runs_the_whole_payment_flow_per_sender():
    nav, sessions, f = make()
    ctx = FakeCtx()
    for text in ("demo", "yes", "pay the bill"):
        run(handle_chat(ctx, SENDER, chat_msg(TextContent(text=text)), nav, sessions))
    review = replies(ctx)[-1]
    meta = next(c for c in review.content if isinstance(c, MetadataContent))
    assert meta.metadata["card_kind"] == "review" and CODE in reply_text(review)
    # someone else typing the code in their own chat cannot approve this payment
    run(handle_chat(ctx, "agent1qsomeoneelse", chat_msg(TextContent(text=CODE)), nav, sessions))
    assert f.bodies("/api/actions/confirm") == []
    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text=CODE)), nav, sessions))
    assert f.bodies("/api/actions/confirm") == [{"action_id": "act_00000000000000000001", "confirm_code": CODE}]
    done = replies(ctx)[-1]
    assert reply_text(done).startswith("**Done.**") and isinstance(done.content[-1], EndSessionContent)


def test_handle_chat_end_session_clears_state_and_errors_stay_private():
    nav, sessions, _ = make()
    ctx = FakeCtx()
    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text="demo")), nav, sessions))
    assert sessions.get(SENDER)
    run(handle_chat(ctx, SENDER, chat_msg(EndSessionContent()), nav, sessions))
    assert sessions.get(SENDER) == {}

    class Boom(Navigator):
        async def handle(self, state, msg):  # type: ignore[override]
            raise RuntimeError("secret detail")

    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text="hi")), Boom(nav.api, nav.settings), sessions))
    assert "Nothing was saved and no money moved" in reply_text(replies(ctx)[-1])
    assert "secret detail" not in " ".join(ctx.logs) and "turn failed: RuntimeError" in ctx.logs


def test_sessions_expire_and_live_only_in_memory():
    clock = [0.0]
    s = Sessions(ttl_s=10, now=lambda: clock[0])
    s.put("a", {"st": "MI"})
    assert s.get("a") == {"st": "MI"}
    clock[0] = 11
    assert s.get("a") == {}


@pytest.mark.filterwarnings("ignore:coroutine 'Agent.publish_manifest' was never awaited")
def test_build_agent_speaks_the_chat_protocol_with_a_mailbox():
    import asyncio

    loop = asyncio.new_event_loop()  # earlier tests closed theirs; the agent is only built here, never run
    agent = build_agent(Settings(port=8091), "tend-navigator-test-seed-not-a-secret", loop=loop)
    again = build_agent(Settings(port=8092), "tend-navigator-test-seed-not-a-secret", loop=loop)
    loop.close()
    assert agent.address == again.address and agent.address.startswith("agent1q")
    assert agent.name == AGENT_NAME
    assert Protocol(spec=chat_protocol_spec).digest in agent.protocols
    assert agent._use_mailbox  # noqa: SLF001
    assert agent._message_history is None  # noqa: SLF001 - no copy of message text kept for the Inspector
    assert "innovationlab" in (agent._readme or "") and "hackathon" in (agent._readme or "")  # noqa: SLF001
    lines = startup_lines(agent.address, Settings(port=8091))
    assert any(
        line.strip().startswith("Inspector: https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A8091&address=agent1q") for line in lines
    )
