"""The local-first demo path end to end, in the order the device calls the API."""

from __future__ import annotations

import base64
import io
import os

from pypdf import PdfReader


def test_demo_path(client, services):
    assert "MI" in {j["jurisdiction"] for j in client.get("/api/jurisdictions").json()["jurisdictions"]}

    # 1. Connect the (mock) bank: the relay returns statement rows and keeps nothing.
    bank = client.get("/api/bank/rowan-mi/transactions").json()
    assert bank["fictional"] is True and bank["source"] == "snapshot" and bank["count"] == len(bank["txns"])
    [bill] = bank["bills"]
    assert bill["itemized"] is True

    # 2. Sort the rows. On a device without on-device AI, cloud AI with the survivor's yes.
    sorted_rows = client.post("/api/ai/classify", json={"consent": True, "incident_date": "2026-06-14", "txns": bank["txns"]}).json()
    items = sorted_rows["items"]
    assert items and all(i["source"] in ("rule", "cloud_ai") for i in items)

    # 3. The hospital bill: the exam line is held under the exam billing law.
    audit = client.post("/api/bill/audit", json={"bill_id": bill["bill_id"], "persona_id": "rowan-mi"}).json()
    assert audit["held_cents"] == 32500 and audit["payable_cents"] == 11800

    # 4. The claim, evaluated (the device's WebAssembly engine does the same; this is the fallback).
    claim_input = {
        "jurisdiction": "MI",
        "context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03", "police_report": "no", "forensic_exam": True},
        "items": [{**i, "confirmed": True} for i in items] + audit["engine_items"],
    }
    r = client.post("/api/claim", json=claim_input)
    assert r.status_code == 200, r.text
    assert r.headers["x-tend-engine"] == "reference"
    output = r.json()
    statuses = {ln["item_id"]: ln["status"] for ln in output["lines"]}
    assert statuses[audit["holds"][0]["item_id"]] == "held"
    assert statuses["nessie:p-0004"] == "excluded"  # the phone

    # 5. Pay what is left on the bill, with the six-digit code.
    proposal = client.post(
        "/api/actions/propose",
        json={
            "kind": "pay_bill",
            "bill_id": bill["bill_id"],
            "amount_cents": audit["payable_cents"],
            "from": bank["account"]["id"],
            "payee": audit["provider"],
        },
    ).json()
    done = client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).json()
    assert done["status"] == "done" and done["read_back_matches"] is True and done["audit_id"].startswith("aud_")
    assert client.get("/api/audit").json()["chain"]["ok"] is True

    # 6. Share with an advocate: sealed on the device, so the server only ever sees ciphertext.
    ciphertext = base64.b64encode(os.urandom(2048)).decode()
    share = client.post(
        "/api/shares", json={"ciphertext": ciphertext, "iv": base64.b64encode(os.urandom(12)).decode(), "once": True}
    ).json()
    assert client.get(share["api_path"]).json()["ciphertext"] == ciphertext
    assert client.get(share["api_path"]).status_code == 410

    # 7. The packet, rendered and returned.
    pdf = client.post("/api/packet", params={"persona_id": "rowan-mi"}, json=claim_input)
    assert pdf.status_code == 200 and len(PdfReader(io.BytesIO(pdf.content)).pages) > 6

    # What the server holds afterwards: the corpus, one tombstoned share, one finished payment, two log rows.
    assert len(services.repo.audit_rows()) == 2
