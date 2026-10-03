"""Every verified jurisdiction: generated claims evaluate cleanly and keep the invariants.

Reads rules/verified/ at the repo root, or TEND_RULES_DIR. Skips when neither has files.
"""

import copy
import os
import random
from pathlib import Path

import pytest

from tend_ref import Law, load_rules
from tend_ref.gen import claim_rng, generate
from tend_ref.invariants import invariant_errors

RULES_DIR = Path(os.environ.get("TEND_RULES_DIR") or Path(__file__).resolve().parents[2] / "rules" / "verified")
FILES = sorted(RULES_DIR.glob("*.json")) if RULES_DIR.is_dir() else []
CLAIMS = int(os.environ.get("TEND_REAL_CLAIMS", "150"))


@pytest.mark.skipif(not FILES, reason=f"no verified rules in {RULES_DIR}")
@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_real_jurisdiction(path):
    rules, sha = load_rules(path)
    law = Law(rules, sha)
    for index in range(CLAIMS):
        rng = claim_rng(11, rules["jurisdiction"], index)
        data = generate(rules, rng)
        out = law.evaluate(data)
        assert invariant_errors(law, data, out) == [], f"claim {index}"
        shuffled = copy.deepcopy(data)
        random.Random(index).shuffle(shuffled["items"])
        assert law.evaluate(shuffled) == out
        assert out["law_image_sha256"] == sha
