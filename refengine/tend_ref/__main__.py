"""Command line: python -m tend_ref eval --rules rules/verified/MI.json --input in.json"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .engine import EngineInputError, Law, load_rules
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
        law = Law(rules, sha)  # validates the rules for gen too
        if args.command == "eval":
            if args.input == "-":
                text = sys.stdin.buffer.read().decode("utf-8")
            else:
                text = Path(args.input).read_text(encoding="utf-8")
            out = law.evaluate(json.loads(text))
        else:
            out = generate(rules, claim_rng(args.seed, law.jurisdiction, args.index))
    except RecursionError:
        print("error: the JSON is nested too deeply", file=sys.stderr)
        return 2
    except (OSError, ValueError) as e:  # ValueError covers bad JSON, bad UTF-8 and EngineInputError
        print(f"error: {e}", file=sys.stderr)
        return 2

    text = json.dumps(out, indent=None if args.compact else 2, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
