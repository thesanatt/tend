"""The live demo's bank goes back to its start on its own, once the last visitor is done with it.

On youreowed.tech a confirmed payment is a real write to Capital One's Nessie mock bank, and Tend never pays a bill's
lines twice, so after one visitor paid Rowan's $118.00, every later visitor was told the bill was already paid. During
judging a script on a laptop put the account back (scripts/auto_reset.py). Now the API does: when a payment proposal
finds earlier payments of a demo bill and all of them are older than QUIET, it first runs seed/reset_demo.py's reset,
the one rehearsals use, on that persona's account.

What it may undo is narrow. Only a fictional persona from the seed snapshots, only when the API writes to live Nessie
(TEND_BANK=nessie), and only records in Tend's own words (the withdrawal that paid, the program's demo deposit) last
touched more than QUIET ago: a payment's newest audit row, or for a record the audit log does not know, the end of its
date in Detroit. A newer payment anywhere on the account means a visitor may be mid-demo, and then nothing is undone.
The bill goes back in place, under its id. Every other record stays, the reset's Nessie client refuses every other
write, and an account that differs from its snapshot in other ways (a seeded record missing or changed, an extra
account or bill) is left alone for a person to run reset_demo.py.

One attempt at a time per persona, across every instance of the function (a lock in the database), and the attempt
reads the bank again once it holds the lock. Every write is idempotent as well, so an attempt cut short is finished by
the next one. Nothing is stored, and the audit log gets no row: it records confirmed payments, and this is not one.
"""

from __future__ import annotations

import datetime as dt
import importlib
import logging
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx

from .actions import CODE_TTL
from .clock import PROGRAM_TZ, Clock, parse_iso
from .config import REPO_ROOT
from .db import Repository
from .nessie import BankSnapshot, NessieClient, Txn, list_persona_snapshots, load_persona_snapshot
from .nessie_activity import PAYOUT_TEXT, WITHDRAWAL_TEXT

log = logging.getLogger("tend")

# A code lives ten minutes, and the visitor who paid reads the result, the packet, and Track after that.
QUIET = 2 * CODE_TTL
# The whole attempt, lock wait included. The web gives a proposal 15 s; reset_demo.py took 2.6 s on Oct 3.
TIMEOUT_S = 8.0
# reset_demo.py and the seeder. The snapshots they read may live elsewhere (TEND_SEED_DIR).
SEED_CODE = REPO_ROOT / "seed"


class ResetRefused(RuntimeError):
    """The seeder asked for a write the demo reset never makes."""


def seed_module(name: str, seed_code: Path = SEED_CODE) -> ModuleType:
    """A module from seed/. The seed scripts import each other by bare name (history, personas, seeder), the way they
    run from that folder, so it joins the end of the import path, where it cannot shadow anything installed."""
    if str(seed_code) not in sys.path:
        sys.path.append(str(seed_code))
        importlib.invalidate_caches()
    return importlib.import_module(name)


class Deadline(httpx.BaseTransport):
    """One time budget for every request of an attempt, so a slow Nessie cannot hold a visitor's proposal."""

    def __init__(self, inner: httpx.BaseTransport, until: float):
        self.inner = inner
        self.until = until

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        left = self.until - time.monotonic()
        if left <= 0:
            # Refused before it is sent, so the client knows the request never left and nothing was applied.
            raise httpx.ConnectTimeout("the demo reset ran out of time", request=request)
        timeout = request.extensions.get("timeout")
        if isinstance(timeout, dict):
            request.extensions["timeout"] = {k: left if v is None else min(v, left) for k, v in timeout.items()}
        return self.inner.handle_request(request)

    def close(self) -> None:
        self.inner.close()


def nessie_client(until: float) -> NessieClient:
    """The reset's own Nessie client: the deployment's key, every request inside the attempt's budget."""
    return NessieClient.from_env(transport=Deadline(httpx.HTTPTransport(), until))


class OnlyUndo:
    """The client the seeder gets. Reads pass through. The only writes are deleting the records being undone and putting
    the persona's own bills back; anything else the seeder could want (a create, a merchant or account change, a delete
    of any other record) raises before a request is sent."""

    READS = frozenset(
        {
            "base_url",
            "snapshot",
            "list_customers",
            "find_customer",
            "get_customer",
            "list_accounts",
            "get_account",
            "list_merchants",
            "get_merchant",
            "list_txns",
            "account_txns",
            "get_txn",
            "find_txns",
            "list_bills",
            "customer_bills",
            "get_bill",
        }
    )

    def __init__(self, client: Any, undo: Iterable[str], bills: Iterable[str]):
        self._client = client
        self._undo = frozenset(undo)
        self._bills = frozenset(bills)
        self.deleted: list[str] = []

    def __getattr__(self, name: str) -> Any:
        if name in self.READS:
            return getattr(self._client, name)
        if name.startswith("_"):
            raise AttributeError(name)
        raise ResetRefused(f"the demo reset does not call {name}")

    def delete_txn(self, kind: str, txn_id: str) -> None:
        if txn_id not in self._undo:
            raise ResetRefused("the demo reset deletes only Tend's own stale demo writes")
        self._client.delete_txn(kind, txn_id)
        self.deleted.append(txn_id)

    def update_bill(self, bill_id: str, **fields: Any) -> Any:
        if bill_id not in self._bills:
            raise ResetRefused("the demo reset puts back only the persona's own bills")
        return self._client.update_bill(bill_id, **fields)


def by_tend(t: Txn) -> bool:
    """A record in Tend's own words: the withdrawal that paid, or the program's demo deposit (tend_api.nessie_activity)."""
    if t.kind == "withdrawal":
        return WITHDRAWAL_TEXT.match(t.description) is not None
    return t.kind == "deposit" and PAYOUT_TEXT.match(t.description) is not None


def end_of_day(day: str) -> dt.datetime | None:
    """When a record's date ends in Detroit, where Tend dates what it writes (clock.local_today)."""
    try:
        date = dt.date.fromisoformat(day)
    except ValueError:
        return None
    return dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), tzinfo=PROGRAM_TZ)


@dataclass(frozen=True)
class Plan:
    """A persona's bank against its snapshot, sorted by what the reset may do with each part."""

    undo: tuple[Txn, ...] = ()  # Tend's demo writes last touched more than QUIET ago: deleted
    recent: tuple[Txn, ...] = ()  # Tend's newer writes: left in place
    others: tuple[Txn, ...] = ()  # records Tend did not write: left in place
    bill_moved: bool = False  # a bill is off its demo start, the way a payment leaves it
    problems: tuple[str, ...] = ()  # differences only a person should fix, with reset_demo.py

    @property
    def in_use(self) -> bool:
        """A newer payment: a visitor may be in the middle of the demo."""
        return any(t.kind == "withdrawal" for t in self.recent)

    @property
    def needed(self) -> bool:
        return bool(self.undo or self.bill_moved) and not self.in_use and not self.problems


def plan(saved: BankSnapshot, live: BankSnapshot, touched: Callable[[Txn], dt.datetime | None], now: dt.datetime) -> Plan:
    problems = []
    if {a.id: a.opening_balance_cents for a in live.accounts} != {a.id: a.opening_balance_cents for a in saved.accounts}:
        problems.append("its accounts differ from the snapshot")
    found = {t.id: t for t in live.txns}
    off = sum(1 for t in saved.txns if found.get(t.id) != t)
    if off:
        problems.append(f"{off} seeded records are missing or changed")
    if sorted(b.id for b in live.bills) != sorted(b.id for b in saved.bills):
        problems.append("its bills differ from the snapshot")
    seeded = {t.id for t in saved.txns}
    undo: list[Txn] = []
    recent: list[Txn] = []
    others: list[Txn] = []
    for t in live.txns:
        if t.id in seeded:
            continue
        if not by_tend(t):
            others.append(t)
            continue
        at = touched(t)
        (undo if at is not None and at + QUIET <= now else recent).append(t)
    was = {b.id: b for b in saved.bills}
    moved = any(
        (b.status, b.amount_cents, b.nickname, b.payment_date) != (w.status, w.amount_cents, w.nickname, w.payment_date)
        for b in live.bills
        if (w := was.get(b.id)) is not None
    )
    return Plan(tuple(undo), tuple(recent), tuple(others), moved, tuple(problems))


@dataclass(frozen=True)
class Attempt:
    """What one attempt did: reset, clean (nothing left to undo), in_use (a newer payment), busy (another attempt held
    the lock throughout), refused (the account needs a person), or failed (cut short; the next attempt goes on)."""

    outcome: str
    deleted: frozenset[str] = frozenset()

    @property
    def changed(self) -> bool:
        """The bank may differ from what the caller read before: it was reset, found reset, or partly undone."""
        return self.outcome in ("reset", "clean") or bool(self.deleted)


class DemoReset:
    def __init__(
        self,
        repo: Repository,
        seed_dir: Path,
        clock: Clock,
        live: bool,
        connect: Callable[[float], Any] = nessie_client,
        timeout_s: float = TIMEOUT_S,
    ):
        self.repo = repo
        self.snapshot_dir = seed_dir / "snapshots"
        self.clock = clock
        self.live = live  # TEND_BANK=nessie: a payment is a real write, so there is something to undo
        self.connect = connect
        self.timeout_s = timeout_s
        self._owners: dict[str, str] | None = None

    def persona_for(self, account_id: str) -> str | None:
        """The fictional demo persona that owns this account, from the committed snapshots."""
        if self._owners is None:
            owners: dict[str, str] = {}
            for persona_id in list_persona_snapshots(self.snapshot_dir):
                snapshot = load_persona_snapshot(persona_id, self.snapshot_dir)
                if snapshot.meta.get("fictional") is True:
                    owners.update((a.id, persona_id) for a in snapshot.accounts)
            self._owners = owners
        return self._owners.get(account_id)

    def touched(self, kind: str, description: str, day: str) -> dt.datetime | None:
        """When Tend last touched one of its writes: a payment's newest audit row, or for a record the audit log does not
        know (a demo deposit, a payment another copy of the API made), the end of its date."""
        m = WITHDRAWAL_TEXT.match(description) if kind == "withdrawal" else None
        if m:
            try:
                rows = self.repo.audit_rows(m.group("action"))
            except Exception:  # the database did not answer: the date is the safe bound
                rows = []
            if rows:
                return max(parse_iso(r["ts"]) for r in rows)
        return end_of_day(day)

    def after_paid(self, account_id: str, earlier: list[dict[str, Any]]) -> bool:
        """A proposal found earlier payments of a demo bill's lines on this account. When every one of them is older than
        QUIET, try to put the account back at the demo start. True when the caller should read the bank again."""
        persona_id = self.persona_for(account_id) if self.live else None
        if persona_id is None:
            return False
        now = self.clock()
        for r in earlier:
            at = self.touched("withdrawal", str(r.get("description") or ""), str(r.get("date") or ""))
            if at is None or at + QUIET > now:
                return False  # a visitor may still be in the middle of the demo, so Nessie is not even asked
        return self.run(persona_id).changed

    def run(self, persona_id: str) -> Attempt:
        """One attempt for one persona, under its lock and within the time budget."""
        until = time.monotonic() + self.timeout_s
        guard: OnlyUndo | None = None
        try:
            saved = load_persona_snapshot(persona_id, self.snapshot_dir)
            with self.repo.exclusive(f"demo_reset:{persona_id}", max(0.0, until - time.monotonic())) as held:
                if not held:
                    return Attempt("busy")
                with self.connect(until) as client:
                    # Read again under the lock: an attempt that waited finds the work done.
                    live = client.snapshot(saved.customer.id, saved.meta)
                    p = plan(saved, live, lambda t: self.touched(t.kind, t.description, t.date), self.clock())
                    if p.problems:
                        log.warning("demo reset left %s alone (%s); run seed/reset_demo.py", persona_id, "; ".join(p.problems))
                        return Attempt("refused")
                    if p.in_use or not p.needed:
                        return Attempt("in_use" if p.in_use else "clean")
                    undo = {t.id for t in p.undo}
                    guard = OnlyUndo(client, undo, (b.id for b in saved.bills))
                    seed_module("reset_demo").reset(guard, persona_id, snapshot_dir=self.snapshot_dir, keep=lambda t: t.id not in undo)
                    log.info("demo reset put %s back at the demo start (%d of Tend's writes undone)", persona_id, len(undo))
                    return Attempt("reset", frozenset(guard.deleted))
        except Exception as exc:  # Nessie, the database, or the time budget: the caller answers as it did before
            log.warning("demo reset for %s did not finish: %s", persona_id, type(exc).__name__)
            return Attempt("failed", frozenset(guard.deleted) if guard else frozenset())
