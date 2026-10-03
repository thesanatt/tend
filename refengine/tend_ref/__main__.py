"""Command line.

    python -m tend_ref eval --ir rules/ir/MI.json --input claim.json [--compact]
    python -m tend_ref gen --ir rules/ir/MI.json --seed 1 --index 0
    python -m tend_ref check --ir rules/ir/MI.json

eval prints the result document, or the error document and exits 1 for a refused claim (as
tendvm eval does). A law tendc would refuse prints `error: ...` and exits 2.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

from .engine import evaluate_json
from .gen import claim_rng, generate
from .law import LawError, load_law


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tend_ref",
                                     description="Tend law engine, Python reference implementation (SPEC v1.2).")
    sub = parser.add_subparsers(dest="command", required=True)

    def law_args(p):
        p.add_argument("--ir", required=True, help="law IR, e.g. rules/ir/MI.json")
        p.add_argument("--verified", help="verified file for quotes (default: ../verified/ST.json next to the IR)")
        p.add_argument("--no-verified", action="store_true", help="do not read the verified file")
        p.add_argument("--law-sha256", help="value for law_image_sha256 (e.g. the sha256 of the compiled .tlaw)")

    ev = sub.add_parser("eval", help="evaluate one claim and print the result JSON")
    law_args(ev)
    ev.add_argument("--input", required=True, help="engine input JSON file, or - for stdin")
    ev.add_argument("--compact", action="store_true", help="print the output on one line")

    gen = sub.add_parser("gen", help="print a random engine input for a jurisdiction")
    law_args(gen)
    gen.add_argument("--seed", type=int, default=0)
    gen.add_argument("--index", type=int, default=0, help="claim number within the seed")
    gen.add_argument("--compact", action="store_true", help="print the input on one line")

    chk = sub.add_parser("check", help="load a law the way tendc does and summarize it")
    law_args(chk)

    args = parser.parse_args(argv)
    try:
        law = load_law(args.ir, args.verified, law_sha256=args.law_sha256, use_verified=not args.no_verified)
    except (OSError, LawError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if args.command == "check":
        kinds = Counter(r.kind for r in law.rules)
        print(f"{law.jurisdiction}: {len(law.rules)} rules, {len(law.skipped)} set aside | "
              + " ".join(f"{k}={v}" for k, v in sorted(kinds.items())))
        for note in law.notes:
            print(f"note: {note}")
        return 0
    if args.command == "gen":
        doc = generate(law, claim_rng(args.seed, law.jurisdiction, args.index))
        text = json.dumps(doc, indent=None if args.compact else 2, ensure_ascii=False)
        sys.stdout.buffer.write((text + "\n").encode("utf-8"))
        return 0

    try:
        raw = sys.stdin.buffer.read() if args.input == "-" else open(args.input, "rb").read()
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    text = evaluate_json(law, raw)
    doc = json.loads(text)
    if not args.compact:
        text = json.dumps(doc, indent=2, ensure_ascii=False)
    sys.stdout.buffer.write((text + "\n").encode("utf-8"))
    return 1 if "error" in doc and "lines" not in doc else 0


if __name__ == "__main__":
    sys.exit(main())
