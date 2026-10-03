"""Command line: python -m tend_ref eval --rules rules/verified/MI.json --input in.json"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .engine import EngineInputError, evaluate, load_rules
from .gen import claim_rng, generate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tend_ref",
        description="Tend law engine, Python reference implementation.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    ev = sub.add_parser("eval", help="evaluate one claim and print the engine output JSON")
    ev.add_argument("--rules", required=True, help="verified jurisdiction file, e.g. rules/verified/MI.json")
    ev.add_argument("--input", required=True, help="engine input JSON file, or - for stdin")
    ev.add_argument("--compact", action="store_true", help="print the output on one line")

    gen = sub.add_parser("gen", help="print a random engine input for a jurisdiction")
    gen.add_argument("--rules", required=True, help="verified jurisdiction file")
    gen.add_argument("--seed", type=int, default=0)
    gen.add_argument("--index", type=int, default=0, help="claim number within the seed")
    gen.add_argument("--compact", action="store_true", help="print the input on one line")

    args = parser.parse_args(argv)
    try:
        rules, sha = load_rules(args.rules)
        if args.command == "eval":
            text = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
            out = evaluate(rules, json.loads(text), law_sha256=sha)
        else:
            out = generate(rules, claim_rng(args.seed, rules["jurisdiction"], args.index))
    except (OSError, json.JSONDecodeError, EngineInputError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    json.dump(out, sys.stdout, indent=None if args.compact else 2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
