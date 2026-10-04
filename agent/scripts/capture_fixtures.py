"""Refresh the test fixtures from a running Tend API, so the mocked API in tests/ answers with real captures.

    TEND_API_URL=http://127.0.0.1:8000 uv run python scripts/capture_fixtures.py

Every capture is the fictional demo persona or the public law corpus. Nothing is written to the API.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
KEEP = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units", "unit", "tags")

ANSWERS = {
    "answer_MI_exam.json": {"question": "Can the hospital in Michigan bill me for the forensic exam?", "st": "MI"},
    "answer_MI_counseling.json": {"question": "Does Michigan cover counseling, and is there a limit?", "st": "MI"},
    "answer_MI_deadline.json": {"question": "What is the deadline to apply in Michigan?", "st": "MI"},
    "answer_MI_unknown.json": {"question": "Can I get money for my dog's vet bills?", "st": "MI"},
    "answer_OH_deadline.json": {"question": "What is the deadline to apply in Ohio?", "st": "OH"},
}


def main() -> int:
    base = os.environ.get("TEND_API_URL", "http://127.0.0.1:8000").rstrip("/")
    with httpx.Client(base_url=base, timeout=60) as c:

        def get(path: str) -> object:
            r = c.get(path)
            r.raise_for_status()
            return r.json()

        def post(path: str, body: object, **kw: object) -> object:
            r = c.post(path, json=body, **kw)
            r.raise_for_status()
            return r.json()

        out: dict[str, object] = {
            "jurisdictions.json": get("/api/jurisdictions"),
            "MI.json": get("/api/jurisdictions/MI"),
            "OH.json": get("/api/jurisdictions/OH"),
            "check_MI.json": post(
                "/api/agent/check", {"st": "MI", "incident_date": "2026-06-14", "forensic_exam": True, "police_report": "no"}
            ),
            "check_MI_unsure.json": post("/api/agent/check", {"st": "MI", "incident_date": "2026-06-14", "police_report": "no"}),
            "check_MI_noexam.json": post(
                "/api/agent/check", {"st": "MI", "incident_date": "2026-06-14", "forensic_exam": False, "police_report": "no"}
            ),
        }
        for name, body in ANSWERS.items():
            out[name] = post("/api/agent/answer", body)

        scan = post("/api/scan", {"persona_id": "rowan-mi", "st": "MI"})
        bill_id = next(d["bill_id"] for d in scan["documents"] if d.get("bill_id"))  # type: ignore[index]
        audit = post("/api/bill/audit", {"bill_id": bill_id, "persona_id": "rowan-mi", "scan_id": scan["scan_id"]})  # type: ignore[index]
        items = [dict(i, confirmed=True) for i in scan["engine_input"]["items"] if not i.get("is_bill")]  # type: ignore[index]
        items += [dict(i, confirmed=True) for i in audit["engine_items"]]  # type: ignore[index]
        body = {**scan["engine_input"], "items": [{k: i[k] for k in KEEP if k in i} for i in items]}  # type: ignore[index]
        out["scan_rowan_mi.json"] = scan
        out["audit_rowan_mi.json"] = audit
        out["claim_rowan_mi.json"] = post("/api/claim", body)

    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, data in out.items():
        (FIXTURES / name).write_text(json.dumps(data, indent=1, sort_keys=False) + "\n")
        print(f"wrote tests/fixtures/{name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
