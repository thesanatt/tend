from __future__ import annotations

import dataclasses
import hashlib
import os
import stat
import sys

import pytest
from helpers import FIXTURES, MI_RULES, client_for, fake_ref, make_services

from tend_api.engine import EngineUnavailable, call_reference, load_reference

EMPTY_CLAIM = {"jurisdiction": "MI", "context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"}, "items": []}
ONE_ITEM = {
    **EMPTY_CLAIM,
    "items": [
        {"item_id": "nessie:p-0005", "date": "2026-06-20", "amount_cents": 15000, "expense": "counseling", "confirmed": True, "units": 1},
    ],
}


def test_jurisdiction_list(client):
    data = client.get("/api/jurisdictions").json()["jurisdictions"]
    assert [j["jurisdiction"] for j in data] == ["MI", "WI"]
    mi = data[0]
    assert mi["rule_count"] > 30 and mi["source_count"] > 5
    assert mi["phone"] == "877-251-7373"
    assert "exam_no_bill" in mi["categories"]


def test_jurisdiction_detail_has_fragment_links_and_file_hash(client):
    doc = client.get("/api/jurisdictions/mi").json()
    exam = next(r for r in doc["rules"] if r["id"] == "MI-EXAM-1")
    assert exam["fragment_url"].startswith("https://legislature.mi.gov/") and "#:~:text=" in exam["fragment_url"]
    assert doc["rules_sha256"] == hashlib.sha256(MI_RULES.read_bytes()).hexdigest()


def test_unknown_and_malformed_jurisdictions(client):
    assert client.get("/api/jurisdictions/ZZ").status_code == 404
    assert client.get("/api/jurisdictions/MIX").status_code == 422


def test_asm_is_503_without_native_engine(client):
    r = client.get("/api/jurisdictions/MI/asm")
    assert r.status_code == 503
    assert "not built" in r.json()["detail"]


def test_claim_falls_back_to_reference_and_says_so(client):
    r = client.post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 200, r.text
    assert r.headers["X-Tend-Engine"] == "reference"
    assert r.headers["X-Tend-Claim-Id"] == r.json()["claim_id"]


def test_forcing_native_without_it_is_503(client):
    r = client.post("/api/claim", params={"engine": "native"}, json=ONE_ITEM)
    assert r.status_code == 503


def test_no_engine_at_all_is_503(settings, clock, monkeypatch):
    monkeypatch.setitem(sys.modules, "tend_ref", None)
    client = client_for(make_services(settings, clock, reference_evaluate=None))
    r = client.post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 503
    assert "No law engine is available" in r.json()["detail"]


def test_native_engine_through_ctypes(native_settings, clock):
    client = client_for(make_services(native_settings, clock))
    r = client.post("/api/claim", json=EMPTY_CLAIM)
    assert r.status_code == 200, r.text
    assert r.headers["X-Tend-Engine"] == "native"
    # The stand-in reports how many image bytes reached it, proving the law image went through ctypes intact.
    assert r.json()["trace"][0]["delta_cents"] == 4 + 32

    asm = client.get("/api/jurisdictions/MI/asm").json()
    assert asm["engine_version"] == "fake-1.0"
    assert asm["listing"].startswith("; fake listing for 36 bytes")
    assert client.get("/api/jurisdictions/MI/asm", params={"format": "text"}).text.endswith("HALT\n")
    assert client.get("/api/health").json()["engines"]["native"]["available"] is True


def test_native_engine_error_is_422_not_a_silent_fallback(native_settings, clock):
    client = client_for(make_services(native_settings, clock))
    r = client.post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 422
    assert "only evaluates empty claims" in r.json()["detail"]


def test_stale_law_image_falls_back_to_reference(native_settings, clock):
    image = native_settings.law_dirs[0] / "MI.tlaw"
    image.write_bytes(b"TLAW-no-digest")
    old = MI_RULES.stat().st_mtime - 3600
    os.utime(image, (old, old))
    client = client_for(make_services(native_settings, clock))
    r = client.post("/api/claim", json=EMPTY_CLAIM)
    assert r.status_code == 200
    assert r.headers["X-Tend-Engine"] == "reference"
    assert client.post("/api/claim", params={"engine": "native"}, json=EMPTY_CLAIM).status_code == 503


def test_missing_image_is_compiled_with_tendc(native_settings, clock, tmp_path):
    (native_settings.law_dirs[0] / "MI.tlaw").unlink()
    tendc = tmp_path / "tendc"
    tendc.write_text('#!/bin/sh\n# usage: tendc RULES.json -o OUT\nprintf TLAW > "$3"\nshasum -a 256 "$1" | cut -c1-64 >> "$3"\n')
    tendc.chmod(tendc.stat().st_mode | stat.S_IEXEC)
    settings = dataclasses.replace(native_settings, tendc=tendc)
    client = client_for(make_services(settings, clock))
    r = client.post("/api/claim", json=EMPTY_CLAIM)
    assert r.status_code == 200, r.text
    assert r.headers["X-Tend-Engine"] == "native"
    assert (settings.cache_dir / "laws" / "MI.tlaw").read_bytes().startswith(b"TLAW")


def test_engine_output_with_float_cents_is_rejected(settings, clock):
    def bad(law, payload):
        out = fake_ref.evaluate(law, payload)
        out["totals"]["allowed_cents"] = 150.0
        return out

    client = client_for(make_services(settings, clock, reference_evaluate=bad))
    r = client.post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 500
    assert "integer-cents" in r.json()["detail"]


def test_engine_output_cannot_invent_lines(settings, clock):
    def inventive(law, payload):
        out = fake_ref.evaluate(law, payload)
        out["lines"].append({**out["lines"][0], "item_id": "nessie:made-up"})
        return out

    client = client_for(make_services(settings, clock, reference_evaluate=inventive))
    assert client.post("/api/claim", json=ONE_ITEM).status_code == 500


def test_load_reference_from_refengine_dir(monkeypatch):
    monkeypatch.delitem(sys.modules, "tend_ref", raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    fn = load_reference(FIXTURES / "refengine")
    assert callable(fn) and fn.__module__ == "tend_ref"
    monkeypatch.delitem(sys.modules, "tend_ref", raising=False)


def test_load_reference_missing(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "tend_ref", None)
    with pytest.raises(EngineUnavailable):
        load_reference(tmp_path)


def test_call_reference_conventions():
    law, payload = {"law": True}, {"input": True}

    def law_first(rules, engine_input):
        return ("law_first", rules, engine_input)

    def input_first(payload_, law_doc):
        return ("input_first", payload_, law_doc)

    def input_only(engine_input, rules_dir=None):
        return ("input_only", engine_input)

    assert call_reference(law_first, law, payload) == ("law_first", law, payload)
    assert call_reference(input_first, law, payload) == ("input_first", payload, law)
    assert call_reference(input_only, law, payload) == ("input_only", payload)
