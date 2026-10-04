"""python -m tend_agent            run the three agents: the Navigator (Agentverse mailbox), Law, and Bank+Packet
python -m tend_agent --address  print each agent's name and address and the Inspector link, then exit
python -m tend_agent --chat     talk to the same conversation in this terminal (all three desks in-process, no uAgents)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from .config import AGENT_NAME, BANK_NAME, LAW_NAME, addresses_from, ensure_seed, inspector_url, load_env, seeds_from
from .settings import Settings


def _card_text(card: object) -> str:
    data = card.payload  # type: ignore[attr-defined]
    lines = [f"  [card] {data.get('title', '')}"]
    for row in data.get("summary_rows", []):
        lines.append(f"    {row['label']}: {row['value']}")
    for f in data.get("fields", []):
        opts = ", ".join(o["value"] for o in f.get("options", []))
        lines.append(f"    field {f['name']}: {f['label']}" + (f" ({opts})" if opts else ""))
    buttons = [data.get(k) for k in ("approve_cta", "reject_cta", "submit_cta") if data.get(k)] + data.get("ctas", [])
    for b in buttons:
        lines.append(f"    button '{b['label']}' -> {json.dumps(b['selection'])}")
    return "\n".join(lines)


async def _console(settings: Settings) -> None:
    from .api import TendApi
    from .bank import BankDesk
    from .desks import LocalDesks
    from .law import LawDesk
    from .navigator import Navigator
    from .parse import Incoming, selection_from_text

    api = TendApi(settings.api_url, timeout=settings.timeout_s, agent_key=settings.agent_key)
    nav = Navigator(LocalDesks(LawDesk(api, settings), BankDesk(api, settings)), settings)
    state: dict = {}
    print(f"{AGENT_NAME} console. Tend API: {settings.api_url}. Type a message; JSON is treated as a card click.", flush=True)
    try:
        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            print(f"\n> {text}", flush=True)
            sel = selection_from_text(text)
            turn = await nav.handle(state, Incoming(text="" if sel else text, selection=sel))
            state = turn.state
            for reply in turn.replies:
                print(reply.text)
                if reply.card is not None:
                    print(_card_text(reply.card))
                if reply.end_session:
                    print("  [end of turn]")
            print(f"  (intent: {turn.intent})", flush=True)
    finally:
        await api.aclose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tend_agent", description=f"{AGENT_NAME} and its two helper agents, for Tend")
    parser.add_argument("--address", action="store_true", help="print the agents' addresses and the Inspector link, then exit")
    parser.add_argument("--chat", action="store_true", help="talk to the conversation in this terminal (no Agentverse)")
    args = parser.parse_args(argv)

    env_path = load_env()
    created = ensure_seed(env_path)
    settings = Settings.from_env()
    if created:
        print(f"Created AGENT_SEED and saved it to {env_path or 'the repo .env'} (not shown).", flush=True)

    if args.chat:
        asyncio.run(_console(settings))
        return 0

    from .agents import build_team, run_team, startup_lines

    seeds = seeds_from(os.environ["AGENT_SEED"])
    overrides = {k: v for k, v in (("law", os.environ.get("TEND_LAW_ADDRESS")), ("bank", os.environ.get("TEND_BANK_ADDRESS"))) if v}
    if args.address:
        found = {**addresses_from(seeds), **overrides}
        print("\n".join(startup_lines(found["navigator"], found, settings, running=False)))
        print(f"{LAW_NAME}: {found['law']}\n{BANK_NAME}: {found['bank']}")
        return 0
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    extra = {"agentverse": os.environ["TEND_AGENTVERSE_URL"]} if os.environ.get("TEND_AGENTVERSE_URL") else {}
    team = build_team(settings, seeds, addresses=overrides, loop=loop, **extra)
    print(f"{AGENT_NAME}: {team.navigator.address}\nInspector: {inspector_url(team.navigator.address, settings.port)}", flush=True)
    try:
        loop.run_until_complete(run_team(team, settings))
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
