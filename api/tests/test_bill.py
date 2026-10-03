from __future__ import annotations

import dataclasses
import io
import shutil

import pytest
from helpers import FIXTURES, client_for, confirm_all, make_services, scan_rowan
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


def test_lines_must_add_up_or_the_audit_refuses():
    bad = TEXT_BILL.decode().replace(
        "Total charges                                                    $443.00",
        "Total charges                                                    $450.00",
    )
    with pytest.raises(BillRefused) as caught:
        balance_checks(extract_bill(bad.encode(), "text"))
    detail = caught.value.detail
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
    assert data["lines_sum_cents"] == data["total_cents"] == 44300
    assert data["held_cents"] == 32500
    assert data["payable_cents"] == 11800
    [hold] = data["holds"]
    assert hold["message"] == "Don't pay this line. Ask billing to remove it first."
    cited = {c["rule_id"]: c for c in hold["citations"]}
    assert cited["MI-EXAM-1"]["pinpoint"] == "MCL 18.355a(2)"
    assert "shall not submit a bill" in cited["MI-EXAM-1"]["quote"]
    assert hold["payers"]
    [flag] = data["flags"]
    assert flag["kind"] == "insurance_billed_for_exam"
    assert {c["rule_id"] for c in flag["citations"]} == {"MI-EXAM-2"}  # the consent rule, MCL 18.355a(3)(a)
    assert {ln["status"] for ln in data["lines"] if ln["expense"] == "medical"} == {"eligible"}
    assert hold["rule_ids"] and "MI-EXAM-1" in hold["rule_ids"]


def test_audit_finds_the_bill_from_the_persona(client):
    data = audit(client, persona_id="rowan-mi").json()
    assert data["statement_id"] == "RB-2026-0614"
    assert data["bill_id"] == data["nessie_bill_id"] == "b-riverbend-0001"
    assert data["replaces_item_id"] == "nessie:b-riverbend-0001"
    assert data["held_cents"] == 32500


def test_audit_takes_the_web_request_shape(client):
    # The web sends only the Nessie bill id and the persona; the state and dates come from the persona.
    r = client.post("/api/bill/audit", json={"bill_id": "b-riverbend-0001", "persona_id": "rowan-mi"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["bill_id"] == "b-riverbend-0001"
    assert data["provider"] == "Riverbend General Hospital (fictional)"
    assert data["statement_date"] == "07/02/2026" and data["service_date"] == "2026-06-14"
    assert data["total_cents"] == data["lines_sum_cents"] == 44300
    assert [ln["line_no"] for ln in data["lines"]] == [1, 2, 3]
    [hold] = data["holds"]
    assert hold["item_id"] == data["lines"][2]["item_id"] and hold["amount_cents"] == 32500 and hold["rule_ids"]
    checks = {c["name"]: c["ok"] for c in data["checks"]}
    assert checks == {
        "lines_equal_total": True,
        "total_less_adjustments_equals_due": True,
        "matches_snapshot_document": True,
        "matches_nessie_bill": True,
    }


def test_tampered_bill_file_is_refused(tmp_path, settings, clock):
    seed = tmp_path / "seed"
    shutil.copytree(FIXTURES / "seed", seed)
    bill = seed / "bills" / "riverbend-2026-06.txt"
    bill.write_text(bill.read_text().replace("Laboratory panel", "Laboratory panel, rush"))
    tampered = client_for(make_services(dataclasses.replace(settings, seed_dir=seed), clock))
    r = tampered.post("/api/bill/audit", json={"bill_id": "b-riverbend-0001", "persona_id": "rowan-mi"})
    assert r.status_code == 422
    assert "not the bill recorded" in r.json()["detail"]["message"]
    scan = tampered.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"}).json()
    assert scan["bill_errors"] and "nessie:b-riverbend-0001" in {i["item_id"] for i in scan["items"]}


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


def test_audit_lines_evaluate_the_same_as_a_claim(client):
    # Nothing ties the audit to a later claim on the server; the device sends the same lines back.
    scan = scan_rowan(client)
    data = audit(client, persona_id="rowan-mi").json()
    claim_input = confirm_all({**scan["engine_input"], "items": data["engine_items"]})
    claim = client.post("/api/claim", json=claim_input).json()
    assert claim["totals"]["held_cents"] == data["held_cents"] == 32500
    assert {ln["item_id"]: ln["status"] for ln in claim["lines"]} == {ln["item_id"]: ln["status"] for ln in data["lines"]}


def test_audit_stores_nothing(client, services):
    before = services.repo.corpus_counts()
    audit(client, persona_id="rowan-mi")
    assert services.repo.corpus_counts() == before
    assert services.repo.audit_rows() == []


def test_bill_text_is_not_accepted_here(client):
    # A survivor's own bill goes through POST /api/ai/bill, which needs consent; this route reads demo bills only.
    r = audit(client, bill_text="Clinic\n06/14/2026  Laboratory panel  43.00\nTotal 43.00")
    assert r.status_code == 422


@pytest.mark.parametrize(
    "row",
    ["06/14/2026  Laboratory panel  (43.00", "06/14/2026  Laboratory panel  43.00)"],
)
def test_unbalanced_amount_is_refused_not_a_crash(row):
    with pytest.raises(BillRefused) as caught:
        extract_bill(f"Clinic\n{row}\nTotal 43.00".encode(), "text")
    assert "could not read the amount" in caught.value.detail["message"]


def test_unbalanced_total_is_refused_not_a_crash():
    with pytest.raises(BillRefused):
        balance_checks(extract_bill(b"Clinic\n06/14/2026  Laboratory panel  43.00\nTotal (43.00", "text"))
