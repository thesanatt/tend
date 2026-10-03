"""Builders for test claims against the synthetic ZZ law (tests/fixtures/ir/ZZ.json)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from tend_ref import Law, evaluate

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures"
GOLDEN = HERE / "golden"
REPO = HERE.parents[1]
INCIDENT = "2026-06-14"
AS_OF = "2026-10-03"

_ZZ = json.loads((FIXTURES / "ir" / "ZZ.json").read_text(encoding="utf-8"))
_ZY = json.loads((FIXTURES / "ir" / "ZY.json").read_text(encoding="utf-8"))


def zz() -> dict:
    return copy.deepcopy(_ZZ)


def zy() -> dict:
    return copy.deepcopy(_ZY)


def law(rules: list[dict], code: str = "ZZ", skipped: list[dict] | None = None) -> dict:
    """A small IR document for one test."""
    return {"ir_version": 2, "jurisdiction": code, "name": "Test", "rules": rules, "skipped": skipped or []}


def rule(rule_id: str, kind: str, **fields) -> dict:
    return {"id": rule_id, "kind": kind, **fields}


def cap(rule_id: str, expense: str, cents: int, unit: str | None = None, **fields) -> dict:
    if unit:
        return rule(rule_id, "expense_cap", expense=expense, cap_cents=cents, per="unit", unit=unit, **fields)
    return rule(rule_id, "expense_cap", expense=expense, cap_cents=cents, per="claim", **fields)


def without(ir: dict, *names: str) -> dict:
    # Drop rules by id or by kind.
    out = copy.deepcopy(ir)
    out["rules"] = [r for r in out["rules"] if r["id"] not in names and r["kind"] not in names]
    return out


def with_rules(ir: dict, *rules: dict) -> dict:
    out = copy.deepcopy(ir)
    out["rules"] += list(rules)
    return out


def item(item_id: str, expense: str = "medical", amount: int = 10_000, date: str = "2026-07-01",
         confirmed: bool = True, insurance: int = 0, units: int = 0, unit: str | None = None, tags=None,
         is_bill: bool = False) -> dict:
    it = {"item_id": item_id, "date": date, "amount_cents": amount, "expense": expense, "confirmed": confirmed,
          "insurance_paid_cents": insurance, "is_bill": is_bill, "units": units, "description": "test line"}
    if unit is not None:
        it["unit"] = unit
    if tags is not None:
        it["tags"] = tags
    return it


def claim(*items: dict, incident: str = INCIDENT, as_of: str = AS_OF, police_report: str = "yes",
          forensic_exam: bool = True, jurisdiction: str = "ZZ") -> dict:
    return {
        "jurisdiction": jurisdiction,
        "context": {"incident_date": incident, "as_of_date": as_of, "police_report": police_report,
                    "forensic_exam": forensic_exam},
        "items": list(items),
    }


def run(*items: dict, rules: dict | None = None, **context) -> dict:
    ir = rules if rules is not None else zz()
    return evaluate(Law(ir), claim(*items, jurisdiction=ir["jurisdiction"], **context))


def line(out: dict, item_id: str) -> dict:
    return next(entry for entry in out["lines"] if entry["item_id"] == item_id)


def trace(out: dict, item_id: str | None = None) -> list[tuple]:
    return [(t["op"], t["rule_id"], t["delta_cents"]) for t in out["trace"]
            if item_id is None or t["item_id"] == item_id]


def check_ops(out: dict) -> list[tuple]:
    return [(t["op"], t["rule_id"]) for t in out["trace"] if t["item_id"] is None]
