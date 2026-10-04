"""The Agent Chat Protocol glue: what comes in, what goes out, and what reaches the logs (the kind of turn only)."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from conftest import TODAY, desks_for, run, settings
from fake_api import CODE, FakeTend
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
)
from uagents_core.contrib.protocols.chat.cards import create_card_response_content, extract_card

from tend_agent import cards
from tend_agent.chat import handle_chat, incoming_from, to_chat
from tend_agent.navigator import Navigator, Reply
from tend_agent.sessions import MemorySessions

SENDER = "agent1qtestsenderaddress"


class FakeCtx:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []
        self.logs: list[str] = []
        self.logger = logging.getLogger("fake-ctx")
        self.logger.info = self.logs.append  # type: ignore[method-assign]
        self.logger.error = self.logs.append  # type: ignore[method-assign]

    async def send(self, destination: str, message: Any, timeout: int = 30) -> None:
        self.sent.append((destination, message))


def chat_msg(*content: Any) -> ChatMessage:
    return ChatMessage(content=list(content))


def replies(ctx: FakeCtx) -> list[ChatMessage]:
    return [m for _, m in ctx.sent if isinstance(m, ChatMessage)]


def reply_text(m: ChatMessage) -> str:
    return " ".join(c.text for c in m.content if isinstance(c, TextContent))


def make(f: FakeTend | None = None) -> tuple[Navigator, MemorySessions, FakeTend]:
    f = f or FakeTend()
    desks, _ = desks_for(f)
    return Navigator(desks, settings(), today=lambda: TODAY), MemorySessions(), f


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
    msg = to_chat(Reply("Pick", card=cards.welcome_card(), card_id=str(uuid.uuid4()), end_session=True))
    meta = next(c for c in msg.content if isinstance(c, MetadataContent))
    assert extract_card(meta) is not None and meta.metadata["card_kind"] == "detail"
    assert isinstance(msg.content[-1], EndSessionContent)
    assert [type(c) for c in to_chat(Reply("Just text")).content] == [TextContent]


def test_handle_chat_acks_first_then_replies_and_logs_no_text():
    nav, sessions, _ = make()
    ctx = FakeCtx()
    secret_words = "What is the deadline to apply in Michigan?"
    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text=secret_words)), nav, sessions))
    assert isinstance(ctx.sent[0][1], ChatAcknowledgement)
    out = replies(ctx)
    assert len(out) == 1 and "MCL 18.355(2)" in reply_text(out[0])
    assert all(dest == SENDER for dest, _ in ctx.sent)
    assert ctx.logs == ["turn intent=answer replies=1 cards=0"]
    assert secret_words not in json.dumps(sessions.get(SENDER))


def test_a_code_typed_in_someone_elses_chat_does_nothing():
    nav, sessions, f = make()
    ctx = FakeCtx()
    for text in ("demo", "yes", "pay the bill"):
        run(handle_chat(ctx, SENDER, chat_msg(TextContent(text=text)), nav, sessions))
    review = replies(ctx)[-1]
    meta = next(c for c in review.content if isinstance(c, MetadataContent))
    assert meta.metadata["card_kind"] == "review" and CODE in reply_text(review)
    run(handle_chat(ctx, "agent1qsomeoneelse", chat_msg(TextContent(text=CODE)), nav, sessions))
    assert f.bodies("/api/actions/confirm") == []
    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text=CODE)), nav, sessions))
    assert f.bodies("/api/actions/confirm") == [{"action_id": "act_00000000000000000001", "confirm_code": CODE}]
    assert "**Done.**" in reply_text(replies(ctx)[-1])


def test_end_session_clears_state_and_errors_stay_private():
    nav, sessions, _ = make()
    ctx = FakeCtx()
    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text="demo")), nav, sessions))
    assert sessions.get(SENDER)
    run(handle_chat(ctx, SENDER, chat_msg(EndSessionContent()), nav, sessions))
    assert sessions.get(SENDER) == {}

    class Boom(Navigator):
        async def handle(self, state, msg, desks=None):  # type: ignore[override]
            raise RuntimeError("secret detail")

    run(handle_chat(ctx, SENDER, chat_msg(TextContent(text="hi")), Boom(nav.desks, nav.settings), sessions))
    assert "Nothing was saved and no money moved" in reply_text(replies(ctx)[-1])
    assert "secret detail" not in " ".join(ctx.logs) and "turn failed: RuntimeError" in ctx.logs


def test_request_urls_stay_out_of_the_logs():
    import tend_agent.api  # noqa: F401 - importing the client sets the levels

    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING
