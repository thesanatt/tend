"""The random claim generator: deterministic, valid, and broad enough to reach every v1.2 path."""

import json
import re
from collections import Counter

from claims import zy, zz
from tend_ref import EngineInputError, Law, evaluate
from tend_ref.claim import InvalidJson, loads, read_claim
from tend_ref.gen import claim_rng, generate, generate_text
from tend_ref.invariants import invariant_errors
from tend_ref.law import ITEM_EXPENSES, UNITS
from tend_ref.randlaw import random_law

import random


def laws():
    return [Law(zz()), Law(zy())] + [Law(random_law(random.Random(f"gen-test:{i}"), f"R{i}")) for i in range(30)]


def test_same_seed_gives_the_same_claim():
    law = Law(zz())
    a = generate(law, claim_rng(1, "ZZ", 5))
    assert a == generate(law, claim_rng(1, "ZZ", 5))
    assert a != generate(law, claim_rng(1, "ZZ", 6))
    assert a != generate(law, claim_rng(2, "ZZ", 5))
    assert generate_text(law, claim_rng(3, "ZZ", 9)) == generate_text(law, claim_rng(3, "ZZ", 9))


def test_generated_claims_are_valid_and_look_like_bank_lines():
    law = Law(zz())
    for index in range(400):
        data = generate(law, claim_rng(3, "ZZ", index))
        read_claim(data, law)  # raises on anything the engine would refuse
        ids = [it["item_id"] for it in data["items"]]
        assert len(ids) == len(set(ids))
        for it in data["items"]:
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", it["date"])
            assert it.get("expense", "unknown") in ITEM_EXPENSES
            assert it.get("unit") in UNITS + (None,)
            for key in ("amount_cents", "insurance_paid_cents", "units"):
                value = it.get(key) or 0
                assert isinstance(value, int) and 0 <= value <= 2**53 - 1


def test_generated_claims_satisfy_the_invariants():
    for law in laws():
        for index in range(60):
            data = generate(law, claim_rng(4, law.jurisdiction, index))
            assert invariant_errors(law, data, evaluate(law, data)) == []


def test_generator_reaches_every_status_cap_check_and_flag():
    ops, checks, paths = Counter(), Counter(), Counter()
    for law in laws():
        for index in range(250):
            data = generate(law, claim_rng(5, law.jurisdiction, index))
            out = evaluate(law, data)
            ops.update(t["op"] for t in out["trace"])
            checks.update(f"{name}:{c['status']}" for name, c in out["checks"].items())
            paths.update(out["checks"]["deadline"]["flags"])
            items = {it["item_id"]: it for it in data["items"]}
            for line in out["lines"]:
                it = items[line["item_id"]]
                if it.get("expense") == "forensic_exam" and line["expense"] == "medical":
                    paths["exam_as_medical"] += 1
                for flag in line["flags"]:
                    rule = law.by_id[flag.split(":", 1)[1]]
                    paths["unit_mismatch" if it.get("unit") and it.get("unit") != rule.unit and (it.get("units") or 0)
                          else "unit_missing"] += 1
    for op in ("out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible", "collateral",
               "unit_cap", "rate_unverified", "expense_cap", "total_cap"):
        assert ops[op] > 0, op
    for check in ("deadline:ok", "deadline:late", "deadline:unknown", "minimum_loss:met", "minimum_loss:not_met",
                  "minimum_loss:waived", "minimum_loss:may_be_waived", "minimum_loss:unknown", "reporting:satisfied",
                  "reporting:required", "reporting:not_required", "reporting:unknown"):
        assert checks[check] > 0, check
    for path in ("deadline_from_report", "exam_as_medical", "unit_mismatch", "unit_missing"):
        assert paths[path] > 0, path


def test_deadline_boundaries_get_hit():
    law = Law(zz())
    on_the_line = 0
    for index in range(1000):
        data = generate(law, claim_rng(6, "ZZ", index))
        on_the_line += evaluate(law, data)["checks"]["deadline"]["deadline_date"] == data["context"]["as_of_date"]
    assert on_the_line > 20


def test_broken_claims_are_refused_and_well_formed_ones_are_not():
    law = Law(zz())
    refused = malformed = 0
    for index in range(3000):
        raw, doc = generate_text(law, claim_rng(7, "ZZ", index), invalid_share=0.5)
        if doc is not None:
            assert json.loads(raw) == doc
            continue
        try:
            read_claim(loads(raw), law)
        except InvalidJson:
            malformed += 1
        except EngineInputError:
            refused += 1
    assert refused > 300 and malformed > 300
