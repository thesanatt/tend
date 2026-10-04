"""Record what the demo sends to live Nessie, and what Nessie answers, into seed/cassettes/.

usage (needs the API's packages, so it runs with the api environment):
  cd api && uv run python ../seed/record_cassettes.py

It resets rowan-mi to the demo start, then drives the real API (tend_api.app) against live Nessie and
records four cassettes:
  pay-bill.json   propose and confirm the $118.00 bill payment, confirm it again, try to pay it again
  payout.json     the program's demo deposit, the same request again, undo, and the deposit once more
  activity.json   the bank activity read-out with the payment and the deposit in place
  reset.json      reset_demo.reset undoing all of it
Then it checks the bank is back at the demo start, and that the API key appears in no cassette.
The action id and the clock are fixed, so a test can replay the exchanges byte for byte
(api/tests/test_nessie_recorded.py, seed/tests/test_cassettes.py).
"""
from __future__ import annotations

import datetime as dt
import json
import os
import secrets
import sys
import tempfile
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parent
REPO = SEED_DIR.parent
sys.path.insert(0, str(SEED_DIR))
sys.path.insert(0, str(REPO / "api"))

from fastapi.testclient import TestClient  # noqa: E402
from reset_demo import reset  # noqa: E402
from seeder import load_env  # noqa: E402

from tend_api.app import create_app  # noqa: E402
from tend_api.bank import DryRunBank, NessieBank  # noqa: E402
from tend_api.config import API_DIR, Settings  # noqa: E402
from tend_api.nessie import DEFAULT_BASE_URL, NessieClient, load_persona_snapshot  # noqa: E402
from tend_api.nessie_cassette import RecordingTransport, save  # noqa: E402
from tend_api.services import build_services  # noqa: E402

CASSETTES = SEED_DIR / "cassettes"
PERSONA = "rowan-mi"
ACTION_HEX = "c0ffee0123456789abcd"
NOW = dt.datetime(2026, 10, 4, 15, 30, tzinfo=dt.UTC)
PAYOUT_CENTS = 400800
NOTE = ("Real answers from Capital One's Nessie mock bank for the fictional persona rowan-mi, recorded by "
        "seed/record_cassettes.py. The API key is not recorded.")


def settings_for(tmp: Path) -> Settings:
    """The API as the recording and the replay both run it: the real corpus and seed, the Python reference engine."""
    return Settings(
        rules_dir=REPO / "rules" / "verified",
        seed_dir=SEED_DIR,
        engine_lib=tmp / "no-native-engine",
        law_dirs=(tmp / "no-laws",),
        tendc=tmp / "no-tendc",
        refengine_dir=REPO / "refengine",
        forms_dir=API_DIR / "forms",
        cache_dir=tmp / "cache",
        database_url=str(tmp / "tend.sqlite3"),
        bank_mode="nessie",
        relay_live=True,
        secret_hex="ab" * 32,
        ir_dir=REPO / "rules" / "ir",
        autoload_corpus=False,
    )


def main() -> int:
    load_env()
    key = os.environ.get("NESSIE_API_KEY", "")
    base = os.environ.get("NESSIE_BASE_URL") or DEFAULT_BASE_URL
    with NessieClient(key, base) as plain:
        start = reset(plain, PERSONA)
    if not start.ok:
        print("rowan-mi is not at the demo start; fix that first:", *start.after, sep="\n  ")
        return 1

    saved = load_persona_snapshot(PERSONA)
    checking = saved.meta["account_keys"]["checking"]
    bill_id = saved.bills[0].id
    recorder = RecordingTransport()

    def client() -> NessieClient:
        return NessieClient(key, base, transport=recorder)

    secrets.token_hex = lambda nbytes=None: ACTION_HEX  # the action id goes into a withdrawal's description
    context = {"persona": PERSONA, "now": NOW.isoformat(), "action_hex": ACTION_HEX, "checking": checking, "bill_id": bill_id}
    with tempfile.TemporaryDirectory() as tmp:
        services = build_services(
            settings_for(Path(tmp)),
            clock=lambda: NOW,
            banks={"dry_run": DryRunBank(), "nessie": NessieBank(client())},
            relay_client_factory=client,
        )
        with TestClient(create_app(services=services)) as api:
            pay = {"from": checking, "payee": saved.bills[0].payee, "amount_cents": 11800}
            proposal = api.post("/api/actions/propose", json=pay).json()
            assert proposal.get("bill_id") == bill_id, proposal
            done = api.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).json()
            assert done["status"] == "done" and done["bill"]["ok"], done
            again = api.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).json()
            assert again["replayed"], again
            refused = api.post("/api/actions/propose", json=pay)
            assert refused.status_code == 409, refused.text
            save(CASSETTES / "pay-bill.json", recorder.take(), note=NOTE, context={**context, "message": done["message"]})
            print("pay-bill:", done["message"])

            payout = api.post(f"/api/bank/{PERSONA}/payout", json={"st": "MI", "amount_cents": PAYOUT_CENTS}).json()
            assert payout["read_back_matches"], payout
            assert api.post(f"/api/bank/{PERSONA}/payout", json={"st": "MI", "amount_cents": PAYOUT_CENTS}).json()["replayed"]
            assert api.delete(f"/api/bank/{PERSONA}/payout").json()["deleted"] == [payout["deposit_id"]]
            payout = api.post(f"/api/bank/{PERSONA}/payout", json={"st": "MI", "amount_cents": PAYOUT_CENTS}).json()
            save(CASSETTES / "payout.json", recorder.take(), note=NOTE, context={**context, "message": payout["message"]})
            print("payout:", payout["message"])

            activity = api.get(f"/api/bank/{PERSONA}/activity").json()
            assert activity["source"] == "live" and activity["bills"][0]["reconciled"], activity["bills"]
            save(CASSETTES / "activity.json", recorder.take(), note=NOTE, context=context)
            print("activity:", len(activity["calls"]), "calls,", sum(len(v) for v in activity["records"].values()), "records shown")

    with client() as c:
        report = reset(c, PERSONA)
    save(CASSETTES / "reset.json", recorder.take(), note=NOTE, context={**context, "changes": report.changes})
    print("reset:", *report.changes, sep="\n  ")
    with NessieClient(key, base) as plain:
        check = reset(plain, PERSONA, check_only=True)
    print("rowan-mi back at the demo start:", check.ok)
    leaked = [p.name for p in CASSETTES.glob("*.json") if key and key in p.read_text()]
    if leaked:
        print("THE API KEY IS IN", leaked, file=sys.stderr)
        return 2
    sizes = {p.name: len(json.loads(p.read_text())["exchanges"]) for p in sorted(CASSETTES.glob("*.json"))}
    print("cassettes (exchanges):", sizes)
    return 0 if check.ok and report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
