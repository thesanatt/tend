"""Every jurisdiction's law IR: generated claims evaluate cleanly and keep the invariants.

Reads rules/ir at the repo root (or TEND_IR_DIR). Skips when there are no files.
"""

import copy
import json
import os
import random
from pathlib import Path

import pytest

from tend_ref import evaluate_json, load_law
from tend_ref.gen import claim_rng, generate
from tend_ref.invariants import invariant_errors

IR_DIR = Path(os.environ.get("TEND_IR_DIR") or Path(__file__).resolve().parents[2] / "rules" / "ir")
FILES = sorted(IR_DIR.glob("*.json")) if IR_DIR.is_dir() else []
CLAIMS = int(os.environ.get("TEND_REAL_CLAIMS", "120"))


@pytest.mark.skipif(not FILES, reason=f"no law IR in {IR_DIR}")
@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_real_jurisdiction(path):
    law = load_law(path)
    for index in range(CLAIMS):
        rng = claim_rng(11, law.jurisdiction, index)
        data = generate(law, rng)
        text = evaluate_json(law, json.dumps(data).encode())
        out = json.loads(text)
        assert "lines" in out, out
        assert invariant_errors(law, data, out) == [], f"claim {index}"
        shuffled = copy.deepcopy(data)
        random.Random(index).shuffle(shuffled["items"])
        assert evaluate_json(law, json.dumps(shuffled).encode()) == text
