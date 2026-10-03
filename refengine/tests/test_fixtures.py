"""The synthetic fixtures follow rules/SCHEMA.md the way verify.py checks real files."""

import hashlib
import json
import re

import pytest

from claims import FIXTURES
from tend_ref.engine import EXPENSES

CATEGORIES = {"exam_no_bill", "exam_payment", "total_cap", "expense_cap", "covered_expense", "excluded_expense",
              "filing_deadline", "reporting_requirement", "minimum_loss", "collateral_source",
              "conduct_reduction", "emergency_award", "eligible_crime", "residency"}
FILES = sorted(FIXTURES.glob("*.json"))


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_fixture_matches_the_schema(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("jurisdiction", "name", "program", "sources", "rules", "coverage", "confidence"):
        assert key in data
    texts = {}
    for source in data["sources"]:
        raw = (FIXTURES / source["raw_path"].rsplit("/", 1)[-1]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == source["sha256"]
        texts[source["id"]] = raw.decode("utf-8")
    ids = [r["id"] for r in data["rules"]]
    assert len(ids) == len(set(ids))
    for rule in data["rules"]:
        assert rule["category"] in CATEGORIES
        expense = rule.get("expense") or rule["params"].get("expense")
        assert expense is None or expense in EXPENSES
        assert rule["quote"] in texts[rule["source_id"]], rule["id"]
        assert rule["pinpoint"]
        for key in ("amount_cents", "years", "days", "days_lost", "count_limit", "within_days"):
            value = rule["params"].get(key)
            if value is None:
                continue
            numbers = {float(n.replace(",", "")) for n in re.findall(r"\d[\d,]*(?:\.\d+)?", rule["quote"])}
            assert (value / 100 if key == "amount_cents" else value) in numbers, (rule["id"], key)
