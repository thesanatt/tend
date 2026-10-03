"""The random claim generator: deterministic, valid, and broad enough to reach every branch."""

import json
import re
from collections import Counter

from claims import FIXTURES, zz
from tend_ref import Law
from tend_ref.engine import EXPENSES
from tend_ref.gen import claim_rng, generate
from tend_ref.invariants import invariant_errors

ZY = json.loads((FIXTURES / "ZY.json").read_text(encoding="utf-8"))


def test_same_seed_gives_the_same_claim():
    a = generate(zz(), claim_rng(1, "ZZ", 5))
    b = generate(zz(), claim_rng(1, "ZZ", 5))
    c = generate(zz(), claim_rng(1, "ZZ", 6))
    d = generate(zz(), claim_rng(2, "ZZ", 5))
    assert a == b
    assert a != c and a != d


def test_generated_claims_look_like_bank_lines():
    for index in range(300):
        data = generate(zz(), claim_rng(3, "ZZ", index))
        assert data["jurisdiction"] == "ZZ"
        assert data["context"]["police_report"] in ("yes", "no", "unknown")
        ids = [it["item_id"] for it in data["items"]]
        assert len(ids) == len(set(ids))
        for it in data["items"]:
            assert re.fullmatch(r"nessie:[0-9a-f]{24}|receipt:[0-9a-f]{12}:\d", it["item_id"])
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", it["date"])
            assert it["expense"] in EXPENSES | {"unknown"}
            for key in ("amount_cents", "insurance_paid_cents", "units"):
                assert isinstance(it[key], int) and it[key] >= 0
            assert it["description"]


def test_generated_claims_satisfy_the_invariants():
    for rules in (zz(), ZY):
        law = Law(rules)
        for index in range(400):
            data = generate(rules, claim_rng(4, rules["jurisdiction"], index))
            assert invariant_errors(law, data, law.evaluate(data)) == []


def test_generator_reaches_every_status_cap_and_check():
    ops, checks = Counter(), Counter()
    for rules in (zz(), ZY):
        law = Law(rules)
        for index in range(1500):
            out = law.evaluate(generate(rules, claim_rng(5, rules["jurisdiction"], index)))
            ops.update(t["op"] for t in out["trace"])
            checks.update(f"{name}:{c['status']}" for name, c in out["checks"].items())
    for op in ("out_of_window", "held", "exam_as_medical", "excluded", "unknown_rule", "needs_confirmation",
               "eligible", "collateral", "rate_cap", "rate_unverified", "expense_cap", "total_cap"):
        assert ops[op] > 0, op
    for check in ("deadline:ok", "deadline:late", "deadline:unknown", "minimum_loss:met",
                  "minimum_loss:not_met", "minimum_loss:waived", "minimum_loss:unknown",
                  "reporting:satisfied", "reporting:required", "reporting:unknown"):
        assert checks[check] > 0, check


def test_deadline_boundaries_get_hit():
    on_the_line = 0
    for index in range(1000):
        data = generate(zz(), claim_rng(6, "ZZ", index))
        deadline = Law(zz()).evaluate(data)["checks"]["deadline"]["deadline_date"]
        on_the_line += deadline == data["context"]["as_of_date"]
    assert on_the_line > 20
