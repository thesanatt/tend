"""The API with the real seed, classifier, reference engine, and native engine.

These run once those parts sit in the same checkout (after merge) and skip until then.
They stay offline: the classifier answers from its cache and no Gemini key is set.
"""

from __future__ import annotations

import importlib.util
import sys

import pytest
from fastapi.testclient import TestClient

from tend_api.app import create_app
from tend_api.config import API_DIR, Settings
from tend_api.forms import MI, filled_fields

REPO = API_DIR.parent
SEED = REPO / "seed"
ENGINE = REPO / "engine" / "build"
LIB = ENGINE / ("libtend.dylib" if sys.platform == "darwin" else "libtend.so")

has_seed = (SEED / "snapshots" / "rowan-mi.json").is_file() and importlib.util.find_spec("tend_api.classify") is not None
has_reference = (REPO / "refengine" / "tend_ref").is_dir()
has_native = LIB.is_file() and (ENGINE / "tendc").is_file()

pytestmark = pytest.mark.skipif(
    not (has_seed and has_reference), reason="seed/, refengine/, and tend_api.classify are not in this checkout"
)


@pytest.fixture
def real(tmp_path, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    settings = Settings(
        rules_dir=REPO / "rules" / "verified",
        seed_dir=SEED,
        engine_lib=LIB,
        law_dirs=(ENGINE / "laws",),
        tendc=ENGINE / "tendc",
        refengine_dir=REPO / "refengine",
        forms_dir=API_DIR / "forms",
        cache_dir=tmp_path / "cache",
        db_path=str(tmp_path / "tend.sqlite3"),
    )
    return TestClient(create_app(settings=settings))


def rowan_claim(client: TestClient, persona: str = "rowan-mi", st: str = "MI") -> tuple[dict, dict, dict]:
    scan = client.post("/api/scan", json={"persona_id": persona, "st": st}).json()
    audit = client.post("/api/bill/audit", json={"st": st, "persona_id": persona, "scan_id": scan["scan_id"]}).json()
    items = [i for i in scan["engine_input"]["items"] if i["item_id"] != audit["replaces_item_id"]] + audit["engine_items"]
    context = {**scan["engine_input"]["context"], "forensic_exam": audit["engine_context"]["forensic_exam"]}
    body = {"jurisdiction": st, "context": context, "items": [{**i, "confirmed": True} for i in items]}
    return scan, audit, body


def test_rowan_end_to_end(real):
    scan, audit, body = rowan_claim(real)
    assert scan["fictional"] is True and scan["counts"]["items"] > 0
    assert [c["ok"] for c in audit["checks"]] == [True] * len(audit["checks"])
    assert {c["name"] for c in audit["checks"]} >= {"lines_equal_total", "matches_snapshot_document", "matches_nessie_bill"}
    assert audit["held_cents"] == 32500 and audit["payable_cents"] == 11800
    r = real.post("/api/claim", params={"scan_id": scan["scan_id"], "engine": "reference"}, json=body)
    assert r.status_code == 200, r.text
    claim = r.json()
    assert claim["refused"] == [] and claim["totals"]["held_cents"] == 32500
    packet = real.get(f"/api/packet/{claim['claim_id']}.pdf")
    assert packet.status_code == 200
    assert set(filled_fields(packet.content)) <= MI.allowlist


@pytest.mark.skipif(not has_native, reason="engine/build is not built in this checkout")
@pytest.mark.parametrize("persona,st", [("rowan-mi", "MI"), ("rowan-ny", "NY"), ("rowan-ca", "CA"), ("rowan-tx", "TX")])
def test_native_and_reference_agree(real, persona, st):
    scan, _, body = rowan_claim(real, persona, st)
    native = real.post("/api/claim", params={"scan_id": scan["scan_id"], "engine": "native"}, json=body)
    assert native.status_code == 200, f"native engine could not evaluate {st}: {native.text}"
    reference = real.post("/api/claim", params={"scan_id": scan["scan_id"], "engine": "reference"}, json=body).json()
    for key in ("lines", "totals", "checks", "info_rule_ids"):
        assert native.json()[key] == reference[key], key
