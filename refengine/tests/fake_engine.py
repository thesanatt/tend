"""A stand-in engine for testing difftest.py: the reference, optionally with one planted bug.

usage: python fake_engine.py --law ST.tlaw --input claim.json [--bug NAME]
The law IR is found next to the image as ST.ir.json (difftest writes images to a temp dir, so
the tests pass --ir explicitly).
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tend_ref import evaluate_json, load_law  # noqa: E402

BUGS = ("collateral", "trace", "crash", "unit", "message", "bytes", "malformed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--law", required=True)
    parser.add_argument("--ir", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--bug", choices=BUGS)
    args = parser.parse_args()
    import hashlib
    law = load_law(args.ir, law_sha256=hashlib.sha256(Path(args.law).read_bytes()).hexdigest())
    raw = Path(args.input).read_bytes()
    if args.bug == "crash":
        print("simulated crash", file=sys.stderr)
        return 3
    if args.bug == "collateral":
        doc = json.loads(raw)
        for it in doc.get("items") or []:
            if isinstance(it, dict) and it.get("insurance_paid_cents"):
                it["insurance_paid_cents"] = 0  # forgets to subtract insurance
        raw = json.dumps(doc).encode()
    if args.bug == "unit":
        doc = json.loads(raw)
        for it in doc.get("items") or []:
            if isinstance(it, dict):
                it.pop("unit", None)  # ignores typed units
        raw = json.dumps(doc).encode()
    text = evaluate_json(law, raw)
    out = json.loads(text)
    if args.bug == "trace" and "trace" in out:
        out["trace"] = [t for t in out["trace"] if t["op"] != "rate_unverified"]
        text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    if args.bug == "message" and "error" in out:
        out["error"]["message"] += "."
        text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    if args.bug == "bytes":
        text = json.dumps(out, ensure_ascii=True, separators=(", ", ":"))
    if args.bug == "malformed" and "error" in out:
        text = json.dumps({"lines": []})
    sys.stdout.write(text)
    return 1 if "error" in out else 0


if __name__ == "__main__":
    sys.exit(main())
