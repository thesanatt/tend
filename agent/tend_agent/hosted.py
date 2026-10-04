"""The Navigator as an Agentverse-hosted agent: always on, no laptop needed.

Agentverse runs one agent per hosted file, so the Law and Bank+Packet desks run inside the Navigator's process
here (desks.LocalDesks) instead of as separate agents. The conversation, the API calls, and every safeguard are the
same code. Each message runs fresh on Agentverse, so the short session state (ids and amounts, never message text
or a code) lives in the agent's own storage for at most two hours.

scripts/build_hosted.py bundles this module and the ones it uses into hosted/navigator_hosted.py.
"""

from __future__ import annotations

from typing import Any

from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, chat_protocol_spec

from .api import TendApi
from .bank import BankDesk
from .chat import handle_chat
from .desks import LocalDesks
from .law import LawDesk
from .navigator import Navigator
from .sessions import StorageSessions
from .settings import PUBLIC_SITE, Settings


def hosted_settings(api_url: str = PUBLIC_SITE, public_url: str = PUBLIC_SITE) -> Settings:
    return Settings(api_url=api_url.rstrip("/"), app_url=public_url.rstrip("/"), timeout_s=25.0)


def attach(agent: Any, settings: Settings) -> Protocol:
    """Give an agent (the one Agentverse provides, or any uAgent) the Agent Chat Protocol and the Navigator."""
    chat = Protocol(spec=chat_protocol_spec)

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
        api = TendApi(settings.api_url, timeout=settings.timeout_s, agent_key=settings.agent_key)
        try:
            navigator = Navigator(LocalDesks(LawDesk(api, settings), BankDesk(api, settings)), settings)
            await handle_chat(ctx, sender, msg, navigator, StorageSessions(ctx.storage))
        finally:
            await api.aclose()

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        return None

    agent.include(chat, publish_manifest=True)
    return chat
