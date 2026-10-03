"""uAgents wiring: the Agent Chat Protocol in, the Navigator in the middle, chat messages and cards out."""

from __future__ import annotations

import uuid
from typing import Any

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import create_card_content, extract_card_response

from .api import TendApi
from .config import AGENT_DIR, AGENT_NAME, DESCRIPTION, Settings, inspector_url
from .navigator import Navigator, Reply, Sessions
from .parse import Incoming, selection_from_text

MAX_TEXT = 2000
SORRY = "Something went wrong on my side. Nothing was saved and no money moved. Please try again."


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
            resp = extract_card_response(c)
            if resp is None:
                continue
            if resp.selection is not None:
                selection = dict(resp.selection)
            cancelled = cancelled or resp.cancelled
            card_id = str(resp.card_id) if resp.card_id else card_id
            if resp.text and resp.selection is None:
                texts.append(resp.text)
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
        card_id = uuid.UUID(reply.card_id) if reply.card_id else None
        content.append(create_card_content(reply.card, card_id=card_id))
    if reply.end_session:
        content.append(EndSessionContent())
    return ChatMessage(content=content)


async def handle_chat(ctx: Context, sender: str, msg: ChatMessage, navigator: Navigator, sessions: Sessions) -> None:
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
    incoming = incoming_from(msg)
    if incoming.empty:
        if incoming.end:
            sessions.drop(sender)
        return
    async with sessions.lock(sender):
        try:
            turn = await navigator.handle(sessions.get(sender), incoming)
            sessions.put(sender, turn.state)
            replies, intent = turn.replies, turn.intent
        except Exception as exc:  # never leak a traceback (or the message) to the chat
            ctx.logger.error(f"turn failed: {type(exc).__name__}")
            replies, intent = [Reply(SORRY)], "error"
    for reply in replies:
        await ctx.send(sender, to_chat(reply))
    # Log the kind of turn only. Message text never reaches the logs.
    ctx.logger.info(f"turn intent={intent} replies={len(replies)} cards={sum(r.card is not None for r in replies)}")


def build_agent(
    settings: Settings,
    seed: str,
    *,
    navigator: Navigator | None = None,
    sessions: Sessions | None = None,
    api: TendApi | None = None,
    **agent_kwargs: Any,
) -> Agent:
    api = api or TendApi(settings.api_url, timeout=settings.timeout_s, agent_key=settings.agent_key)
    navigator = navigator or Navigator(api, settings)
    sessions = sessions or Sessions()
    options: dict[str, Any] = {
        "name": AGENT_NAME,
        "seed": seed,
        "port": settings.port,
        "mailbox": True,
        "publish_agent_details": True,
        "readme_path": str(AGENT_DIR / "AGENTVERSE.md"),
        "description": DESCRIPTION,
        "handle": settings.handle,
        "handle_messages_concurrently": True,
    }
    options.update(agent_kwargs)
    agent = Agent(**options)
    # The Inspector keeps every envelope, message text included, in memory and serves it at /messages.
    # Keep the Inspector (it is how the mailbox gets connected) but switch that history off.
    agent._message_history = None  # noqa: SLF001 - no public switch in uagents 0.25.5
    chat = Protocol(spec=chat_protocol_spec)

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
        await handle_chat(ctx, sender, msg, navigator, sessions)

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        return None

    agent.include(chat, publish_manifest=True)

    @agent.on_event("startup")
    async def banner(ctx: Context) -> None:
        status = "not reachable yet (start the API, see agent/README.md)"
        try:
            found = await api.jurisdictions()
            status = f"ok, {len(found)} jurisdictions"
        except Exception:  # noqa: BLE001 - a banner should never stop the agent
            pass
        for line in startup_lines(agent.address, settings, status):
            ctx.logger.info(line)

    @agent.on_event("shutdown")
    async def close(ctx: Context) -> None:
        await api.aclose()

    return agent


def startup_lines(address: str, settings: Settings, api_status: str = "", *, running: bool = True) -> list[str]:
    lines = [
        f"{AGENT_NAME} is running." if running else AGENT_NAME,
        f"  Address:   {address}",
        f"  Inspector: {inspector_url(address, settings.port)}",
        f"  Tend API:  {settings.api_url}" + (f" ({api_status})" if api_status else ""),
        "  To list it on Agentverse: open the Inspector link, click Connect, and choose Mailbox.",
    ]
    return lines
