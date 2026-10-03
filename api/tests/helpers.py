from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tend_api.app import create_app
from tend_api.config import Settings
from tend_api.services import build_services

FIXTURES = Path(__file__).parent / "fixtures"
MI_RULES = FIXTURES / "rules" / "MI.json"


def _load_fake_reference() -> Any:
    spec = importlib.util.spec_from_file_location("fake_tend_ref", FIXTURES / "refengine" / "tend_ref" / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fake_ref = _load_fake_reference()


class FakeClock:
    def __init__(self, start: dt.datetime):
        self.now = start

    def __call__(self) -> dt.datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += dt.timedelta(**delta)


CLASSIFY_KEYWORDS = (
    ("counsel", "counseling"),
    ("ride", "transportation"),
    ("lock", "security"),
    ("phone", "property_replacement"),
    ("pharmacy", "prescription"),
    ("hospital", "medical"),
)


def fake_classifier(transactions: list[dict[str, Any]], st: str) -> list[dict[str, Any]]:
    items = []
    for t in transactions:
        if t.get("kind") == "deposit":
            continue
        name = (t.get("merchant") or {}).get("name") or t.get("payee") or ""
        text = f"{name} {t.get('description', '')}".lower()
        match = next(((key, expense) for key, expense in CLASSIFY_KEYWORDS if key in text), None)
        if match is None:
            continue
        items.append(
            {
                "item_id": f"nessie:{t.get('id') or t['_id']}",
                "date": t.get("date") or t.get("purchase_date") or t.get("transaction_date") or t.get("creation_date"),
                "amount_cents": t.get("amount_cents", t.get("payment_amount_cents")),
                "expense": match[1],
                "confirmed": False,
                "is_bill": t.get("kind") == "bill",
                "units": 1 if match[1] == "counseling" else 0,
                "description": name or text,
                "confidence": 0.9,
                "reason": f"merchant name mentions {match[0]}",
            }
        )
    return items


def make_services(settings: Settings, clock: FakeClock, **overrides: Any):
    kwargs: dict[str, Any] = {"clock": clock, "classifier": fake_classifier, "reference_evaluate": fake_ref.evaluate}
    kwargs.update(overrides)
    return build_services(settings, **kwargs)


def client_for(services) -> TestClient:
    return TestClient(create_app(services=services))


def law_image(rules_path: Path = MI_RULES) -> bytes:
    return b"TLAW" + hashlib.sha256(rules_path.read_bytes()).digest()


def scan_rowan(client: TestClient, **extra: Any) -> dict[str, Any]:
    r = client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI", **extra})
    assert r.status_code == 200, r.text
    return r.json()


def confirm_all(engine_input: dict[str, Any]) -> dict[str, Any]:
    return {**engine_input, "items": [{**item, "confirmed": True} for item in engine_input["items"]]}
