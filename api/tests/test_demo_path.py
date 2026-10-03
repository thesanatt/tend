"""The demo path end to end: scan, audit the bill, claim, pay the $118, packet, share."""
from __future__ import annotations

import io

from helpers import confirm_all, scan_rowan
from pypdf import PdfReader


def test_demo_path(client):
    scan = scan_rowan(client)
    assert scan["fictional"] is True
    assert all(item["confirmed"] is False for item in scan["items"])

    audit = client.post("/api/bill/audit", json={"st": "MI", "persona_id": "rowan-mi", "scan_id": scan["scan_id"]})
    assert audit.status_code == 200, audit.text
    audit = audit.json()
    assert audit["held_cents"] == 32500
    assert audit["payable_cents"] == 11800

    # The itemized lines stand in for the single Nessie bill they explain.
    items = [i for i in scan["engine_input"]["items"] if i["item_id"] != "nessie:b-riverbend-0001"] + audit["engine_items"]
    claim_input = confirm_all({**scan["engine_input"], "items": items})
    r = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=claim_input)
    assert r.status_code == 200, r.text
    assert r.headers["x-tend-engine"] == "reference"
    claim = r.json()
    assert claim["refused"] == []
    statuses = {ln["item_id"]: ln["status"] for ln in claim["lines"]}
    exam = next(i["item_id"] for i in audit["engine_items"] if i["expense"] == "forensic_exam")
    assert statuses[exam] == "held"
    assert statuses["nessie:p-0004"] == "excluded"  # the phone

    proposed = client.post("/api/actions/propose", json={
        "from": "acct-checking-0001", "payee": "Riverbend General Hospital (fictional)", "amount_cents": audit["payable_cents"],
        "claim_id": claim["claim_id"],
    }).json()
    done = client.post("/api/actions/confirm", json={"action_id": proposed["action_id"], "confirm_code": proposed["confirm_code"]})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "executed"
    assert done.json()["readback"]["ok"] is True

    pdf = client.get(f"/api/packet/{claim['claim_id']}.pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    reader = PdfReader(io.BytesIO(pdf.content))
    assert len(reader.pages) > 6  # summary pages, then the state's 6-page application

    link = client.post("/api/share", json={"claim_id": claim["claim_id"]}).json()
    shared = client.get(link["api_path"])
    assert shared.status_code == 200
    assert shared.json()["read_only"] is True
