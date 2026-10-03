"""Opt-in cloud AI: nothing without consent, nothing stored, amounts never sent, every bill checked by code."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from types import SimpleNamespace

import pytest
from helpers import FIXTURES, client_for, make_services
from test_relay import database_bytes

from tend_api.ai import BILL_SCHEMA, gemini_bill_reader
from tend_api.classify import DEFAULT_CACHE_PATH, FALLBACK_MODEL, PRIMARY_MODEL

ROWS = [
    {"id": "csv:1", "date": "2026-06-17", "amount_cents": 15000, "description": "session", "merchant": "Clearwater Counseling Group"},
    {
        "id": "csv:2",
        "date": "2026-06-18",
        "amount_cents": 6400,
        "description": "door chain, motion sensor light",
        "merchant": "Northside Hardware",
    },
    {"id": "csv:3", "date": "2026-06-19", "amount_cents": 2300, "description": "mystery item", "merchant": "Odd Shop"},
    {"id": "csv:4", "date": "2026-06-20", "amount_cents": 5400, "description": "groceries", "merchant": "Larkfield Market"},
]
TEXT_BILL = (FIXTURES / "seed" / "bills" / "riverbend-2026-06.txt").read_bytes()


class FakeModel:
    def __init__(self, fail: bool = False):
        self.calls: list[list[dict]] = []
        self.fail = fail

    def __call__(self, rows):
        self.calls.append(rows)
        if self.fail:
            raise TimeoutError("model timed out")
        labels = {"door chain, motion sensor light": "security"}
        return {
            "results": [{"ref": r["ref"], "expense": labels.get(r["description"], "unknown"), "reason": "What it looks like"} for r in rows]
        }, "fake-model"


class FakeBillModel:
    def __init__(self, answer=None, fail: bool = False):
        self.calls: list[tuple[bytes, str]] = []
        self.answer = answer
        self.fail = fail

    def __call__(self, data, mime):
        self.calls.append((data, mime))
        if self.fail:
            raise RuntimeError("503 UNAVAILABLE")
        return self.answer, "fake-bill-model"


def ai_client(settings, clock, model=None, bill=None):
    services = make_services(settings, clock, classify_model=model, bill_model=bill)
    services.ai.cache_path = None  # these tests do not lean on the committed demo answers
    return client_for(services), services


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_nothing_happens_without_consent(settings, clock):
    model, bill = FakeModel(), FakeBillModel({"provider": "", "amount_due": "", "lines": []})
    client, _ = ai_client(settings, clock, model, bill)
    r = client.post("/api/ai/classify", json={"consent": False, "txns": ROWS})
    assert r.status_code == 403 and "Nothing was read or sent" in r.json()["detail"]
    r = client.post("/api/ai/bill", json={"consent": False, "file": b64(b"\x89PNG fake"), "mime": "image/png"})
    assert r.status_code == 403
    assert client.post("/api/ai/classify", json={"txns": ROWS}).status_code == 422  # consent is required, not assumed
    assert client.post("/api/ai/classify", json={"consent": "yes", "txns": ROWS}).status_code == 422
    assert model.calls == [] and bill.calls == []


def test_rules_first_then_the_model_without_amounts(settings, clock):
    model = FakeModel()
    client, _ = ai_client(settings, clock, model)
    data = client.post("/api/ai/classify", json={"consent": True, "st": "MI", "txns": ROWS}).json()
    labels = {row["id"]: row for row in data["labels"]}
    assert labels["csv:1"]["method"] == "registry" and labels["csv:1"]["unit"] == "session" and labels["csv:1"]["units"] == 1
    assert labels["csv:2"]["expense"] == "security" and labels["csv:2"]["source"] == "cloud_ai" and labels["csv:2"]["confirmed"] is False
    assert labels["csv:3"]["expense"] == "unknown" and labels["csv:4"]["candidate"] is False
    assert data["cloud_used"] is True and data["model"] == "fake-model" and data["model_ok"] is True
    # Only the two lines no rule could sort reached the model, by short refs, with no amount and no id.
    [rows] = model.calls
    assert len(rows) == 2 and all(set(r) == {"ref", "kind", "merchant", "category", "description"} for r in rows)
    assert not re.search(r"\$|\d{3,}|csv:", json.dumps(rows))
    items = {i["item_id"]: i for i in data["items"]}
    assert set(items) == {"csv:1", "csv:2"}  # the model called the mystery item ordinary spending
    assert items["csv:1"]["confirmed"] is True and items["csv:2"]["confirmed"] is False
    assert labels["csv:3"]["candidate"] is False and labels["csv:3"]["method"] == "model"
    assert all(set(i) >= {"unit", "tags", "source", "reason", "confidence", "units", "is_bill"} for i in items.values())


def test_rows_without_amounts_get_labels_only(settings, clock):
    client, _ = ai_client(settings, clock, FakeModel())
    rows = [{k: v for k, v in r.items() if k != "amount_cents"} for r in ROWS]
    data = client.post("/api/ai/classify", json={"consent": True, "txns": rows}).json()
    assert len(data["labels"]) == 4 and data["items"] == []


def test_a_model_outage_leaves_lines_for_the_survivor(settings, clock):
    client, _ = ai_client(settings, clock, FakeModel(fail=True))
    data = client.post("/api/ai/classify", json={"consent": True, "txns": ROWS}).json()
    assert data["model_ok"] is False and "left for you to sort" in data["note"]
    assert {row["id"]: row["method"] for row in data["labels"]}["csv:2"] == "unresolved"
    assert "timed out" not in json.dumps(data)


def test_without_a_key_only_the_rules_run(settings, clock):
    client, _ = ai_client(settings, clock)
    data = client.post("/api/ai/classify", json={"consent": True, "txns": ROWS}).json()
    assert data["cloud_used"] is False and data["model"] is None
    assert {row["id"]: row["method"] for row in data["labels"]}["csv:1"] == "registry"


def test_pay_that_dipped_becomes_lost_wages(settings, clock):
    client, _ = ai_client(settings, clock)
    pay = [412_00, 398_00, 419_00, 412_00, 236_00, 404_00]
    days = ["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-12", "2026-06-26", "2026-07-10"]
    rows = [
        {"id": f"csv:p{i}", "date": d, "amount_cents": -cents, "description": "Fernway Books payroll"}
        for i, (d, cents) in enumerate(zip(days, pay, strict=True))
    ]
    data = client.post("/api/ai/classify", json={"consent": True, "incident_date": "2026-06-14", "txns": rows}).json()
    [gap] = data["items"]
    assert (gap["item_id"], gap["expense"], gap["amount_cents"], gap["unit"], gap["units"]) == ("csv:p4", "lost_wages", 17_600, "week", 2)
    assert gap["confirmed"] is False and "$236" in gap["reason"] and "$412" in gap["reason"]


def test_a_text_bill_that_adds_up_never_reaches_the_model(settings, clock):
    bill = FakeBillModel({"provider": "", "amount_due": "", "lines": []})
    client, _ = ai_client(settings, clock, bill=bill)
    data = client.post("/api/ai/bill", json={"consent": True, "file": b64(TEXT_BILL), "mime": "text/plain"}).json()
    assert data["status"] == "ok" and data["sums_match"] is True and data["source"] == "rule"
    assert [ln["amount_cents"] for ln in data["lines"]] == [7500, 4300, 32500] and data["total_cents"] == 44300
    assert data["lines"][2]["expense"] == "forensic_exam" and data["lines"][2]["line_id"].startswith("bill:")
    assert bill.calls == []


def test_a_text_bill_that_does_not_add_up_is_unreliable(settings, clock):
    # Its own lines and totals disagree, so no model reading is asked for: the document is inconsistent.
    bill = FakeBillModel(PHOTO_ANSWER)
    client, _ = ai_client(settings, clock, bill=bill)
    bad = TEXT_BILL.replace(b"$443.00", b"$450.00", 1)
    data = client.post("/api/ai/bill", json={"consent": True, "file": b64(bad), "mime": "text/plain"}).json()
    assert data["status"] == "unreliable" and data["sums_match"] is False and data["lines"] and data["source"] == "rule"
    assert bill.calls == []


def test_a_pdf_without_a_text_layer_goes_to_the_model(settings, clock):
    bill = FakeBillModel(PHOTO_ANSWER)
    client, _ = ai_client(settings, clock, bill=bill)
    data = client.post("/api/ai/bill", json={"consent": True, "file": b64(b"%PDF-1.4 scanned"), "mime": "application/pdf"}).json()
    assert data["status"] == "ok" and data["source"] == "cloud_ai" and len(bill.calls) == 1


PHOTO_ANSWER = {
    "provider": "Riverbend General Hospital",
    "amount_due": "$443.00",
    "lines": [
        {"description": "Emergency department visit, copay", "amount": "$75.00", "expense": "medical"},
        {"description": "Medical forensic exam, deductible applied", "amount": "325.00", "expense": "medical"},
        {"description": "Laboratory services, coinsurance", "amount": "$43.00", "expense": "medical"},
    ],
}


def test_a_photo_is_read_by_the_model_and_checked_by_code(settings, clock):
    bill = FakeBillModel(PHOTO_ANSWER)
    client, _ = ai_client(settings, clock, bill=bill)
    data = client.post("/api/ai/bill", json={"consent": True, "file": b64(b"\xff\xd8 fake jpeg"), "mime": "image/jpeg"}).json()
    assert data["status"] == "ok" and data["sums_match"] is True and data["source"] == "cloud_ai" and data["model"] == "fake-bill-model"
    assert [ln["amount_cents"] for ln in data["lines"]] == [7500, 32500, 4300]
    # The exam line is decided by code, not by the model's guess.
    assert data["lines"][1]["expense"] == "forensic_exam"
    assert bill.calls == [(b"\xff\xd8 fake jpeg", "image/jpeg")]


@pytest.mark.parametrize(
    "change",
    [
        {"amount_due": "$450.00"},  # the lines do not add up to the total
        {"amount_due": ""},  # no readable total
        {"lines": [*PHOTO_ANSWER["lines"][:2], {"description": "Lab", "amount": "forty-three", "expense": "medical"}]},
    ],
)
def test_a_photo_that_does_not_add_up_is_unreliable(settings, clock, change):
    client, _ = ai_client(settings, clock, bill=FakeBillModel({**PHOTO_ANSWER, **change}))
    data = client.post("/api/ai/bill", json={"consent": True, "file": b64(b"img"), "mime": "image/png"}).json()
    assert data["status"] == "unreliable" and data["sums_match"] is False


def test_photo_errors(settings, clock):
    client, _ = ai_client(settings, clock)
    assert client.post("/api/ai/bill", json={"consent": True, "file": b64(b"img"), "mime": "image/png"}).status_code == 503
    client, _ = ai_client(settings, clock, bill=FakeBillModel(fail=True))
    r = client.post("/api/ai/bill", json={"consent": True, "file": b64(b"img"), "mime": "image/png"})
    assert r.status_code == 502 and "Nothing was kept" in r.json()["detail"]
    assert client.post("/api/ai/bill", json={"consent": True, "file": b64(b"img"), "mime": "image/gif"}).status_code == 422
    big = b64(b"\0" * (10 * 1024 * 1024 + 1))
    assert client.post("/api/ai/bill", json={"consent": True, "file": big, "mime": "image/png"}).status_code == 413


def test_cloud_ai_stores_nothing(settings, clock):
    client, services = ai_client(settings, clock, FakeModel(), FakeBillModel(PHOTO_ANSWER))
    cache_before = hashlib.sha256(DEFAULT_CACHE_PATH.read_bytes()).hexdigest()
    db_before = database_bytes(services.settings.database_url)
    client.post("/api/ai/classify", json={"consent": True, "txns": ROWS})
    client.post("/api/ai/bill", json={"consent": True, "file": b64(b"img"), "mime": "image/png"})
    assert database_bytes(services.settings.database_url) == db_before
    assert hashlib.sha256(DEFAULT_CACHE_PATH.read_bytes()).hexdigest() == cache_before


class FakeGenai:
    def __init__(self, primary_fails: bool):
        self.calls = []
        self.primary_fails = primary_fails
        self.models = SimpleNamespace(generate_content=self.generate_content)

    def generate_content(self, model, contents, config):
        self.calls.append((model, contents, config))
        if model == PRIMARY_MODEL and self.primary_fails:
            raise RuntimeError("503 UNAVAILABLE: high demand")
        return SimpleNamespace(text=json.dumps(PHOTO_ANSWER))


@pytest.mark.parametrize("primary_fails, answered_by", [(False, PRIMARY_MODEL), (True, FALLBACK_MODEL)])
def test_gemini_bill_reader_primary_then_fallback(primary_fails, answered_by):
    fake = FakeGenai(primary_fails)
    answer, model = gemini_bill_reader("unused", client=fake)(b"img", "image/png")
    assert model == answered_by and answer["amount_due"] == "$443.00"
    first_model, contents, config = fake.calls[0]
    assert first_model == PRIMARY_MODEL and config.response_json_schema == BILL_SCHEMA
    assert config.thinking_config.thinking_level.value == "LOW"
    assert contents[0].inline_data.data == b"img" and contents[0].inline_data.mime_type == "image/png"
    if primary_fails:
        assert fake.calls[1][0] == FALLBACK_MODEL and fake.calls[1][2].thinking_config is None
