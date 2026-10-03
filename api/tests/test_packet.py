from __future__ import annotations

import io

import pytest
from helpers import confirm_all, scan_rowan
from pypdf import PdfReader

from tend_api.config import API_DIR
from tend_api.forms import FORBIDDEN, MI, FormGuardError, application_values, filled_fields, guard

MI_FORM = API_DIR / "forms" / "MI" / "application.pdf"


def make_claim(client, st="MI", scan_extra=None, with_scan=True):
    scan = scan_rowan(client, **(scan_extra or {}))
    audit = client.post("/api/bill/audit", json={"st": st, "persona_id": "rowan-mi", "scan_id": scan["scan_id"]}).json()
    items = [i for i in scan["engine_input"]["items"] if not i["is_bill"]] + audit["engine_items"]
    body = confirm_all({**scan["engine_input"], "jurisdiction": st, "items": items})
    params = {"scan_id": scan["scan_id"]} if with_scan else {}
    r = client.post("/api/claim", params=params, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def pdf_text(data: bytes, pages: slice = slice(None)) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages[pages])


def test_allowlist_is_disjoint_from_never_and_forbidden():
    assert not MI.allowlist & MI.never
    assert not {name for name in MI.allowlist if FORBIDDEN.search(name)}


def test_every_field_named_in_the_spec_exists_in_the_official_form():
    fields = set(PdfReader(MI_FORM).get_fields())
    assert len(fields) == 202
    assert MI.allowlist <= fields
    assert MI.never <= fields


def test_guard_refuses_anything_outside_the_allowlist():
    for name in (
        "3 Social Security Number",
        "31 Location of Crime",
        "36 Name of Offenders if known",
        "Claimant Signature",
        "Sexual Assault",
    ):
        with pytest.raises(FormGuardError):
            guard(MI, {name})


def test_packet_cites_every_line_and_appends_the_application(client):
    claim = make_claim(client)
    r = client.get(f"/api/packet/{claim['claim_id']}.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["cache-control"] == "no-store"
    reader = PdfReader(io.BytesIO(r.content))
    summary_pages = len(reader.pages) - 6
    assert summary_pages >= 2
    text = pdf_text(r.content, slice(0, summary_pages))
    for expected in (
        "Amount you can ask for",
        "The program decides",
        "Demo packet",
        "Hold this line. Ask billing to remove it first.",
        "MCL 18.355a(2)",
        "shall not submit a bill",
        "That needs your express written consent.",
        "nessie:p-0005",
        "Still needed",
        "Only you write this",
        "877-251-7373",
        "Sources",
    ):
        assert expected in text, expected
    for line in claim["lines"]:
        assert line["item_id"] in text.replace("\n", "")

    filled = filled_fields(r.content)
    assert set(filled) <= MI.allowlist
    assert filled["1 Name of Victim"] == "Rowan Example"
    for name in MI.never:
        assert name not in filled


def test_application_fills_only_safe_fields(client):
    claim = make_claim(client)
    r = client.get(f"/api/packet/{claim['claim_id']}/application.pdf")
    assert r.status_code == 200
    filled = filled_fields(r.content)
    assert set(filled) <= MI.allowlist
    assert {"Medical Expenses", "Psychological Counseling", "Transportation", "Residential Security"} <= set(filled)
    assert filled["Medical Expenses"] == "/On"
    summary = filled["SECTION 6  Compensation Benefits"]
    assert summary.startswith("Itemized list attached:") and "06/14/2026" in summary
    for name in (
        "3 Social Security Number",
        "27 Date of Crime",
        "31 Location of Crime",
        "33 Briefly describe the crime and injuries that resulted from this crime",
        "36 Name of Offenders if known",
        "Claimant Signature",
        "Date of Signature",
        "Sexual Assault",
    ):
        assert name not in filled


def test_held_exam_is_not_requested_on_the_form(client):
    claim = make_claim(client)
    view = client.get(f"/api/claims/{claim['claim_id']}").json()
    values = application_values(MI, view)
    held = sum(ln["amount_cents"] for ln in view["lines"] if ln["status"] == "held")
    assert held == 32500
    counted = sum(ln["allowed_cents"] for ln in view["lines"] if ln["status"] == "eligible")
    assert values["SECTION 6  Compensation Benefits"].endswith(f"${counted // 100:,}.{counted % 100:02d}")


def test_unscanned_claim_leaves_the_name_blank(client):
    claim = make_claim(client, with_scan=False)
    filled = filled_fields(client.get(f"/api/packet/{claim['claim_id']}/application.pdf").content)
    assert "1 Name of Victim" not in filled
    text = pdf_text(client.get(f"/api/packet/{claim['claim_id']}.pdf").content, slice(0, 2))
    assert "Demo packet" not in text


def test_state_without_a_form_gets_the_summary_only(client):
    claim = make_claim(client, st="WI")
    r = client.get(f"/api/packet/{claim['claim_id']}.pdf")
    assert r.status_code == 200
    assert filled_fields(r.content) == {}
    assert "Only you write this" not in pdf_text(r.content)
    assert client.get(f"/api/packet/{claim['claim_id']}/application.pdf").status_code == 404


def test_still_needed_documents_are_tied_to_reasons(client):
    claim = make_claim(client)
    needed = client.get(f"/api/packet/{claim['claim_id']}/needed").json()["needed"]
    documents = [n["document"] for n in needed]
    assert any(d.startswith("Itemized bills from each medical provider") for d in documents)
    assert any(d.startswith("Insurance statements") for d in documents)
    exam = next(n for n in needed if n["document"].startswith("Proof that you had a forensic exam"))
    assert "MI-REPORT-1" in exam["rule_ids"]
    assert documents[-1] == "Your signature on the application"


def test_packet_for_unknown_claim_is_404(client):
    assert client.get("/api/packet/clm_missing.pdf").status_code == 404


def test_expense_labels_read_as_words():
    from tend_api.packet import expense_label

    assert expense_label("clothing_bedding") == "Clothing and bedding"
    assert expense_label("lost_wages") == "Lost wages"
