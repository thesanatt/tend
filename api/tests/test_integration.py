"""The API with the real seed, classifier, corpus, reference engine, and native engine.

They stay offline: the classifier answers from its committed cache, the relay reads the committed
snapshots, and no key is set. The native test skips until the engine build can compile this IR.
"""

from __future__ import annotations

import importlib.util
import sys

import pytest
from fastapi.testclient import TestClient

from tend_api.app import create_app
from tend_api.config import API_DIR, Settings
from tend_api.engine import EngineUnavailable
from tend_api.forms import MI, filled_fields

REPO = API_DIR.parent
SEED = REPO / "seed"
ENGINE = REPO / "engine" / "build"
LIB = ENGINE / ("libtend.dylib" if sys.platform == "darwin" else "libtend.so")

has_seed = (SEED / "snapshots" / "rowan-mi.json").is_file() and importlib.util.find_spec("tend_api.classify") is not None
has_reference = (REPO / "refengine" / "tend_ref").is_dir()

pytestmark = pytest.mark.skipif(not (has_seed and has_reference), reason="seed/ and refengine/ are not in this checkout")


@pytest.fixture
def real(tmp_path):
    settings = Settings(
        rules_dir=REPO / "rules" / "verified",
        seed_dir=SEED,
        engine_lib=LIB,
        law_dirs=(ENGINE / "laws",),
        tendc=ENGINE / "tendc",
        refengine_dir=REPO / "refengine",
        forms_dir=API_DIR / "forms",
        cache_dir=tmp_path / "cache",
        database_url=str(tmp_path / "tend.sqlite3"),
        ir_dir=REPO / "rules" / "ir",
    )
    return TestClient(create_app(settings=settings))


def rowan_claim(client: TestClient, persona: str = "rowan-mi", st: str = "MI") -> tuple[dict, dict, dict]:
    scan = client.post("/api/scan", json={"persona_id": persona, "st": st}).json()
    bill_id = next(i["bill_id"] for i in scan["items"] if i.get("bill_id"))
    audit = client.post("/api/bill/audit", json={"bill_id": bill_id, "persona_id": persona, "st": st}).json()
    body = {**scan["engine_input"], "items": [{**i, "confirmed": True} for i in scan["engine_input"]["items"]]}
    return scan, audit, body


def test_rowan_end_to_end(real):
    scan, audit, body = rowan_claim(real)
    assert scan["fictional"] is True and scan["counts"]["items"] > 40 and scan["bill_errors"] == []
    by_expense = scan["counts"]["by_expense"]
    assert by_expense["counseling"] == 16 and by_expense["lost_wages"] == 3 and by_expense["transportation"] == 14
    assert {ln["item_id"] for ln in audit["lines"]} <= {i["item_id"] for i in scan["items"]}
    assert [c["ok"] for c in audit["checks"]] == [True] * len(audit["checks"])
    assert {c["name"] for c in audit["checks"]} >= {"lines_equal_total", "matches_snapshot_document", "matches_nessie_bill"}
    assert audit["held_cents"] == 32500 and audit["payable_cents"] == 11800
    r = real.post("/api/claim", params={"engine": "reference"}, json=body)
    assert r.status_code == 200, r.text
    assert r.json()["totals"]["held_cents"] == 32500
    packet = real.post("/api/packet", params={"persona_id": "rowan-mi"}, json=body)
    assert packet.status_code == 200
    assert set(filled_fields(packet.content)) <= MI.allowlist


def test_relay_and_scan_agree_on_rowan(real):
    bank = real.get("/api/bank/rowan-mi/transactions").json()
    assert bank["count"] == 190 and bank["source"] == "snapshot"
    # The checking statement's rows, summed with money out positive, take $2,850 down to the computed $803.
    assert 285_000 - sum(t["amount_cents"] for t in bank["txns"]) == 80_300
    sorted_rows = real.post("/api/ai/classify", json={"consent": True, "incident_date": "2026-06-14", "txns": bank["txns"]}).json()
    scan = real.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"}).json()
    from_scan = {
        i["item_id"]: (i["expense"], i["amount_cents"], i["unit"], i["units"]) for i in scan["items"] if i.get("kind") != "bill_line"
    }
    from_relay = {i["item_id"]: (i["expense"], i["amount_cents"], i["unit"], i["units"]) for i in sorted_rows["items"]}
    assert from_relay == from_scan


def test_every_jurisdiction_answers_a_check(real):
    for st in real.get("/api/health").json()["jurisdictions"]:
        r = real.post("/api/agent/check", json={"st": st, "incident_date": "2026-06-14", "forensic_exam": True})
        assert r.status_code == 200, (st, r.text)
        assert r.json()["law_ir"] is True, st


def native_can_serve(client: TestClient) -> str | None:
    native = client.app.state.services.engines.native
    try:
        native.law_image("MI")
        return None
    except EngineUnavailable as exc:
        return str(exc)


@pytest.mark.parametrize("persona,st", [("rowan-mi", "MI"), ("rowan-ny", "NY"), ("rowan-ca", "CA"), ("rowan-tx", "TX")])
def test_native_and_reference_agree(real, persona, st):
    reason = native_can_serve(real)
    if reason:
        pytest.skip(f"the native engine in engine/build cannot serve this IR yet: {reason[:160]}")
    _, _, body = rowan_claim(real, persona, st)
    native = real.post("/api/claim", params={"engine": "native"}, json=body)
    assert native.status_code == 200, f"native engine could not evaluate {st}: {native.text}"
    reference = real.post("/api/claim", params={"engine": "reference"}, json=body).json()
    differ = [key for key in ("lines", "totals", "checks", "info_rule_ids") if native.json()[key] != reference[key]]
    if differ and real.app.state.services.engines.reference._reads == "verified":
        pytest.xfail(f"tend_ref still reads rules/verified while tendc compiles rules/ir; differ in {differ}")
    assert differ == []
