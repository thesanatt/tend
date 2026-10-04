"""Put Rowan's bank back at the demo start. One command, before every rehearsal.

usage (from seed/):
  uv run python reset_demo.py              reset rowan-mi, then check it against the committed snapshot
  uv run python reset_demo.py --check      read only: list what a reset would undo; exit 1 if anything
  uv run python reset_demo.py --persona all

A demo run writes to Capital One's Nessie mock bank: the $118.00 bill payment (a withdrawal tagged
[tend:<action id>] [bill:<id>#1,3]), the bill's update (only the held $325.00 left on it, its nickname
naming the rule), and the program's demo deposit ([tend:payout-MI]). The reset deletes anything that is
not in the plan, restores the bill in place (it keeps its id), and recreates anything missing. Then it
reads the bank again and compares it with seed/snapshots/<persona>.json: the same record ids, the same
amounts, the bill at $443.00 pending, checking at $803.00 computed. It writes no file in the repository.

Exit status 0 means the bank matches the snapshot. 1 means it does not, with what differs; when record
ids changed (something was recreated), the snapshot and web/components/flow/samples need regenerating,
and the message says how.
"""
from __future__ import annotations

import argparse
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SEED_DIR.parent / "api"))  # run as a script, the api package is not on the path

from bill_pdf import money  # noqa: E402
from personas import PERSONAS, get_persona  # noqa: E402
from seeder import Seeder, load_env  # noqa: E402
from tend_api.nessie import BankSnapshot, NessieClient, Txn, load_persona_snapshot  # noqa: E402


def describe(t: Txn) -> str:
    tag = f" [tend:{t.tend_action}]" if t.tend_action else ""
    bill = f" paying bill {t.bill_ref[0][:8]}" if t.bill_ref else ""
    return f"{t.kind} {t.id[:8]} {t.date} {money(t.amount_cents)} {t.display_description!r}{tag}{bill}"


def drift(saved: BankSnapshot, live: BankSnapshot) -> list[str]:
    """What differs between the committed snapshot and the bank, in words. Empty means the demo start."""
    out = []
    saved_txns = {t.id: t for t in saved.txns}
    live_txns = {t.id: t for t in live.txns}
    for t in live.txns:
        if t.id not in saved_txns:
            out.append(f"extra {describe(t)}")
        elif t != saved_txns[t.id]:
            out.append(f"changed {describe(t)} (was {money(saved_txns[t.id].amount_cents)} {saved_txns[t.id].status})")
    out += [f"missing {describe(t)}" for t in saved.txns if t.id not in live_txns]
    saved_bills = {b.id: b for b in saved.bills}
    live_bills = {b.id: b for b in live.bills}
    for b in live.bills:
        was = saved_bills.get(b.id)
        if was is None:
            out.append(f"extra bill {b.id[:8]} {money(b.amount_cents)} to {b.payee!r}")
        elif (b.status, b.amount_cents, b.nickname, b.payment_date) != (was.status, was.amount_cents, was.nickname, was.payment_date):
            out.append(f"bill {b.id[:8]} is {b.status} {money(b.amount_cents)} {b.nickname!r} "
                       f"(demo start: {was.status} {money(was.amount_cents)} {was.nickname!r})")
    out += [f"missing bill {b.id[:8]} {money(b.amount_cents)}" for b in saved.bills if b.id not in live_bills]
    saved_accounts = {a.id: a.opening_balance_cents for a in saved.accounts}
    live_accounts = {a.id: a.opening_balance_cents for a in live.accounts}
    if saved_accounts != live_accounts:
        out.append(f"accounts differ: demo start {sorted(saved_accounts)} vs bank {sorted(live_accounts)}")
    return out


def balances(snapshot: BankSnapshot) -> dict[str, int]:
    return {a.nickname: snapshot.balance_cents(a.id) for a in snapshot.accounts}


@dataclass
class Report:
    persona: str
    before: list[str]
    after: list[str]
    changes: list[str] = field(default_factory=list)
    seconds: float = 0.0
    balances: dict[str, int] = field(default_factory=dict)
    bill: str = ""
    records: int = 0

    @property
    def ok(self) -> bool:
        return not self.after

    @property
    def ids_changed(self) -> bool:
        return any("(new id)" in c for c in self.changes)


def reset(client: NessieClient, persona_id: str, *, check_only: bool = False,
          snapshot_dir: Path | None = None, log: Callable[[str], None] = lambda _: None) -> Report:
    started = time.monotonic()
    saved = load_persona_snapshot(persona_id, snapshot_dir)
    before = drift(saved, client.snapshot(saved.customer.id, saved.meta))
    if check_only:
        return Report(persona_id, before, before, seconds=time.monotonic() - started)
    seeder = Seeder(client, get_persona(persona_id), log=log, known_bill_ids=frozenset(b.id for b in saved.bills))
    seeder.run()
    live = client.snapshot(saved.customer.id, saved.meta)
    bill = live.bills[0] if live.bills else None
    return Report(
        persona_id, before, drift(saved, live), seeder.changes, time.monotonic() - started,
        balances(live), f"{bill.status} {money(bill.amount_cents)}" if bill else "missing", len(live.txns),
    )


def print_report(report: Report, check_only: bool) -> None:
    name = report.persona
    if check_only:
        if report.ok:
            print(f"{name}: at the demo start ({report.seconds:.1f} s). Nothing to undo.")
        else:
            print(f"{name}: a reset would undo {len(report.before)} thing(s):")
            for line in report.before:
                print(f"  {line}")
        return
    if report.changes:
        print(f"{name}: undid {len(report.changes)} change(s):")
        for line in report.changes:
            print(f"  {line}")
    else:
        print(f"{name}: nothing to undo.")
    if report.ok:
        shown = ", ".join(f"{k} {money(v)}" for k, v in report.balances.items())
        print(f"{name}: at the demo start in {report.seconds:.1f} s. {report.records} records, bill {report.bill}, "
              f"computed balances: {shown}.")
        return
    print(f"{name}: NOT at the demo start. The bank still differs from seed/snapshots/{name}.json:")
    for line in report.after:
        print(f"  {line}")
    if report.ids_changed:
        print("  Records were recreated with new ids. Refresh the snapshot and the web sample:\n"
              f"    uv run python seeder.py snapshot {name}\n"
              "    then regenerate web/components/flow/samples/rowan.ts from the new snapshot")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--persona", default="rowan-mi", help="persona id, or all (default rowan-mi)")
    parser.add_argument("--check", action="store_true", help="read only: list what a reset would undo")
    args = parser.parse_args(argv)
    persona_ids = list(PERSONAS) if args.persona == "all" else [get_persona(args.persona).id]
    env = load_env()
    if env is None:
        print("No .env found above seed/; NESSIE_API_KEY must be set in the shell.", file=sys.stderr)
    ok = True
    with NessieClient.from_env() as client:
        for pid in persona_ids:
            report = reset(client, pid, check_only=args.check)
            print_report(report, args.check)
            ok = ok and report.ok
    if not args.check:
        print("In the browser, also clear the flow: Exit this page, or Delete saved progress on the resume screen.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
