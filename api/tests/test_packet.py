from __future__ import annotations

import io

import pytest
from helpers import confirm_all, scan_rowan
from pypdf import PdfReader

from tend_api.config import API_DIR
from tend_api.forms import FORBIDDEN, MI, FormGuardError, application_values, fill_application, filled_fields, guard
from tend_api.models import ClaimInput
from tend_api.packet import still_needed

MI_FORM = API_DIR / "forms" / "MI" / "application.pdf"


def make_claim(client, st="MI"):
    scan = scan_rowan(client)
    audit = client.post("/api/bill/audit", json={"st": st, "persona_id": "rowan-mi"}).json()
    items = [i for i in scan["engine_input"]["items"] if not i["is_bill"]] + audit["engine_items"]
    body = confirm_all({**scan["engine_input"], "jurisdiction": st, "items": items})
    r = client.post("/api/claim", json=body)
    assert r.status_code == 200, r.text
    return body, r.json()


def packet(client, body, persona="rowan-mi"):
    params = {"persona_id": persona} if persona else {}
    r = client.post("/api/packet", params=params, json=body)
    assert r.status_code == 200, r.text
    return r


def view_of(services, body, persona="rowan-mi"):
    output, engine, payload = services.claims.evaluate(ClaimInput.model_validate(body))
    return services.claims.view(payload, output, engine, persona)


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
    body, claim = make_claim(client)
    r = packet(client, body)
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["x-tend-engine"] == "reference"
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


def test_packet_is_rendered_and_not_kept(client, services):
    body, _ = make_claim(client)
    first = packet(client, body)
    assert packet(client, body).content == first.content  # same claim, same packet: nothing about it was stored
    assert services.repo.audit_rows() == []


def test_application_fills_only_safe_fields(client, services):
    body, _ = make_claim(client)
    filled = filled_fields(fill_application(services.settings.forms_dir, "MI", view_of(services, body)))
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


def test_held_exam_is_not_requested_on_the_form(client, services):
    body, _ = make_claim(client)
    view = view_of(services, body)
    values = application_values(MI, view)
    held = sum(ln["amount_cents"] for ln in view["lines"] if ln["status"] == "held")
    assert held == 32500
    counted = sum(ln["allowed_cents"] for ln in view["lines"] if ln["status"] == "eligible")
    assert values["SECTION 6  Compensation Benefits"].endswith(f"${counted // 100:,}.{counted % 100:02d}")


def test_packet_without_a_persona_leaves_the_name_blank(client):
    body, _ = make_claim(client)
    r = packet(client, body, persona=None)
    assert "1 Name of Victim" not in filled_fields(r.content)
    assert "Demo packet" not in pdf_text(r.content, slice(0, 2))


def test_state_without_a_form_gets_the_summary_only(client, services):
    body, _ = make_claim(client, st="WI")
    r = packet(client, body)
    assert filled_fields(r.content) == {}
    assert "Only you write this" not in pdf_text(r.content)
    assert fill_application(services.settings.forms_dir, "WI", view_of(services, body)) is None


def test_still_needed_documents_are_tied_to_reasons(client, services):
    body, _ = make_claim(client)
    needed = still_needed(view_of(services, body), services.rules.get("MI"))
    documents = [n["document"] for n in needed]
    assert any(d.startswith("Itemized bills from each medical provider") for d in documents)
    assert any(d.startswith("Insurance statements") for d in documents)
    exam = next(n for n in needed if n["document"].startswith("Proof that you had a forensic exam"))
    assert "MI-REPORT-1" in exam["rule_ids"]
    assert documents[-1] == "Your signature on the application"


def test_packet_for_an_unknown_state_is_404(client):
    body = {"jurisdiction": "ZZ", "context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"}, "items": []}
    assert client.post("/api/packet", json=body).status_code == 404


def test_expense_labels_read_as_words():
    from tend_api.packet import expense_label

    assert expense_label("clothing_bedding") == "Clothing and bedding"
    assert expense_label("lost_wages") == "Lost wages"
