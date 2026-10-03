"""Golden cases: inputs with outputs worked out by hand from the SPEC, one step at a time.

Any engine can run these: evaluate tests/golden/<name>.input.json against tests/fixtures/ZZ.json
and compare with <name>.expected.json, ignoring law_image_sha256.
"""

import json

import pytest

from claims import GOLDEN, zz
from tend_ref import evaluate

CASES = sorted(p.name.removesuffix(".input.json") for p in GOLDEN.glob("*.input.json"))


@pytest.mark.parametrize("name", CASES)
def test_golden_case(name):
    data = json.loads((GOLDEN / f"{name}.input.json").read_text(encoding="utf-8"))
    expected = json.loads((GOLDEN / f"{name}.expected.json").read_text(encoding="utf-8"))
    out = evaluate(zz(), data)
    out.pop("law_image_sha256")
    assert out["lines"] == expected["lines"]
    assert out["totals"] == expected["totals"]
    assert out["checks"] == expected["checks"]
    assert out["trace"] == expected["trace"]
    assert out == expected


def test_there_is_at_least_one_golden_case():
    assert CASES
