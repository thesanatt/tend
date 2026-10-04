"""Rowan's scan and bill audit for web/fixtures, from the API itself (fictional seed data only).

The fixtures behind /share/demo and the web tests must show the same Rowan as the demo: the seed's
Michigan persona, its $443.00 Riverbend General bill, and the $325.00 exam line the law holds. This
asks the API (in memory, without the repo .env: no keys, no network) for POST /api/scan and
POST /api/bill/audit and writes what it answered. Then `npm run fixtures` runs the engine input and
output through the WebAssembly engine.

usage (from the repo root):
    uv run --project api python web/scripts/scan-fixtures.py
    (cd web && npm run fixtures)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "fixtures"
os.environ.update({"TEND_ENV_FILE": "", "TEND_DB": ":memory:", "TEND_BANK": "dry_run", "TEND_CLOUD_AI": "0",
                   "TEND_RELAY_LIVE": "0"})
sys.path.insert(0, str(ROOT / "api"))

from fastapi.testclient import TestClient  # noqa: E402

from tend_api.app import create_app  # noqa: E402

# What the web's ScanItem keeps (web/lib/types.ts): the engine fields with SPEC v1.2's unit and tags,
# and what the screens show.
ITEM_KEYS = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units",
             "unit", "tags", "description", "merchant", "confidence", "source", "reason", "bill_id")


def write(name: str, data: object) -> None:
    (OUT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    with TestClient(create_app()) as client:
        scan = client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"})
        scan.raise_for_status()
        s = scan.json()
        bill = client.post("/api/bill/audit", json={"persona_id": "rowan-mi"})
        bill.raise_for_status()
        b = bill.json()
    items = [{k: item.get(k) for k in ITEM_KEYS if item.get(k) is not None or k == "unit"} for item in s["items"]]
    write("rowan-mi.scan.json", {
        "persona_id": s["persona_id"],
        "st": s["st"],
        "incident_date": s["incident_date"],
        "as_of_date": s["as_of_date"],
        "account": s["account"],
        "read_count": s["read_count"],
        "items": items,
    })
    write("riverbend-bill.json", {
        "bill_id": b["bill_id"],
        "provider": b["provider"],
        "statement_date": b["statement_date"],
        "service_date": b["service_date"],
        "account_ref": b["account_ref"],
        "total_cents": b["total_cents"],
        "lines": [{k: line[k] for k in ("line_no", "item_id", "description", "amount_cents", "expense")} for line in b["lines"]],
        "lines_sum_cents": b["lines_sum_cents"],
        "holds": [{k: h[k] for k in ("item_id", "amount_cents", "rule_ids")} for h in b["holds"]],
    })
    print(f"wrote web/fixtures/rowan-mi.scan.json ({len(items)} items) and riverbend-bill.json "
          f"(total {b['total_cents']}, held {sum(h['amount_cents'] for h in b['holds'])})")


if __name__ == "__main__":
    main()
