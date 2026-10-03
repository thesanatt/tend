"""Checks on the committed snapshots in seed/snapshots, which the demo uses when Nessie is down."""
import hashlib
from collections import Counter
from pathlib import Path

import pytest

from history import ACCOUNTS, MERCHANTS, RIVERBEND_BILL, build_history, fingerprint, running_balances
from personas import PERSONAS
from seeder import labels_for, verify_against_plan
from tend_api.nessie import list_persona_snapshots, load_persona_snapshot

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module", params=sorted(PERSONAS))
def snap(request):
    return load_persona_snapshot(request.param)


def test_every_persona_has_a_snapshot():
    assert list_persona_snapshots() == sorted(PERSONAS)


def test_snapshot_is_labeled_fictional(snap):
    persona = PERSONAS[snap.meta["persona_id"]]
    assert snap.meta["fictional"] is True
    assert "Fictional" in snap.meta["notice"] and "Nessie" in snap.meta["notice"]
    assert snap.meta["jurisdiction"] == persona.jurisdiction
    assert (snap.customer.first_name, snap.customer.last_name) == (persona.first_name, persona.last_name)
    assert snap.customer.address.state == persona.jurisdiction
    assert {m.name for m in snap.merchants} == {m.name for m in MERCHANTS}
    assert snap.meta["history_fingerprint"] == fingerprint()


def test_snapshot_matches_the_plan(snap):
    assert verify_against_plan(snap) == []
    assert len(labels_for(snap)) == len(build_history())


def test_ids_are_unique_and_point_inside_the_snapshot(snap):
    ids = [t.id for t in snap.txns] + [b.id for b in snap.bills] + [a.id for a in snap.accounts]
    assert len(ids) == len(set(ids))
    accounts = {a.id for a in snap.accounts}
    merchants = {m.id for m in snap.merchants}
    assert all(t.account_id in accounts for t in snap.txns)
    assert all(t.merchant_id in merchants for t in snap.txns if t.kind == "purchase")
    assert all(t.payee_account_id in accounts for t in snap.txns if t.kind == "transfer")


def test_computed_balances_match_the_plan(snap):
    planned = running_balances(build_history())
    for spec in ACCOUNTS:
        account = snap.account_by_type(spec.type)
        assert account.opening_balance_cents == spec.opening_cents
        assert snap.balance_cents(account.id) == planned[spec.key][-1][1]


def test_bill_and_its_document(snap):
    [bill] = snap.bills
    assert (bill.payee, bill.amount_cents, bill.status) == (RIVERBEND_BILL.payee, 443_00, "pending")
    assert bill.recurring_date and bill.upcoming_payment_date  # without these Nessie cannot list bills
    [doc] = snap.meta["documents"]
    assert doc["bill_id"] == bill.id and doc["total_cents"] == bill.amount_cents
    pdf = REPO / doc["path"]
    assert hashlib.sha256(pdf.read_bytes()).hexdigest() == doc["sha256"]


def test_personas_share_one_history_shape():
    def shape(snapshot):
        names = {m.id: m.name for m in snapshot.merchants}
        types = {a.id: a.type for a in snapshot.accounts}
        return Counter((types[t.account_id], t.kind, t.date, t.amount_cents, t.display_description,
                        names.get(t.merchant_id)) for t in snapshot.txns)

    shapes = [shape(load_persona_snapshot(pid)) for pid in sorted(PERSONAS)]
    assert all(s == shapes[0] for s in shapes[1:])
