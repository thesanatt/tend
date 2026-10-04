"""Rehearse the whole demo chat through the three real agents, the way ASI:One would send it, and write the transcript.

    uv run python scripts/rehearse.py      # TEND_API_URL (default http://127.0.0.1:8000), TEND_PUBLIC_URL for links

The Navigator, Law, and Bank+Packet agents run on one event loop with a stand-in for ASI:One. Every message travels
through the uAgents dispatcher on the Agent Chat Protocol and the agents' typed messages; nothing goes to Agentverse
(the agents use rehearsal seeds and no mailbox, so the live Navigator is untouched). The script reads the confirm
code off the review card and types it back, like the person would. Money moves only through the API's propose and
confirm endpoints: a dry run unless the API runs with TEND_BANK=nessie. At the end it opens the share link the way
the advocate's browser does, to check it.

Writes agent/REHEARSAL.md. The share link's key is cut from the transcript.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

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
from tend_agent.navigator import Navigator
from tend_agent.settings import Settings
from tend_agent.share import open_sealed

AGENT_DIR = Path(__file__).resolve().parents[1]
OUT = AGENT_DIR / "REHEARSAL.md"
OFFLINE = "http://127.0.0.1:9"  # Agentverse calls fail fast here instead of reaching the internet
DESK = {"law": "Law agent", "bank": "Bank and Packet agent"}

# (what the person does, what to send). {code} is read off the review card.
SCRIPT: list[tuple[str, Any]] = [
    ("types", "hi"),
    ("types", "What is the deadline to apply in Ohio?"),
    ("types", "Can I get money for my dog's vet bills in Michigan?"),
    ("types", "check Michigan, June 14 2026, had an exam, not reported"),
    ("types", "show me the demo claim"),
    ("clicks", ("Yes, count them", {"action": "count_costs"})),
    ("types", "pay the bill"),
    ("types", "{code}"),
    ("clicks", ("Make a locked link for an advocate", {"action": "share"})),
]


def describe_card(meta: dict[str, str]) -> str:
    payload = json.loads(meta.get("card_payload") or "{}")
    rows = [f"{r['label']}: {r['value']}" for r in payload.get("summary_rows") or []]
    fields = [f["label"] for f in payload.get("fields") or []]
    buttons = [b["label"] for b in [payload.get(k) for k in ("approve_cta", "reject_cta", "submit_cta")] if b]
    buttons += [b["label"] for b in payload.get("ctas") or []]
    parts = [f"{meta.get('card_kind', '').capitalize()} card: **{payload.get('title', '')}**"]
    if rows:
        parts.append("; ".join(rows))
    if fields:
        parts.append("fields: " + ", ".join(fields))
    if buttons:
        parts.append("buttons: " + ", ".join(buttons))
    return " | ".join(parts)


def card_rows(msgs: list[ChatMessage]) -> dict[str, str]:
    rows: dict[str, str] = {}
    for m in msgs:
        for c in m.content:
            if isinstance(c, MetadataContent) and c.metadata.get("card_payload"):
                for r in json.loads(c.metadata["card_payload"]).get("summary_rows") or []:
                    rows[r["label"]] = r["value"]
    return rows


async def rehearse(settings: Settings) -> tuple[list[str], dict[str, Any]]:
    loop = asyncio.get_running_loop()
    api = TendApi(settings.api_url, timeout=settings.timeout_s)
    nav = Navigator(None, settings, team=True)
    common = {"agentverse": OFFLINE, "loop": loop, "enable_agent_inspector": False}
    team = build_team(settings, seeds_from("tend-rehearsal-not-a-secret"), api=api, navigator=nav, mailbox=False, **common)
    trace: list[str] = []
    team.link.observer = lambda desk, req, reply, secs, attempts: trace.append(
        f"Navigator asked the {DESK[desk]} ({type(req).__name__}), answered in {secs:.2f} s"
        + (f" after {attempts} tries" if attempts > 1 else "")
    )
    user = Agent(name="asi-one-stand-in", seed="tend-rehearsal-user", **common)
    inbox: list[ChatMessage] = []
    proto = Protocol(spec=chat_protocol_spec)

    @proto.on_message(ChatMessage)
    async def on_reply(ctx: Context, sender: str, msg: ChatMessage) -> None:
        inbox.append(msg)
        await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))

    @proto.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        return None

    user.include(proto)
    team.navigator.setup()
    start_sub_agents(team, settings, servers=False)
    user.setup()

    async def say(content: list[Any]) -> list[ChatMessage]:
        before = len(inbox)
        await user._build_context().send(team.navigator.address, ChatMessage(content=content))  # noqa: SLF001
        for _ in range(9000):  # up to 90 s for the first reply
            if len(inbox) > before:
                break
            await asyncio.sleep(0.01)
        else:
            raise RuntimeError("no reply from the Navigator")
        count = -1
        while count != len(inbox):  # then whatever else arrives until the chat is quiet
            count = len(inbox)
            await asyncio.sleep(0.4)
        return inbox[before:]

    lines: list[str] = []
    code, link, scan_id = "", "", ""
    started = time.monotonic()
    for i, (kind, what) in enumerate(SCRIPT):
        trace.clear()
        if kind == "clicks":
            label, selection = what
            if selection.get("action") == "count_costs" and scan_id:
                selection = {**selection, "scan_id": scan_id}
            content: list[Any] = [create_card_response_content(selection=selection)]
            lines.append(f"**You** click **{label}** on the card.")
        else:
            text = what.format(code=code)
            content = [TextContent(text=text)]
            lines.append(f"**You:** {text}")
        if i == 0:
            content.insert(0, StartSessionContent())
        replies = await say(content)
        for m in replies:
            for c in m.content:
                if isinstance(c, TextContent):
                    shown = c.text
                    if "/share#" in shown:
                        link = next(w for w in shown.split() if "/share#" in w)
                        shown = shown.replace(link, link.rsplit(".", 1)[0] + ".KEY")
                    lines.append(f"**Tend Navigator:**\n\n{shown}")
                elif isinstance(c, MetadataContent) and c.metadata.get("card_kind"):
                    lines.append(f"> {describe_card(c.metadata)}")
                    payload = json.loads(c.metadata["card_payload"])
                    sel = (payload.get("approve_cta") or {}).get("selection") or {}
                    scan_id = sel.get("scan_id", scan_id)
        code = card_rows(replies).get("Confirm code", code)
        if trace:
            lines.append("_Behind the scenes: " + "; ".join(trace) + "._")
        lines.append("---")

    checked: dict[str, Any] = {"seconds": round(time.monotonic() - started, 1)}
    if link:
        share_id, key = link.split("#", 1)[1].split(".")
        stored = await api._request("GET", f"/api/shares/{share_id}")  # noqa: SLF001 - what the advocate's browser fetches
        packet = open_sealed(stored["ciphertext"], stored["iv"], key)
        totals = packet["output"]["totals"]
        checked.update(
            st=packet["st"], allowed_cents=totals["allowed_cents"], held_cents=totals["held_cents"], items=len(packet["input"]["items"])
        )
    await api.aclose()
    return lines, checked


def main() -> int:
    settings = Settings.from_env()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        lines, checked = loop.run_until_complete(rehearse(settings))
    finally:
        for task in asyncio.all_tasks(loop):
            task.cancel()
        loop.run_until_complete(asyncio.sleep(0))
        loop.close()
    stamp = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    head = [
        "# Rehearsal: the whole loop in one chat",
        "",
        f"Produced by `agent/scripts/rehearse.py` on {stamp} against the Tend API at `{settings.api_url}`. Three uAgents "
        "(Navigator, Law, Bank and Packet) and a stand-in for ASI:One talked over the Agent Chat Protocol and the agents' "
        "typed messages. The person is fictional and so is every number from the bank. The share link's key is cut "
        "from this file (`KEY`).",
        "",
        "---",
    ]
    tail = []
    if "allowed_cents" in checked:
        tail = [
            "",
            f"**Checked after the chat:** the link's ciphertext, fetched from the API like the advocate's browser does, "
            f"opened with the key from the link: {checked['st']}, {checked['items']} costs, ${checked['allowed_cents'] / 100:,.2f} "
            f"the program can be asked for, ${checked['held_cents'] / 100:,.2f} held. Whole chat: {checked['seconds']} s.",
        ]
    OUT.write_text("\n".join(head + [""] + "\n\n".join(lines).split("\n") + tail) + "\n")
    print(OUT.read_text())
    print(f"wrote {OUT.relative_to(AGENT_DIR)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("TEND_ENV_FILE", "")
    sys.exit(main())
