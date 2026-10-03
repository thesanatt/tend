"""A stand-in engine for testing difftest.py: the reference, optionally with one planted bug.

usage: python fake_engine.py --rules ZZ.json --input in.json [--bug collateral|trace|crash]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tend_ref import evaluate, load_rules  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rules", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--bug", choices=("collateral", "trace", "crash"))
    args = parser.parse_args()
    rules, sha = load_rules(args.rules)
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if args.bug == "crash":
        print("simulated crash", file=sys.stderr)
        return 3
    if args.bug == "collateral":
        for it in data.get("items", []):
            it["insurance_paid_cents"] = 0  # forgets to subtract insurance
    out = evaluate(rules, data, law_sha256="0" * 64)
    if args.bug == "trace":
        out["trace"] = [t for t in out["trace"] if t["op"] != "rate_unverified"]
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
