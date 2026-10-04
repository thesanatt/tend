"""The bank activity panel: every Nessie record Tend read or wrote for a demo persona, reconciled.

Nessie never moves an account's balance field, so Tend computes balances from the records. This lays that
arithmetic out term by term (the opening balance, then deposits, purchases, withdrawals, and transfers out
and in) next to the computed balance. It puts each bill next to the payments that paid it and the line
still held, and it lists the API calls that produced the view, so a reader can check every number against
the bank.

Only fictional demo data is shown: records whose ids are in the committed snapshot (seed/snapshots), and
records Tend wrote in its own formats. Nessie lets other API keys write to an account they know the id of,
so anything else on the account is counted, never shown. Nothing is stored; every request reads again.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import re
from typing import Any

from .bank import DryRunBank
from .errors import TendError
from .nessie import BankSnapshot, Txn, computed_balance_cents
from .payments import BillFacts, bill_target, payee_key
from .payout import program_name

WITHDRAWAL_TEXT = re.compile(
    r"^Payment to (?P<payee>.{1,70}) \[tend:(?P<action>act_[0-9a-f]{20})\](?: \[bill:(?P<bill>[0-9A-Za-z-]+)(?:#(?P<lines>[0-9]+(?:,[0-9]+)*))?\])?$"
)
PAYOUT_TEXT = re.compile(r"^(?P<program>.{1,90}) demo payment \(fictional\) \[tend:payout-(?P<st>[A-Z]{2})\]$")
KINDS = ("purchase", "deposit", "withdrawal", "transfer")


class ActivityError(TendError):
    pass


def _iso_now() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_live(relay: Any, saved: BankSnapshot) -> tuple[BankSnapshot, str, str | None, list[dict[str, Any]]]:
    """(the persona's bank, "live" or "snapshot", why it fell back, the Nessie calls made)."""
    client = relay.live_client()
    if client is None:
        return saved, "snapshot", None, []
    try:
        live = client.snapshot(saved.customer.id, saved.meta)
        return live, "live", None, [dataclasses.asdict(c) for c in getattr(client, "calls", [])]
    except Exception as exc:  # Nessie down or odd: the committed copy, and say so
        calls = [dataclasses.asdict(c) for c in getattr(client, "calls", [])]
        return saved, "snapshot", type(exc).__name__, calls
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()


class Reader:
    """Decides what each live record is, and what may be shown of it."""

    def __init__(self, saved: BankSnapshot, rules: Any):
        self.saved = saved
        self.rules = rules
        self.known = {t.id: t for t in saved.txns}
        names = [m.name for m in saved.merchants] + [b.payee for b in saved.bills]
        self.fictional_names = {payee_key(n): n for n in names if n}

    def payout_program(self, st: str) -> str | None:
        law = self.rules.get(st) if self.rules is not None else None
        return program_name(law) if law else None

    def tend_record(self, t: Txn) -> dict[str, Any] | None:
        """A record Tend wrote, in Tend's own words, or None when it is not one."""
        if t.kind == "withdrawal":
            m = WITHDRAWAL_TEXT.match(t.description)
            if not m:
                return None
            payee = self.fictional_names.get(payee_key(m.group("payee")))
            lines = [int(n) for n in m.group("lines").split(",")] if m.group("lines") else []
            return {
                "what": "payment",
                "payee": payee,  # None: a name outside the demo data, which is not shown
                "action_id": m.group("action"),
                "bill_id": m.group("bill"),
                "bill_lines": lines,
            }
        if t.kind == "deposit":
            m = PAYOUT_TEXT.match(t.description)
            if not m or m.group("program") != self.payout_program(m.group("st")):
                return None
            return {"what": "demo_payout", "program": m.group("program"), "st": m.group("st")}
        return None

    def row(self, t: Txn, accounts: dict[str, str], merchants: dict[str, str]) -> dict[str, Any] | None:
        base = {
            "id": t.id,
            "kind": t.kind,
            "account": accounts.get(t.account_id),
            "date": t.date,
            "amount_cents": t.amount_cents,
            "status": t.status,
        }
        was = self.known.get(t.id)
        if was is not None:
            # The words come from the committed copy, which is fictional by construction; the numbers are live.
            return {
                **base,
                "description": was.display_description,
                "merchant": merchants.get(was.merchant_id or ""),
                "to": accounts.get(was.payee_account_id or "") if t.kind == "transfer" else None,
                "source": "seed",
                "changed": t != was,
            }
        tend = self.tend_record(t)
        if tend is None:
            return None
        return {**base, "description": None, "merchant": None, "to": None, "source": "tend", "changed": False, "tend": tend}


def ledger(account: Any, txns: list[Txn]) -> dict[str, Any]:
    """Opening balance plus each kind of record, the way computed_balance_cents adds them up."""
    terms = {k: {"count": 0, "cents": 0} for k in ("deposits", "purchases", "withdrawals", "transfers_out", "transfers_in")}
    skipped = 0
    for t in txns:
        touches = t.account_id == account.id or (t.kind == "transfer" and t.payee_account_id == account.id)
        if not touches:
            continue
        if t.status == "cancelled" or t.medium == "rewards" or (t.kind == "transfer" and t.account_id == t.payee_account_id):
            skipped += 1
            continue
        key = (
            {"deposit": "deposits", "purchase": "purchases", "withdrawal": "withdrawals", "transfer": "transfers_out"}[t.kind]
            if t.account_id == account.id
            else "transfers_in"
        )
        terms[key]["count"] += 1
        terms[key]["cents"] += t.amount_cents
    sign = {"deposits": 1, "purchases": -1, "withdrawals": -1, "transfers_out": -1, "transfers_in": 1}
    added = account.opening_balance_cents + sum(sign[k] * v["cents"] for k, v in terms.items())
    computed = computed_balance_cents(account, txns)
    return {
        "opening_cents": account.opening_balance_cents,
        "terms": [{"key": k, "sign": sign[k], **v} for k, v in terms.items()],
        "not_counted": skipped,
        "computed_cents": computed,
        "reconciled": added == computed,
    }


def bank_activity(svc: Any, persona_id: str) -> dict[str, Any]:
    saved = svc.relay.saved(persona_id)
    if saved.meta.get("fictional") is not True:
        raise ActivityError("The bank activity panel shows only fictional demo personas.", 403)
    live, source, source_error, calls = read_live(svc.relay, saved)
    reader = Reader(saved, svc.rules)
    saved_accounts = {a.id for a in saved.accounts}
    accounts = [a for a in live.accounts if a.id in saved_accounts] or saved.accounts
    names = {a.id: f"{a.nickname} {(a.account_number or '')[-4:]}".strip() for a in accounts}
    merchants = {m.id: m.name for m in saved.merchants}

    rows, hidden = [], 0
    for t in live.txns:
        row = reader.row(t, names, merchants)
        if row is None:
            hidden += 1
        else:
            rows.append(row)
    tend_rows = [r for r in rows if r["source"] == "tend"]
    shown = {r["id"] for r in rows}

    account_views = []
    for a in accounts:
        number = a.account_number or ""
        account_views.append(
            {
                "id": a.id,
                "type": a.type,
                "nickname": a.nickname,
                "mask": number[-4:] or None,
                # Nessie's own balance field: set when the account was created, and it never moves.
                "nessie_balance_cents": a.opening_balance_cents,
                "ledger": ledger(a, live.txns),
                "not_shown": sum(1 for t in live.txns if t.account_id == a.id and t.id not in shown),
            }
        )

    bills = [_bill_view(svc, reader, saved, live, b, tend_rows) for b in saved.bills]
    dry = svc.actions.banks.get("dry_run")
    dry_rows = dry.records(saved_accounts) if isinstance(dry, DryRunBank) else []
    return {
        "persona_id": persona_id,
        "fictional": True,
        "notice": saved.meta.get("notice"),
        "source": source,
        "source_error": source_error,
        "read_at": _iso_now(),
        "bank_mode": svc.settings.bank_mode,
        "customer": {"id": saved.customer.id},
        "accounts": account_views,
        "bills": bills,
        "tend_writes": tend_rows,
        "records": {kind: [r for r in rows if r["kind"] == kind] for kind in KINDS},
        "merchants": [{"id": m.id, "name": m.name, "category": m.category} for m in saved.merchants],
        "hidden_count": hidden,
        "dry_run_writes": [_dry_row(r) for r in dry_rows],
        "calls": calls,
    }


def _dry_row(record: dict[str, Any]) -> dict[str, Any]:
    # Only what Tend wrote in a dry run: amounts and ids, never the description (it names the payee).
    return {k: record.get(k) for k in ("id", "kind", "account_id", "date", "amount_cents", "status")}


def _bill_view(
    svc: Any, reader: Reader, saved: BankSnapshot, live: BankSnapshot, bill: Any, tend_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    now = next((b for b in live.bills if b.id == bill.id), None)
    document = next((d for d in saved.meta.get("documents") or [] if d.get("bill_id") == bill.id), None)
    total = document.get("total_cents") if document and isinstance(document.get("total_cents"), int) else bill.amount_cents
    payments = [
        {
            "withdrawal_id": r["id"],
            "date": r["date"],
            "amount_cents": r["amount_cents"],
            "action_id": r["tend"]["action_id"],
            "lines": r["tend"]["bill_lines"],
        }
        for r in tend_rows
        if r.get("tend", {}).get("bill_id") == bill.id and r["status"] != "cancelled"
    ]
    paid = sum(p["amount_cents"] for p in payments)
    facts = None
    try:
        review = svc.claims.bill_review(bill.id) if document else None
        facts = BillFacts.from_review(review) if review else None
    except Exception:  # the law engine is not needed to show the bank's own numbers
        facts = None
    allowed_nicknames = {bill.nickname}
    if facts is not None and paid:
        allowed_nicknames.add(bill_target(facts, paid)["nickname"])
    expected = total - paid
    return {
        "id": bill.id,
        "payee": bill.payee,
        "account_id": bill.account_id,
        "status": now.status if now else None,
        "amount_cents": now.amount_cents if now else None,
        "nickname": now.nickname if now and now.nickname in allowed_nicknames else None,
        "nickname_changed": bool(now and now.nickname not in allowed_nicknames),
        "due_date": now.payment_date if now else bill.payment_date,
        "itemized_total_cents": total,
        "payments": payments,
        "paid_cents": paid,
        "expected_cents": expected,
        "held": (
            {"cents": facts.held_cents, "rule_ids": facts.held_rule_ids, "note": facts.hold_note()}
            if facts is not None and facts.held
            else None
        ),
        "in_bank": now is not None,
        # What the bank's bill says against the itemized total less Tend's payments of it.
        "reconciled": now is not None
        and (now.amount_cents == expected and now.status == "pending" if expected > 0 else now.status == "completed"),
    }
