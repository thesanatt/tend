"""python -m tend_agent            run the agent (mailbox, for ASI:One)
python -m tend_agent --address  print the name, address, and Inspector link, then exit
python -m tend_agent --chat     talk to the same Navigator in this terminal (no Agentverse), one message per line
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .config import AGENT_NAME, Settings, ensure_seed, inspector_url, load_env


def _card_text(card: object) -> str:
    data = card.model_dump(exclude_none=True)  # type: ignore[attr-defined]
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
    from .navigator import Navigator
    from .parse import Incoming, selection_from_text

    api = TendApi(settings.api_url, timeout=settings.timeout_s, agent_key=settings.agent_key)
    nav = Navigator(api, settings)
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
    parser = argparse.ArgumentParser(prog="tend_agent", description=f"{AGENT_NAME}, a Fetch.ai uAgent for Tend")
    parser.add_argument("--address", action="store_true", help="print the agent address and Inspector link, then exit")
    parser.add_argument("--chat", action="store_true", help="talk to the Navigator in this terminal (no Agentverse)")
    args = parser.parse_args(argv)

    env_path = load_env()
    created = ensure_seed(env_path)
    settings = Settings.from_env()
    if created:
        print(f"Created AGENT_SEED and saved it to {env_path or 'the repo .env'} (not shown).", flush=True)

    if args.chat:
        asyncio.run(_console(settings))
        return 0

    import os

    from .agent import build_agent, startup_lines

    agent = build_agent(settings, os.environ["AGENT_SEED"])
    if args.address:
        print("\n".join(startup_lines(agent.address, settings, running=False)))
        return 0
    print(f"{AGENT_NAME}: {agent.address}\nInspector: {inspector_url(agent.address, settings.port)}", flush=True)
    agent.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
