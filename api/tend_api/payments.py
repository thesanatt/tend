"""Paying a bill in Nessie: tied to the bill, the held line left visible, and never paid twice.

Nessie has no route that pays a bill and no idempotency keys. So Tend pays a bill with two records it
writes and then reads back:

1. a withdrawal from the survivor's account, described as
   "Payment to <payee> [tend:<action id>] [bill:<bill id>#<lines>]", where the lines are the itemized
   bill's line numbers this payment covers, and
2. a PUT on the bill that leaves only what is still owed. When what is left is a line the law says the
   survivor should not be billed for (Michigan's forensic exam, MCL 18.355a(2)), the bill keeps that
   amount, stays pending, and its nickname names the rule. The held part stays visible in the bank and
   Tend never pays it.

The tags are the idempotency key. Before money moves, Tend lists the account's withdrawals for one that
already pays any of the same lines of the same bill, and refuses to pay them again.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from .bank import record_cents
from .money import format_cents
from .nessie import bill_tag, parse_bill_tag

NICKNAME_MAX = 120


@dataclass(frozen=True)
class BillLine:
    item_id: str
    line_no: int | None
    amount_cents: int
    status: str | None
    rule_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class BillFacts:
    """What Tend knows about one demo bill, recomputed by the law engine every time it is asked."""

    bill_id: str
    account_id: str | None
    payee: str
    nickname: str
    total_cents: int
    payable_cents: int
    lines: tuple[BillLine, ...]
    pinpoints: dict[str, str] = field(default_factory=dict)  # rule id -> pinpoint, for the held rules

    @classmethod
    def from_review(cls, review: dict[str, Any]) -> BillFacts:
        lines = tuple(
            BillLine(
                item_id=str(ln["item_id"]),
                line_no=ln.get("line_no"),
                amount_cents=int(ln["amount_cents"]),
                status=ln.get("status"),
                rule_ids=tuple(ln.get("rule_ids") or ()),
            )
            for ln in review.get("lines") or []
        )
        total = review.get("total_cents")
        if not isinstance(total, int):
            total = sum(ln.amount_cents for ln in lines)
        payable = review.get("payable_cents")
        if not isinstance(payable, int):
            payable = sum(ln.amount_cents for ln in lines if ln.status != "held")
        return cls(
            bill_id=str(review["bill_id"]),
            account_id=review.get("account_id"),
            payee=str(review.get("payee") or ""),
            nickname=str(review.get("nickname") or "").strip(),
            total_cents=total,
            payable_cents=payable,
            lines=lines,
            pinpoints=dict(review.get("pinpoints") or {}),
        )

    @property
    def held(self) -> tuple[BillLine, ...]:
        return tuple(ln for ln in self.lines if ln.status == "held")

    @property
    def held_cents(self) -> int:
        return sum(ln.amount_cents for ln in self.held)

    @property
    def held_rule_ids(self) -> list[str]:
        return list(dict.fromkeys(r for ln in self.held for r in ln.rule_ids))

    @property
    def payable_item_ids(self) -> list[str]:
        return [ln.item_id for ln in self.lines if ln.status != "held"]

    def line_numbers(self, item_ids: Iterable[str]) -> tuple[int, ...]:
        wanted = set(item_ids)
        return tuple(sorted(ln.line_no for ln in self.lines if ln.item_id in wanted and isinstance(ln.line_no, int)))

    def hold_note(self) -> str | None:
        """Plain words for the held part, naming the first rule behind it: "$325.00 held under MCL 18.355a(2) (MI-EXAM-1)"."""
        rules = self.held_rule_ids
        if not self.held or not rules:
            return None
        rule = rules[0]
        pinpoint = self.pinpoints.get(rule)
        where = f"{pinpoint} ({rule})" if pinpoint else rule
        return f"{format_cents(self.held_cents)} held under {where}"


def payee_key(text: str) -> str:
    return " ".join((text or "").casefold().split())


def withdrawal_description(payee: str, action_id: str, bill_id: str | None = None, lines: Iterable[int] = ()) -> str:
    # [tend:...] lets the read-back find this record and the classifier set it aside later; [bill:...]
    # ties it to the bill and its lines, so the same lines are never paid twice.
    base = f"Payment to {payee[:70]} [tend:{action_id}]"
    return f"{base} {bill_tag(bill_id, lines)}" if bill_id else base


def bill_payments(records: Iterable[dict[str, Any]], bill_id: str) -> list[dict[str, Any]]:
    """The records that pay this bill, read from their [bill:...] tags."""
    out = []
    for record in records:
        ref = parse_bill_tag(str(record.get("description") or ""))
        if ref and ref[0] == bill_id and record.get("status") != "cancelled":
            out.append({**record, "bill_lines": list(ref[1])})
    return out


def overlapping(
    records: Iterable[dict[str, Any]], bill_id: str, lines: Iterable[int], exclude_action: str | None = None
) -> list[dict[str, Any]]:
    """Earlier payments of any of these lines. A payment with no line numbers paid every payable line."""
    wanted = set(lines)
    hits = []
    for record in bill_payments(records, bill_id):
        if exclude_action and f"[tend:{exclude_action}]" in str(record.get("description") or ""):
            continue
        theirs = set(record["bill_lines"])
        if not theirs or not wanted or theirs & wanted:
            hits.append(record)
    return hits


def paid_cents(records: Iterable[dict[str, Any]], bill_id: str) -> int:
    return sum(record_cents(r) or 0 for r in bill_payments(records, bill_id))


def bill_target(facts: BillFacts, paid: int) -> dict[str, Any]:
    """What the bill in Nessie should say once `paid` of it has been paid by Tend."""
    remaining = facts.total_cents - paid
    base = facts.nickname or facts.payee or "Bill"
    if remaining <= 0:
        return {"amount_cents": max(paid, 1), "status": "completed", "nickname": base[:NICKNAME_MAX]}
    note = facts.hold_note()
    nickname = f"{base}: {note}. Do not pay." if note else base
    return {"amount_cents": remaining, "status": "pending", "nickname": nickname[:NICKNAME_MAX]}


def bill_matches(bill: dict[str, Any] | None, target: dict[str, Any]) -> dict[str, bool]:
    bill = bill or {}
    return {
        "amount": bill.get("amount_cents") == target["amount_cents"],
        "status": bill.get("status") == target["status"],
        "nickname": bill.get("nickname") == target["nickname"],
    }


def already_paid_message(record: dict[str, Any]) -> str:
    cents = record_cents(record)
    amount = format_cents(cents) if cents is not None else "a payment"
    when = record.get("date") or record.get("transaction_date") or "earlier"
    rid = record.get("id") or record.get("_id") or "?"
    return f"Tend already paid these lines of this bill: {amount} on {when} (bank record {rid}). Nothing moved this time."
