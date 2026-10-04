"""The Agent Chat Protocol in and out: text, card clicks, and session markers in; text, cards, and an end-of-session
marker out. Shared by the local Navigator and the Agentverse-hosted build.

Cards are read and written as plain MetadataContent (card_protocol_version 1), so this works with any uagents-core
that has the chat protocol.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
)

from .cards import Card
from .navigator import Navigator, Reply
from .parse import Incoming, selection_from_text

MAX_TEXT = 2000
SORRY = "Something went wrong on my side. Nothing was saved and no money moved. Please try again."


def card_content(card: Card, card_id: str | None = None) -> MetadataContent:
    meta = {
        "card_protocol_version": "1",
        "requires_card_interaction": "true",
        "card_kind": card.kind,
        "card_payload": json.dumps(card.payload, separators=(",", ":"), ensure_ascii=False),
    }
    if card_id:
        meta["card_id"] = str(uuid.UUID(card_id))
    return MetadataContent(metadata=meta)


def card_response(meta: dict[str, str]) -> dict[str, Any] | None:
    """A card click or dismissal (a card_protocol_version 1 block without card_kind), else None."""
    if meta.get("card_protocol_version") != "1" or "card_kind" in meta:
        return None
    selection = None
    raw = meta.get("selection")
    if raw is not None:
        try:
            selection = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(selection, dict):
            return None
    return {
        "selection": selection,
        "cancelled": meta.get("cancelled") == "true",
        "text": meta.get("text"),
        "card_id": meta.get("card_id"),
    }


def incoming_from(msg: ChatMessage) -> Incoming:
    """Text, a card click (MetadataContent, or JSON text from a direct @mention), and session markers."""
    texts: list[str] = []
    selection: dict[str, Any] | None = None
    cancelled = False
    card_id: str | None = None
    start = end = False
    for c in msg.content:
        if isinstance(c, TextContent):
            texts.append(c.text)
        elif isinstance(c, MetadataContent):
            resp = card_response(dict(c.metadata))
            if resp is None:
                continue
            if resp["selection"] is not None:
                selection = dict(resp["selection"])
            cancelled = cancelled or resp["cancelled"]
            card_id = resp["card_id"] or card_id
            if resp["text"] and resp["selection"] is None:
                texts.append(resp["text"])
        elif isinstance(c, StartSessionContent):
            start = True
        elif isinstance(c, EndSessionContent):
            end = True
    text = " ".join(t for t in texts if t).strip()[:MAX_TEXT]
    if selection is None:
        from_text = selection_from_text(text)
        if from_text is not None:
            selection, text = from_text, ""
    return Incoming(text=text, selection=selection, cancelled=cancelled, card_id=card_id, start=start, end=end)


def to_chat(reply: Reply) -> ChatMessage:
    content: list[Any] = [TextContent(text=reply.text)]
    if reply.card is not None:
        content.append(card_content(reply.card, reply.card_id))
    if reply.end_session:
        content.append(EndSessionContent())
    return ChatMessage(content=content)


async def handle_chat(ctx: Any, sender: str, msg: ChatMessage, navigator: Navigator, sessions: Any, desks: Any = None) -> None:
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
    incoming = incoming_from(msg)
    if incoming.empty:
        if incoming.end:
            sessions.drop(sender)
        return
    async with sessions.lock(sender):
        try:
            turn = await navigator.handle(sessions.get(sender), incoming, desks)
            sessions.put(sender, turn.state)
            replies, intent = turn.replies, turn.intent
        except Exception as exc:  # never leak a traceback (or the message) to the chat
            ctx.logger.error(f"turn failed: {type(exc).__name__}")
            replies, intent = [Reply(SORRY)], "error"
    for reply in replies:
        await ctx.send(sender, to_chat(reply))
    # The kind of turn only. Message text never reaches the logs.
    ctx.logger.info(f"turn intent={intent} replies={len(replies)} cards={sum(r.card is not None for r in replies)}")
