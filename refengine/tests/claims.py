"""Builders for test claims against the synthetic ZZ jurisdiction."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from tend_ref import evaluate

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = Path(__file__).parent / "golden"
INCIDENT = "2026-06-14"
AS_OF = "2026-10-03"

_ZZ = json.loads((FIXTURES / "ZZ.json").read_text(encoding="utf-8"))


def zz() -> dict:
    return copy.deepcopy(_ZZ)


def without(rules: dict, *names: str) -> dict:
    # Drop rules by id or by category.
    out = copy.deepcopy(rules)
    out["rules"] = [r for r in out["rules"] if r["id"] not in names and r["category"] not in names]
    return out


def only(rules: dict, category: str, *ids: str) -> dict:
    # Keep just the listed rules of one category; every other category stays.
    out = copy.deepcopy(rules)
    out["rules"] = [r for r in out["rules"] if r["category"] != category or r["id"] in ids]
    return out


def set_params(rules: dict, rule_id: str, **params) -> dict:
    out = copy.deepcopy(rules)
    rule = next(r for r in out["rules"] if r["id"] == rule_id)
    rule["params"] = {**rule.get("params", {}), **params}
    return out


def replace_params(rules: dict, rule_id: str, params: dict) -> dict:
    out = copy.deepcopy(rules)
    next(r for r in out["rules"] if r["id"] == rule_id)["params"] = params
    return out


def add_rule(rules: dict, rule_id: str, category: str, **params) -> dict:
    out = copy.deepcopy(rules)
    out["rules"].append({
        "id": rule_id, "category": category, "params": params,
        "summary": "Test rule.", "quote": "Test rule.", "source_id": "ZZ-S1", "pinpoint": "ZZ Test Code 9.9",
    })
    return out


def item(item_id: str, expense: str = "medical", amount: int = 10_000, date: str = "2026-07-01",
         confirmed: bool = True, insurance: int = 0, units: int = 0, is_bill: bool = False) -> dict:
    return {
        "item_id": item_id, "date": date, "amount_cents": amount, "expense": expense,
        "confirmed": confirmed, "insurance_paid_cents": insurance, "is_bill": is_bill,
        "units": units, "description": "test line",
    }


def claim(*items: dict, incident: str = INCIDENT, as_of: str = AS_OF, police_report: str = "yes",
          forensic_exam: bool = True, jurisdiction: str = "ZZ") -> dict:
    return {
        "jurisdiction": jurisdiction,
        "context": {"incident_date": incident, "as_of_date": as_of,
                    "police_report": police_report, "forensic_exam": forensic_exam},
        "items": list(items),
    }


def run(*items: dict, rules: dict | None = None, **context) -> dict:
    return evaluate(rules if rules is not None else zz(), claim(*items, **context))


def line(out: dict, item_id: str) -> dict:
    return next(entry for entry in out["lines"] if entry["item_id"] == item_id)


def trace(out: dict, item_id: str | None = None) -> list[tuple]:
    return [(t["op"], t["rule_id"], t["delta_cents"]) for t in out["trace"]
            if item_id is None or t["item_id"] == item_id]


def check_ops(out: dict) -> list[tuple]:
    return [(t["op"], t["rule_id"]) for t in out["trace"] if t["item_id"] is None]
