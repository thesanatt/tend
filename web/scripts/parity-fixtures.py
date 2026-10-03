# Writes fixtures/parity/<ST>.json: random claims plus Rowan's confirmed costs, each with the output
# of the Python reference engine, so tests/parity.test.ts can hold the preview engine to it.
#
# usage: python3 scripts/parity-fixtures.py [--refengine ../refengine] [--claims 6] [--seed 2026]
import argparse
import json
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]

ap = argparse.ArgumentParser()
ap.add_argument("--refengine", default=str(WEB.parent / "refengine"))
ap.add_argument("--claims", type=int, default=6)
ap.add_argument("--seed", type=int, default=2026)
args = ap.parse_args()

sys.path.insert(0, args.refengine)
from tend_ref.engine import Law, load_rules  # noqa: E402
from tend_ref.gen import claim_rng, generate  # noqa: E402

rowan = json.loads((WEB / "fixtures/rowan-mi.input.json").read_text())
rowan["items"] = [{**it, "confirmed": True} for it in rowan["items"]]
out_dir = WEB / "fixtures/parity"
out_dir.mkdir(exist_ok=True)
total = 0
for path in sorted((WEB / "public/data/law").glob("*.json")):
    rules, sha = load_rules(path)
    law = Law(rules, sha)
    inputs = [generate(rules, claim_rng(args.seed, law.jurisdiction, i)) for i in range(args.claims)]
    inputs.append({**rowan, "jurisdiction": law.jurisdiction})
    cases = [{"input": i, "output": law.evaluate(i)} for i in inputs]
    (out_dir / f"{law.jurisdiction}.json").write_text(json.dumps({"law_sha256": sha, "cases": cases}, separators=(",", ":")))
    total += len(cases)
print(f"wrote {total} reference cases for {len(list(out_dir.glob('*.json')))} jurisdictions")
