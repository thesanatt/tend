from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import stat
import sys

import pytest
from helpers import FIXTURES, MI_RULES, client_for, fake_ref, law_image, make_services

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
    assert asm["inspect"] == {"magic": "TLAW", "bytes": 36}
    assert client.get("/api/jurisdictions/MI/asm", params={"format": "text"}).text.endswith("HALT\n")
    assert client.get("/api/health").json()["engines"]["native"]["available"] is True


def test_native_bad_input_is_422_not_a_silent_fallback(native_settings, clock):
    client = client_for(make_services(native_settings, clock))
    r = client.post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 422
    assert r.json()["detail"] == "bad_input: fake engine only evaluates empty claims"


def test_unreadable_law_image_falls_back_to_reference(native_settings, clock):
    # Fresh by its embedded hash, but the engine rejects it: the claim still gets an answer, from the reference.
    image = native_settings.law_dirs[0] / "MI.tlaw"
    image.write_bytes(b"XXXX" + image.read_bytes()[4:])
    client = client_for(make_services(native_settings, clock))
    r = client.post("/api/claim", json=EMPTY_CLAIM)
    assert r.status_code == 200
    assert r.headers["X-Tend-Engine"] == "reference"
    assert client.post("/api/claim", params={"engine": "native"}, json=EMPTY_CLAIM).status_code == 503
    assert "bad magic" in client.get("/api/jurisdictions/MI/asm").json()["detail"]


def test_reference_gets_the_rules_file_hash():
    seen = {}

    def evaluate(rules, engine_input, *, law_sha256=None):
        seen["law_sha256"] = law_sha256
        return {}

    call_reference(evaluate, {"rules": []}, {"items": []}, law_sha256="abc")
    assert seen == {"law_sha256": "abc"}


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


FAKE_TENDC = """#!/bin/sh
# Like tendc: [--quiet] INPUT [--verified FILE] -o OUT. Writes TLAW and the verified file's sha256.
echo "$@" > "$(dirname "$0")/tendc.args"
out=""; input=""; verified=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --verified) verified="$2"; shift 2 ;;
    --quiet) shift ;;
    *) input="$1"; shift ;;
  esac
done
printf TLAW > "$out"
shasum -a 256 "${verified:-$input}" | cut -c1-64 >> "$out"
"""


def fake_tendc(tmp_path):
    tendc = tmp_path / "bin" / "tendc"
    tendc.parent.mkdir()
    tendc.write_text(FAKE_TENDC)
    tendc.chmod(tendc.stat().st_mode | stat.S_IEXEC)
    return tendc


def write_ir(directory, source_sha256):
    directory.mkdir(parents=True, exist_ok=True)
    ir = {"ir_version": 1, "jurisdiction": "MI", "source_sha256": source_sha256, "rules": [{"id": "MI-EXAM-1", "kind": "exam_no_bill"}]}
    (directory / "MI.json").write_text(json.dumps(ir))
    return directory


def test_missing_image_is_compiled_with_tendc(native_settings, clock, tmp_path):
    (native_settings.law_dirs[0] / "MI.tlaw").unlink()
    settings = dataclasses.replace(native_settings, tendc=fake_tendc(tmp_path))
    client = client_for(make_services(settings, clock))
    r = client.post("/api/claim", json=EMPTY_CLAIM)
    assert r.status_code == 200, r.text
    assert r.headers["X-Tend-Engine"] == "native"
    assert (settings.cache_dir / "laws" / "MI.tlaw").read_bytes().startswith(b"TLAW")
    assert "--verified" not in (tmp_path / "bin" / "tendc.args").read_text()  # no IR: the verified file is the input


def test_image_is_compiled_from_the_law_ir(native_settings, clock, tmp_path):
    (native_settings.law_dirs[0] / "MI.tlaw").unlink()
    ir_dir = write_ir(tmp_path / "ir", hashlib.sha256(MI_RULES.read_bytes()).hexdigest())
    settings = dataclasses.replace(native_settings, tendc=fake_tendc(tmp_path), ir_dir=ir_dir)
    r = client_for(make_services(settings, clock)).post("/api/claim", json=EMPTY_CLAIM)
    assert r.status_code == 200 and r.headers["X-Tend-Engine"] == "native"
    args = (tmp_path / "bin" / "tendc.args").read_text().split()
    assert args[args.index("--verified") + 1] == str(MI_RULES) and str(ir_dir / "MI.json") in args


def test_stale_law_ir_is_never_compiled(native_settings, clock, tmp_path):
    (native_settings.law_dirs[0] / "MI.tlaw").unlink()
    settings = dataclasses.replace(native_settings, tendc=fake_tendc(tmp_path), ir_dir=write_ir(tmp_path / "ir", "0" * 64))
    client = client_for(make_services(settings, clock))
    forced = client.post("/api/claim", params={"engine": "native"}, json=EMPTY_CLAIM)
    assert forced.status_code == 503
    assert "rules/tools/normalize.py MI" in forced.json()["detail"]
    assert not (tmp_path / "bin" / "tendc.args").exists()
    # The v1.0-style fake reference reads the verified file, so the claim still gets an answer.
    assert client.post("/api/claim", json=EMPTY_CLAIM).headers["X-Tend-Engine"] == "reference"


def ir_reference(law, engine_input, *, law_sha256=None):
    if law.get("ir_version") != 1:
        raise ValueError("expected law IR")
    return {**fake_ref.evaluate({"rules": []}, engine_input), "law_image_sha256": "ir"}


def verified_reference(law, engine_input, *, law_sha256=None):
    if any("category" not in r for r in law["rules"]):
        raise ValueError("every rule needs a string id and category")
    return fake_ref.evaluate(law, engine_input)


def test_reference_that_reads_ir_gets_the_ir(settings, clock, tmp_path):
    ir_dir = write_ir(tmp_path / "ir", hashlib.sha256(MI_RULES.read_bytes()).hexdigest())
    services = make_services(dataclasses.replace(settings, ir_dir=ir_dir), clock, reference_evaluate=ir_reference)
    r = client_for(services).post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 200 and r.json()["law_image_sha256"] == "ir"
    assert services.engines.reference._reads == "ir"


def test_reference_that_reads_verified_rules_falls_back_once(settings, clock, tmp_path):
    ir_dir = write_ir(tmp_path / "ir", hashlib.sha256(MI_RULES.read_bytes()).hexdigest())
    services = make_services(dataclasses.replace(settings, ir_dir=ir_dir), clock, reference_evaluate=verified_reference)
    client = client_for(services)
    assert client.post("/api/claim", json=ONE_ITEM).status_code == 200
    assert services.engines.reference._reads == "verified"
    assert client.post("/api/claim", json=ONE_ITEM).status_code == 200


def test_ir_reading_reference_refuses_stale_ir(settings, clock, tmp_path):
    services = make_services(
        dataclasses.replace(settings, ir_dir=write_ir(tmp_path / "ir", "0" * 64)), clock, reference_evaluate=ir_reference
    )
    r = client_for(services).post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 503
    assert "normalize.py MI" in r.json()["detail"]


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
    monkeypatch.setattr(sys, "path", list(sys.path))
    # setitem records whatever was there (or nothing) so teardown restores it; the fake never outlives this test.
    monkeypatch.setitem(sys.modules, "tend_ref", None)
    del sys.modules["tend_ref"]
    try:
        fn = load_reference(FIXTURES / "refengine")
        assert callable(fn) and fn.__module__ == "tend_ref"
    finally:
        sys.modules.pop("tend_ref", None)


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


def test_image_from_an_older_ir_is_recompiled(native_settings, clock, tmp_path):
    ir_dir = write_ir(tmp_path / "ir", hashlib.sha256(MI_RULES.read_bytes()).hexdigest())
    current = hashlib.sha256((ir_dir / "MI.json").read_bytes()).hexdigest().encode()
    image = native_settings.law_dirs[0] / "MI.tlaw"
    settings = dataclasses.replace(native_settings, tendc=fake_tendc(tmp_path), ir_dir=ir_dir)

    image.write_bytes(law_image() + b"ir_sha256" + current)
    client = client_for(make_services(settings, clock))
    assert client.post("/api/claim", json=EMPTY_CLAIM).headers["X-Tend-Engine"] == "native"
    assert not (tmp_path / "bin" / "tendc.args").exists()  # same IR: the built image is used as is

    image.write_bytes(law_image() + b"ir_sha256" + b"f" * 64)  # same verified file, IR normalized again since
    client = client_for(make_services(settings, clock))
    assert client.post("/api/claim", json=EMPTY_CLAIM).headers["X-Tend-Engine"] == "native"
    assert (tmp_path / "bin" / "tendc.args").exists()
    assert (settings.cache_dir / "laws" / "MI.tlaw").is_file()


def output_with(change):
    def evaluate(law, payload):
        out = fake_ref.evaluate(law, payload)
        change(out)
        return out

    return evaluate


@pytest.mark.parametrize(
    "change",
    [
        lambda out: out["totals"].update(allowed_cents=out["totals"]["allowed_cents"] + 100),
        lambda out: out["totals"].update(held_cents=500),
        lambda out: out["lines"][0].update(allowed_cents=out["lines"][0]["requested_cents"] + 1),
        lambda out: out["lines"][0].update(requested_cents=1),
        lambda out: out["lines"][0].update(status="approved"),
        lambda out: out["lines"].pop(),
        lambda out: out["lines"].append(dict(out["lines"][0])),
        lambda out: out["checks"]["reporting"].update(status="fine"),
    ],
    ids=["total", "held", "allowed-over", "requested", "status", "missing-line", "duplicate-line", "check-status"],
)
def test_engine_output_that_does_not_add_up_is_refused(settings, clock, change):
    client = client_for(make_services(settings, clock, reference_evaluate=output_with(change)))
    r = client.post("/api/claim", json=ONE_ITEM)
    assert r.status_code == 500
    assert "Tend will not show it" in r.json()["detail"] or "one line per input item" in r.json()["detail"]
