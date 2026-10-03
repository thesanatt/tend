from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from tend_api.models import ClaimInput, ConfirmRequest, Item, ProposeRequest, ScanRequest
from tend_api.money import assert_integer_cents, canonical_json, dollars_match_cents, format_cents, parse_cents


@pytest.mark.parametrize(
    "text,cents",
    [
        ("$1,171.75", 117175),
        ("325.00", 32500),
        ("(12.50)", -1250),
        ("-12.50", -1250),
        ("$443", 44300),
        ("0.07", 7),
    ],
)
def test_parse_cents(text, cents):
    assert parse_cents(text) == cents


@pytest.mark.parametrize("text", ["12.5", "abc", "(12.00", "1,23.00", "", "$12.345"])
def test_parse_cents_rejects_malformed(text):
    with pytest.raises(ValueError):
        parse_cents(text)


def test_format_cents():
    assert format_cents(117175) == "$1,171.75"
    assert format_cents(-5) == "-$0.05"
    with pytest.raises(TypeError):
        format_cents(1.5)


def test_integer_cents_guard_accepts_ints():
    assert_integer_cents({"totals": {"allowed_cents": 5, "by_expense": {"medical": 5}}, "lines": [{"delta_cents": -3}]})


@pytest.mark.parametrize(
    "bad",
    [
        {"allowed_cents": 1.0},
        {"totals": {"by_expense": {"medical": 2.5}}},
        {"lines": [{"requested_cents": True}]},
        {"trace": [{"delta_cents": "5"}]},
    ],
)
def test_integer_cents_guard_rejects_floats_bools_strings(bad):
    with pytest.raises(ValueError):
        assert_integer_cents(bad)


@pytest.mark.parametrize(
    "value,cents,ok",
    [
        (118, 11800, True),
        (118.0, 11800, True),
        ("1.15", 115, True),
        (443.0, 44300, True),
        (11800, 11800, False),  # cents written where dollars belong is exactly the bug a read-back must catch
        (117.99, 11800, False),
        (1.005, 100, False),
        (True, 100, False),
        (None, 100, False),
    ],
)
def test_dollars_match_cents_is_exact(value, cents, ok):
    assert dollars_match_cents(value, cents) is ok


def test_canonical_json_is_stable_and_rejects_nan():
    assert canonical_json({"b": 1, "a": [2, {"d": 3, "c": 4}]}) == b'{"a":[2,{"c":4,"d":3}],"b":1}'
    with pytest.raises(ValueError):
        canonical_json({"x": float("nan")})


def _item(**over):
    base = {"item_id": "nessie:p-1", "date": "2026-06-20", "amount_cents": 15000, "expense": "counseling"}
    return {**base, **over}


@pytest.mark.parametrize(
    "over",
    [
        {"amount_cents": 150.0},
        {"amount_cents": "15000"},
        {"amount_cents": True},
        {"amount_cents": -1},
        {"expense": "pain_and_suffering"},
        {"what_happened": "anything"},
        {"item_id": "../etc"},
        {"confirmed": "yes"},
    ],
)
def test_item_rejects(over):
    with pytest.raises(ValidationError):
        Item.model_validate_json(json.dumps(_item(**over)))


def test_claim_input_uppercases_state_and_rejects_duplicate_ids():
    ctx = {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"}
    claim = ClaimInput.model_validate({"jurisdiction": "mi", "context": ctx, "items": [_item()]})
    assert claim.jurisdiction == "MI"
    with pytest.raises(ValidationError):
        ClaimInput.model_validate({"jurisdiction": "MI", "context": ctx, "items": [_item(), _item()]})


def test_item_strips_control_characters():
    item = Item.model_validate(_item(description="Riverbend\x07 General\n"))
    assert item.description == "Riverbend General"


def test_scan_request_needs_exactly_one_source():
    with pytest.raises(ValidationError):
        ScanRequest.model_validate({"st": "MI"})
    with pytest.raises(ValidationError):
        ScanRequest.model_validate({"st": "MI", "persona_id": "rowan-mi", "customer_id": "abc"})


def test_propose_uses_from_alias_and_positive_integer_cents():
    req = ProposeRequest.model_validate({"from": "acct-1", "payee": "Riverbend", "amount_cents": 11800})
    assert req.from_account == "acct-1"
    for amount in (0, -100, 118.0):
        with pytest.raises(ValidationError):
            ProposeRequest.model_validate({"from": "acct-1", "payee": "Riverbend", "amount_cents": amount})
    with pytest.raises(ValidationError):
        ConfirmRequest.model_validate({"action_id": "act_1", "confirm_code": "12345"})
    with pytest.raises(ValidationError):  # bill lines without the bill they belong to
        ProposeRequest.model_validate({"from": "acct-1", "payee": "R", "amount_cents": 100, "item_ids": ["bill:x:1"]})


def test_item_takes_v12_units_and_tags():
    item = Item.model_validate(_item(unit="session", units=1, tags=["phone"]))
    assert (item.unit, item.units, item.tags) == ("session", 1, ["phone"])
    for over in ({"unit": "fortnight"}, {"tags": ["Phone!"]}, {"units": -1}):
        with pytest.raises(ValidationError):
            Item.model_validate(_item(**over))


def test_classified_item_display_fields_are_dropped_not_refused():
    # A ClassifiedItem (web/lib/contracts.ts) can be sent as-is; the engine never sees its display fields.
    item = Item.model_validate(_item(unit="session", source="rule", reason="Known counseling practice", confidence=0.95))
    assert "reason" not in item.model_dump() and item.unit == "session"
    with pytest.raises(ValidationError):
        Item.model_validate(_item(story="what happened"))
