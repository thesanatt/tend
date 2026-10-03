"""Read-only check that live Nessie still holds the seeded world. Run with TEND_LIVE=1."""
import os

import pytest

from personas import PERSONAS
from seeder import load_env, verify_against_plan
from tend_api.nessie import NessieClient, load_persona_snapshot

pytestmark = [pytest.mark.live,
              pytest.mark.skipif(os.environ.get("TEND_LIVE") != "1", reason="set TEND_LIVE=1 to talk to Nessie")]


@pytest.mark.parametrize("pid", sorted(PERSONAS))
def test_live_nessie_matches_the_committed_snapshot(pid):
    load_env()
    saved = load_persona_snapshot(pid)
    with NessieClient.from_env() as client:
        live = client.snapshot(saved.customer.id, saved.meta)
    assert verify_against_plan(live) == [], f"reset it with: uv run python seeder.py reset {pid}"
    assert {t.id for t in live.txns} == {t.id for t in saved.txns}

    def bills(snapshot):
        return [(b.id, b.status, b.amount_cents) for b in snapshot.bills]

    assert bills(live) == bills(saved)
    for account in saved.accounts:
        assert live.balance_cents(account.id) == saved.balance_cents(account.id)
