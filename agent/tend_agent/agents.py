"""uAgents wiring: three cooperating agents, run together in one process by default.

- Tend Navigator (AGENT_SEED, Agentverse mailbox): speaks the Agent Chat Protocol with ASI:One, keeps each
  person's short session, and sends typed requests to the other two.
- Tend Law: cited answers and Checks from the verified corpus.
- Tend Bank and Packet: the fictional demo claim, the confirm-coded payment, and the sealed share link.

The sub-agents take requests only from the Navigator's address. In one process their messages go through the uAgents
dispatcher; with TEND_SUBAGENT_MAILBOX=1 they also get Agentverse mailboxes and can run anywhere.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any

from uagents import Agent, Context, Model, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, chat_protocol_spec

from .api import TendApi
from .bank import BankDesk
from .chat import handle_chat
from .config import (
    AGENT_DIR,
    AGENT_NAME,
    BANK_DESCRIPTION,
    BANK_NAME,
    DESCRIPTION,
    LAW_DESCRIPTION,
    LAW_NAME,
    Seeds,
    inspector_url,
)
from .law import LawDesk
from .link import AgentLink, RemoteDesks
from .messages import BANK_REQUESTS, LAW_REQUESTS, REPLIES, REPLY_FOR
from .navigator import Navigator
from .sessions import MemorySessions
from .settings import Settings


def build_navigator(
    settings: Settings,
    seed: str,
    link: AgentLink,
    *,
    navigator: Navigator | None = None,
    sessions: MemorySessions | None = None,
    api: TendApi | None = None,
    **agent_kwargs: Any,
) -> Agent:
    navigator = navigator or Navigator(None, settings, team=True)
    sessions = sessions or MemorySessions()
    options: dict[str, Any] = {
        "name": AGENT_NAME,
        "seed": seed,
        "port": settings.port,
        "mailbox": True,
        "publish_agent_details": True,
        "readme_path": str(AGENT_DIR / "PROFILE.md"),
        "description": DESCRIPTION,
        "handle": settings.handle,
        # Required: a turn waits for the sub-agents' replies, which arrive as messages to this same agent.
        "handle_messages_concurrently": True,
    }
    options.update(agent_kwargs)
    agent = Agent(**options)
    # The Inspector keeps every envelope, message text included, in memory. Keep the Inspector, drop that history.
    agent._message_history = None  # noqa: SLF001 - no public switch in uagents 0.25.5

    chat = Protocol(spec=chat_protocol_spec)

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
        await handle_chat(ctx, sender, msg, navigator, sessions, RemoteDesks(ctx, link))

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        return None

    agent.include(chat, publish_manifest=True)

    replies = Protocol(name="tend-desk-replies", version="1.0.0")

    async def on_reply(ctx: Context, sender: str, msg: Model) -> None:
        if not link.resolve(sender, msg):
            ctx.logger.info(f"dropped a late or unexpected {type(msg).__name__}")

    for model in REPLIES:
        replies.on_message(model)(on_reply)
    agent.include(replies)

    if api is not None:

        @agent.on_event("startup")
        async def banner(ctx: Context) -> None:
            status = "not reachable yet (start the API, see agent/README.md)"
            with contextlib.suppress(Exception):  # a banner never stops the agent
                status = f"ok, {len(await api.jurisdictions())} jurisdictions"
            for line in startup_lines(agent.address, link.addresses, settings, status):
                ctx.logger.info(line)

    return agent


def build_desk_agent(
    name: str,
    seed: str,
    desk: Any,
    requests: tuple[type[Model], ...],
    settings: Settings,
    navigator_address: str | None,
    *,
    description: str = "",
    **agent_kwargs: Any,
) -> Agent:
    mailbox = settings.subagent_mailbox
    options: dict[str, Any] = {
        "name": name,
        "seed": seed,
        "mailbox": mailbox,
        "publish_agent_details": mailbox,
        "description": description,
        "handle_messages_concurrently": True,
    }
    options.update(agent_kwargs)
    agent = Agent(**options)
    agent._message_history = None  # noqa: SLF001
    if not mailbox and "endpoint" not in agent_kwargs:
        agent._registration_policy = None  # noqa: SLF001 - in-process only: nothing to register, no warning

    proto = Protocol(name=f"tend-{desk.name}", version="1.0.0")

    async def on_request(ctx: Context, sender: str, req: Model) -> None:
        reply_type = REPLY_FOR[type(req)]
        if navigator_address and sender != navigator_address:
            await ctx.send(
                sender,
                reply_type(
                    request_id=req.request_id, ok=False, error="not_allowed", text="This agent takes requests from Tend Navigator only."
                ),
            )
            ctx.logger.warning(f"refused a {type(req).__name__} from an agent that is not the Navigator")
            return
        try:
            reply = await desk.handle(req)
        except Exception as exc:  # a reply always goes back, without the details
            ctx.logger.error(f"{desk.name} {type(req).__name__} failed: {type(exc).__name__}")
            reply = reply_type(request_id=req.request_id, ok=False, error="internal", text="The agent hit an error.")
        await ctx.send(sender, reply)
        # The kind of request only. No text, amounts, or ids in the log.
        ctx.logger.info(f"{desk.name} {type(req).__name__} ok={reply.ok}")

    for model in requests:
        proto.on_message(model, replies=REPLY_FOR[model])(on_request)
    agent.include(proto, publish_manifest=mailbox)
    return agent


@dataclass
class Team:
    navigator: Agent
    law: Agent
    bank: Agent
    link: AgentLink
    api: TendApi

    @property
    def agents(self) -> list[Agent]:
        return [self.navigator, self.law, self.bank]


def build_team(
    settings: Settings,
    seeds: Seeds,
    *,
    api: TendApi | None = None,
    navigator: Navigator | None = None,
    sessions: MemorySessions | None = None,
    addresses: dict[str, str] | None = None,
    **common: Any,
) -> Team:
    """The three agents, wired to each other. `common` goes to every Agent (loop, agentverse, inspector switch);
    `addresses` points the Navigator at sub-agents that run somewhere else."""
    api = api or TendApi(settings.api_url, timeout=settings.timeout_s, agent_key=settings.agent_key)
    link = AgentLink(timeouts={"law": settings.law_timeout_s, "bank": settings.bank_timeout_s}, attempts=settings.attempts)
    nav = build_navigator(settings, seeds.navigator, link, navigator=navigator, sessions=sessions, api=api, **common)
    sub = {k: v for k, v in common.items() if k != "mailbox"}
    law = build_desk_agent(
        LAW_NAME,
        seeds.law,
        LawDesk(api, settings),
        LAW_REQUESTS,
        settings,
        nav.address,
        description=LAW_DESCRIPTION,
        port=settings.port + 1,
        **sub,
    )
    bank = build_desk_agent(
        BANK_NAME,
        seeds.bank,
        BankDesk(api, settings),
        BANK_REQUESTS,
        settings,
        nav.address,
        description=BANK_DESCRIPTION,
        port=settings.port + 2,
        **sub,
    )
    link.addresses = {"law": law.address, "bank": bank.address, **(addresses or {})}
    return Team(nav, law, bank, link, api)


def start_sub_agents(team: Team, settings: Settings, *, servers: bool | None = None) -> None:
    """Start the Law and Bank+Packet agents on the current loop (their dispensers and message queues). With
    mailboxes on, also their servers (for the Agentverse Inspector) and mailbox clients."""
    servers = settings.subagent_mailbox if servers is None else servers
    loop = asyncio.get_event_loop()
    for agent in (team.law, team.bank):
        agent.setup()
        if servers:
            loop.create_task(agent.start_server())
        if settings.subagent_mailbox and agent.mailbox_client is not None:
            loop.create_task(agent.mailbox_client.run())


async def run_team(team: Team, settings: Settings) -> None:
    start_sub_agents(team, settings)
    try:
        await team.navigator.run_async()
    finally:
        await team.api.aclose()


def startup_lines(address: str, addresses: dict[str, str], settings: Settings, api_status: str = "", *, running: bool = True) -> list[str]:
    lines = [
        f"{AGENT_NAME} is running." if running else AGENT_NAME,
        f"  Address:    {address}",
        f"  Inspector:  {inspector_url(address, settings.port)}",
        f"  Law agent:  {addresses.get('law', '')}",
        f"  Bank agent: {addresses.get('bank', '')}",
        f"  Tend API:   {settings.api_url}" + (f" ({api_status})" if api_status else ""),
        f"  Share links open at: {settings.share_origin}/share",
    ]
    if settings.subagent_mailbox:
        lines.append(f"  Law Inspector:  {inspector_url(addresses.get('law', ''), settings.port + 1)}")
        lines.append(f"  Bank Inspector: {inspector_url(addresses.get('bank', ''), settings.port + 2)}")
    if any(host in settings.api_url for host in ("127.0.0.1", "localhost")) and not settings.app_url:
        lines.append(
            "  Set TEND_PUBLIC_URL to the web app that serves this API (like http://localhost:3000), or share links will not open."
        )
    lines.append("  To list it on Agentverse: open the Inspector link, click Connect, and choose Mailbox.")
    return lines
