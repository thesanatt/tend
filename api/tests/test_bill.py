from __future__ import annotations

import io

import pytest
from helpers import FIXTURES, confirm_all, scan_rowan
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from tend_api.bill import BillRefused, balance_checks, extract_bill, match_expense, nessie_bill_check

TEXT_BILL = (FIXTURES / "seed" / "bills" / "riverbend-2026-06.txt").read_bytes()


def audit(client, **body):
    return client.post("/api/bill/audit", json={"st": "MI", "incident_date": "2026-06-14", **body})


def test_extract_text_bill():
    bill = extract_bill(TEXT_BILL, "text")
    assert bill.provider == "Riverbend General Hospital (fictional)"
    assert bill.bill_id == "RB-2026-0614"
    assert [line.amount_cents for line in bill.lines] == [7500, 4300, 32500]
    assert [line.expense for line in bill.lines] == ["medical", "medical", "forensic_exam"]
    assert bill.total_cents == bill.amount_due_cents == 44300
    assert bill.lines[2].item_id == f"bill:{bill.sha256[:16]}:3"
    assert balance_checks(bill)[0]["ok"] is True


@pytest.mark.parametrize(
    "description,expense",
    [
        ("Sexual assault medical forensic examination", "forensic_exam"),
        ("SANE nurse exam", "forensic_exam"),
        ("Evidence collection kit", "forensic_exam"),
        ("Psychotherapy, 50 min", "counseling"),
        ("ED visit level 4", "medical"),
        ("Pharmacy: prophylactic medication", "medical"),
        ("Parking garage", "unknown"),
    ],
)
def test_match_expense(description, expense):
    assert match_expense(description)[0] == expense


def test_lines_must_add_up_or_the_audit_refuses(client):
    bad = TEXT_BILL.decode().replace(
        "Total charges                                                    $443.00",
        "Total charges                                                    $450.00",
    )
    r = audit(client, bill_text=bad)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "do not add up" in detail["message"]
    assert detail["checks"][0] == {"name": "lines_equal_total", "ok": False, "lines_sum_cents": 44300, "total_cents": 45000}


def test_bill_without_total_is_refused():
    with pytest.raises(BillRefused):
        balance_checks(extract_bill(b"06/14/2026 Lab panel $43.00\n", "text"))


def test_adjustments_reconcile_total_and_amount_due():
    text = b"""Clinic (fictional)
06/14/2026  Office visit          $200.00
06/20/2026  Payment received      ($50.00)
Total charges                     $200.00
Insurance paid                    ($25.00)
Amount due                        $125.00
"""
    bill = extract_bill(text, "text")
    assert [a["amount_cents"] for a in bill.adjustments] == [5000, 2500]
    assert [c["ok"] for c in balance_checks(bill)] == [True, True]


def test_audit_holds_the_exam_line_and_pays_the_rest(client):
    r = audit(client, bill_id="riverbend-2026-06")
    assert r.status_code == 200, r.text
    assert r.headers["X-Tend-Engine"] == "reference"
    data = r.json()
    assert data["bill"]["lines_sum_cents"] == data["bill"]["total_cents"] == 44300
    assert data["held_cents"] == 32500
    assert data["payable_cents"] == 11800
    [hold] = data["holds"]
    assert hold["message"] == "Hold this line. Ask billing to remove it first."
    cited = {c["rule_id"]: c for c in hold["citations"]}
    assert cited["MI-EXAM-1"]["pinpoint"] == "MCL 18.355a(2)"
    assert "shall not submit a bill" in cited["MI-EXAM-1"]["quote"]
    assert hold["payers"]
    [flag] = data["flags"]
    assert flag["kind"] == "insurance_billed_for_exam"
    assert {c["rule_id"] for c in flag["citations"]} == {"MI-EXAM-2"}  # the consent rule, MCL 18.355a(3)(a)
    assert {ln["status"] for ln in data["lines"] if ln["expense"] == "medical"} == {"needs_confirmation"}


def test_audit_finds_the_bill_from_the_persona(client):
    data = audit(client, persona_id="rowan-mi").json()
    assert data["bill"]["bill_id"] == "RB-2026-0614"
    assert data["held_cents"] == 32500


def test_structured_bill_is_checked_against_nessie(client):
    data = audit(client, bill_id="riverbend-structured", persona_id="rowan-mi").json()
    assert {"name": "matches_nessie_bill", "ok": True, "nessie_bill_id": "b-riverbend-0001"} in data["checks"]


def test_nessie_mismatch_is_detected():
    bill = extract_bill((FIXTURES / "seed" / "bills" / "riverbend-structured.json").read_bytes(), "json")
    snapshot = {"bills": [{"_id": "b-riverbend-0001", "payment_amount": 400}]}
    assert nessie_bill_check(bill, snapshot)["ok"] is False
    assert nessie_bill_check(bill, {"bills": [{"_id": "b-riverbend-0001", "payment_amount": 443}]})["ok"] is True


def test_json_bill_must_use_integer_cents():
    with pytest.raises(BillRefused):
        extract_bill(b'{"lines": [{"date": "2026-06-14", "description": "x", "amount_cents": 10.5}], "total_cents": 1050}', "json")


def test_pdf_bill_is_read_from_its_text_layer():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    rows = [
        "Riverbend General Hospital (fictional)",
        "Statement date: 07/02/2026",
        "",
        "06/14/2026   Emergency department visit, level 3, copay      $75.00",
        "06/14/2026   Laboratory panel                                 $43.00",
        "06/14/2026   Medical forensic exam, deductible applied       $325.00",
        "Total charges                                               $443.00",
        "Amount due                                                  $443.00",
    ]
    for i, row in enumerate(rows):
        c.drawString(72, 720 - 16 * i, row)
    c.save()
    bill = extract_bill(buf.getvalue(), "pdf")
    assert bill.format == "pdf"
    assert [line.amount_cents for line in bill.lines] == [7500, 4300, 32500]
    assert bill.lines[2].expense == "forensic_exam"
    assert balance_checks(bill)[0]["ok"] is True


def test_missing_bill_is_404(client):
    assert audit(client, bill_id="no-such-bill").status_code == 404


def test_audit_needs_an_incident_date(client):
    r = client.post("/api/bill/audit", json={"st": "MI", "bill_id": "riverbend-2026-06"})
    assert r.status_code == 422


def test_bill_lines_become_evidence_for_the_claim(client):
    scan = scan_rowan(client)
    data = audit(client, persona_id="rowan-mi", scan_id=scan["scan_id"]).json()
    assert data["scan_id"] == scan["scan_id"]
    claim_input = confirm_all({**scan["engine_input"], "items": data["engine_items"]})
    claim = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=claim_input).json()
    assert claim["refused"] == []
    assert claim["totals"]["held_cents"] == 32500


def test_audit_without_scan_creates_its_own_evidence(client):
    data = audit(client, bill_id="riverbend-2026-06").json()
    claim_input = confirm_all(
        {
            "jurisdiction": "MI",
            "context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03", "forensic_exam": True},
            "items": data["engine_items"],
        }
    )
    claim = client.post("/api/claim", params={"scan_id": data["scan_id"]}, json=claim_input).json()
    assert claim["refused"] == []
