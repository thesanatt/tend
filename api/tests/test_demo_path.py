"""The demo path end to end, in the order and shapes the web app uses (web/lib/api.ts)."""

from __future__ import annotations

import io

from helpers import confirm_all
from pypdf import PdfReader


def test_demo_path(client):
    scan = client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI", "incident_date": "2026-06-14"}).json()
    assert scan["fictional"] is True
    bill_id = next(i["bill_id"] for i in scan["items"] if i.get("bill_id"))

    audit = client.post("/api/bill/audit", json={"bill_id": bill_id, "persona_id": "rowan-mi"})
    assert audit.status_code == 200, audit.text
    audit = audit.json()
    assert audit["lines_sum_cents"] == audit["total_cents"] == 44300
    held = {h["item_id"] for h in audit["holds"]}
    assert audit["held_cents"] == 32500 and audit["payable_cents"] == 11800

    claim_input = confirm_all(scan["engine_input"])
    r = client.post("/api/claim", json=claim_input)
    assert r.status_code == 200, r.text
    assert r.headers["x-tend-engine"] == "reference"
    output = r.json()
    statuses = {ln["item_id"]: ln["status"] for ln in output["lines"]}
    assert {statuses[i] for i in held} == {"held"}
    assert statuses["nessie:p-0004"] == "excluded"  # the phone

    pay_lines = [ln for ln in audit["lines"] if ln["item_id"] not in held]
    proposal = client.post(
        "/api/actions/propose",
        json={
            "kind": "pay_bill",
            "bill_id": bill_id,
            "item_ids": [ln["item_id"] for ln in pay_lines],
            "amount_cents": sum(ln["amount_cents"] for ln in pay_lines),
            "from_account_id": scan["account"]["id"],
            "payee": audit["provider"],
        },
    )
    assert proposal.status_code == 200, proposal.text
    proposal = proposal.json()
    assert proposal["amount_cents"] == 11800
    done = client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]})
    assert done.status_code == 200, done.text
    result = done.json()
    assert result["status"] == "done" and result["read_back_matches"] is True
    assert result["nessie_id"] and result["audit_id"].startswith("aud_") and result["at"] and result["message"]

    pdf = client.get(f"/api/packet/{output['claim_id']}.pdf")
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert len(PdfReader(io.BytesIO(pdf.content)).pages) > 6  # summary pages, then the state's 6-page application

    share = client.post("/api/share", json={"input": claim_input, "output": output})
    assert share.status_code == 200, share.text
    share = share.json()
    assert share["matches_client"] is True
    view = client.get(f"/api/share/{share['token']}").json()
    assert view["read_only"] is True and view["token"] == share["token"]
    assert view["input"] == claim_input and view["output"]["totals"] == output["totals"]
    assert view["engine"] == "reference" and view["created_at"] and view["expires_at"]
