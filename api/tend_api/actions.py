"""Payments that move only after the survivor's explicit yes.

propose returns a six-digit code that works once, for ten minutes. confirm checks it, writes the
withdrawal to the bank tagged with the action id, reads the bank's record back, and appends the
outcome to the hash-chained audit log. The code is never stored, only a MAC that binds it to the
action id, amount, account, and payee (through the payee's keyed hash, which the action keeps after
the name is cleared). The audit log holds amounts, ids, and keyed hashes, never a name; the pending
action loses its payee as soon as it finishes or expires.

A payment of a demo bill is tied to the bank's own bill record (tend_api.payments): the withdrawal
names the bill and the lines it pays, the bill is updated to what is still owed, and a held line stays
on the bill, named by its rule, unpaid. A plain payment of exactly what a demo bill has left to pay,
to that bill's payee, is the same payment, so it is tied to the bill the same way.

Idempotent. A confirm sent again for a finished payment returns the first result and moves nothing.
One whose answer never came back is looked up in the bank by its label before anything else happens.
And the lines of a bill are never paid twice, even from two different proposals.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import hmac
import secrets
import threading
from collections.abc import Callable, Iterator
from typing import Any

from .bank import Bank, BankError, check_readback
from .clock import Clock, iso, local_today, parse_iso
from .db import Repository
from .errors import TendError
from .models import ConfirmRequest, ProposeRequest
from .money import canonical_json, format_cents
from .payments import (
    BillFacts,
    already_paid_message,
    bill_matches,
    bill_target,
    overlapping,
    paid_cents,
    payee_key,
    withdrawal_description,
)
from .sweep import SweepSchedule

CODE_TTL = dt.timedelta(minutes=10)
MAX_ATTEMPTS = 5
# A payment still "executing" this long after its yes lost its process; a confirm sent again looks it up.
STUCK_AFTER = dt.timedelta(seconds=60)
HELD_MESSAGE = "This line is held under the exam billing law. Ask billing to remove it first; Tend will not pay it."

# bill_id -> what Tend knows about that bill: persona, accounts, and each line with the engine's status.
BillReview = Callable[[str], dict[str, Any] | None]
# account id -> the demo bills on it that Tend can itemize: [{"bill_id", "payee"}].
BillIndex = Callable[[str], list[dict[str, Any]]]

__all__ = ["ActionError", "ActionService", "code_mac", "withdrawal_description"]


class ActionError(TendError):
    pass


def code_mac(secret: bytes, action_id: str, amount_cents: int, from_account: str, payee_tag: str, code: str) -> str:
    # The code verifies only against these exact values, so editing a stored action breaks confirmation.
    message = canonical_json(
        {"action_id": action_id, "amount_cents": amount_cents, "from": from_account, "payee_tag": payee_tag, "code": code}
    )
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


class ActionService:
    def __init__(
        self,
        repo: Repository,
        banks: dict[str, Bank],
        default_mode: str,
        secret: bytes,
        clock: Clock,
        bill_review: BillReview | None = None,
        live_accounts: Callable[[], set[str]] | None = None,
        sweeps: SweepSchedule | None = None,
        bill_index: BillIndex | None = None,
    ):
        self.repo = repo
        self.banks = banks
        self.default_mode = default_mode
        self.secret = secret
        self.clock = clock
        self.bill_review = bill_review or (lambda bill_id: None)
        self.live_accounts = live_accounts or set
        self.sweeps = sweeps or SweepSchedule()
        self.bill_index = bill_index or (lambda account_id: [])
        self._bill_locks: dict[str, threading.Lock] = {}
        self._bill_locks_guard = threading.Lock()

    def _tag(self, kind: str, value: str) -> str:
        """A keyed hash: ties log rows to one account or payee without the log holding the name."""
        return hmac.new(self.secret, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()[:32]

    def _bank(self, dry_run: bool) -> Bank:
        return self.banks["dry_run" if dry_run else "nessie"]

    # propose

    def propose(self, req: ProposeRequest, channel: str = "app") -> dict[str, Any]:
        now = self.clock()
        self.repo.sweep(iso(now))
        facts, item_ids = self._check_bill(req) if req.bill_id else (None, [])
        # A request can ask for a dry run on a live server, never a live write on a dry-run server.
        dry_run = bool(req.dry_run) or self.default_mode == "dry_run"
        bank = self._bank(dry_run)
        if bank.whole_dollars and req.amount_cents % 100:
            raise ActionError("Nessie stores whole dollars, so a live payment has to be a whole-dollar amount.", 422)
        # The API has no sign-in, so live writes are limited to the demo personas' own accounts.
        if not dry_run and req.from_account not in self.live_accounts():
            raise ActionError("Live payments can only come from a demo persona's account.", 403)
        if facts is None:
            facts, item_ids = self._match_bill(req)
        if facts is not None:
            self._refuse_if_paid(bank, req.from_account, facts, item_ids)
        action_id = f"act_{secrets.token_hex(10)}"
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_at = iso(now + CODE_TTL)
        payee_tag = self._tag("payee", req.payee)
        self.repo.insert_action(
            {
                "action_id": action_id,
                "status": "proposed",
                "amount_cents": req.amount_cents,
                "from_account": req.from_account,
                "payee": req.payee,
                "payee_tag": payee_tag,
                "code_mac": code_mac(self.secret, action_id, req.amount_cents, req.from_account, payee_tag, code),
                "channel": channel,
                "dry_run": dry_run,
                "bill_id": facts.bill_id if facts else None,
                "item_ids": item_ids,
                "created_at": iso(now),
                "expires_at": expires_at,
            }
        )
        self.sweeps.add(now + CODE_TTL)  # the payee goes once the code can no longer be used
        return {
            "action_id": action_id,
            "status": "proposed",
            "kind": "pay_bill" if facts else "payment",
            "amount_cents": req.amount_cents,
            "from": req.from_account,
            "payee": req.payee,
            "bill_id": facts.bill_id if facts else None,
            "item_ids": item_ids,
            "bill": self._bill_plan(facts, item_ids) if facts else None,
            "confirm_code": code,
            "expires_at": expires_at,
            "dry_run": dry_run,
        }

    def _bill_plan(self, facts: BillFacts, item_ids: list[str]) -> dict[str, Any]:
        """What paying these lines does to the bill, before anything moves."""
        return {
            "bill_id": facts.bill_id,
            "lines": list(facts.line_numbers(item_ids)),
            "total_cents": facts.total_cents,
            "held_cents": facts.held_cents,
            "held_rule_ids": facts.held_rule_ids,
            "held_note": facts.hold_note(),
        }

    def _check_bill(self, req: ProposeRequest) -> tuple[BillFacts, list[str]]:
        """Paying a bill Tend has read: the law engine runs on every line again, held lines are never paid,
        and the amount must be exactly the lines being paid. Nothing about the bill is stored."""
        review = self.bill_review(req.bill_id or "")
        if review is None:
            raise ActionError("Tend has no itemized record of this bill. Leave out bill_id to pay it as a plain payment.", 404)
        facts = BillFacts.from_review(review)
        lines = {ln["item_id"]: ln for ln in review["lines"]}
        held = [i for i, ln in lines.items() if ln.get("status") == "held"]
        item_ids = list(dict.fromkeys(req.item_ids)) if req.item_ids else [i for i in lines if i not in held]
        unknown = [i for i in item_ids if i not in lines]
        if unknown:
            raise ActionError(f"These are not lines of this bill: {', '.join(unknown[:3])}.", 404)
        if any(i in held for i in item_ids):
            raise ActionError(HELD_MESSAGE, 409)
        total = sum(lines[i]["amount_cents"] for i in item_ids)
        if set(item_ids) == {i for i in lines if i not in held} and review.get("payable_cents") is not None:
            # Every line that is not held: the amount the bill audit showed as payable, which takes off any
            # credit the bill itself prints (a payment already made). Paying the audit's number must work.
            total = review["payable_cents"]
        if total != req.amount_cents:
            raise ActionError(f"The amount does not match the lines being paid ({format_cents(total)}).", 409)
        accounts = review.get("accounts") or set()
        if accounts and req.from_account not in accounts:
            raise ActionError("Payments can only come from your own accounts.", 403)
        return facts, item_ids

    def _match_bill(self, req: ProposeRequest) -> tuple[BillFacts | None, list[str]]:
        """A plain payment to a demo bill's payee, from the account the bill is on, of exactly what is left to pay on
        it: the bill payment it is, tied to the bill. Exactly the whole bill, held line and all, is refused."""
        for bill in self.bill_index(req.from_account):
            if payee_key(bill.get("payee", "")) != payee_key(req.payee):
                continue
            review = self.bill_review(str(bill["bill_id"]))
            if review is None:
                continue
            facts = BillFacts.from_review(review)
            if req.amount_cents == facts.payable_cents and facts.payable_item_ids:
                return facts, facts.payable_item_ids
            if facts.held and req.amount_cents == facts.total_cents:
                raise ActionError(
                    f"This bill includes {facts.hold_note() or 'a held line'}. The law says you should not be billed for it, "
                    f"so Tend will not pay it. The rest of the bill is {format_cents(facts.payable_cents)}.",
                    409,
                )
        return None, []

    def _refuse_if_paid(self, bank: Bank, account_id: str, facts: BillFacts, item_ids: list[str]) -> None:
        try:
            records = bank.tagged_withdrawals(account_id, f"[bill:{facts.bill_id}")
        except BankError:
            return  # confirm checks again before any money moves, and refuses if it still cannot
        prior = overlapping(records, facts.bill_id, facts.line_numbers(item_ids))
        if prior:
            raise ActionError(already_paid_message(prior[0]), 409)

    # confirm

    def _code_ok(self, action: dict[str, Any], code: str, check_payee: bool) -> bool:
        expected = code_mac(self.secret, action["action_id"], action["amount_cents"], action["from_account"], action["payee_tag"], code)
        ok = hmac.compare_digest(expected, action["code_mac"])
        if ok and check_payee:
            # The name a withdrawal will carry must still be the one the code was made for.
            ok = hmac.compare_digest(self._tag("payee", action.get("payee") or ""), action["payee_tag"])
        return ok

    def confirm(self, req: ConfirmRequest, channel: str = "app") -> dict[str, Any]:
        action = self.repo.get_action(req.action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        if action["channel"] != channel:
            # An agent-proposed payment needs the survivor's typed approval, which only the agent route checks.
            raise ActionError(f"This payment was set up through the {action['channel']}; approve it there.", 409)
        now = self.clock()
        if action["status"] in ("done", "unverified", "executing"):
            return self._again(action, req, now)
        if action["status"] == "expired":
            raise ActionError("This confirm code expired. Propose the payment again to get a new code.", 410)
        if action["status"] == "locked":
            raise ActionError("Too many wrong codes. This action is locked; propose it again.", 423)
        if action["status"] != "proposed":
            raise ActionError(f"This action is already {action['status']}. Each confirm code works once.", 409)
        if parse_iso(action["expires_at"]) <= now:
            self.repo.transition_action(action["action_id"], "proposed", "expired", {"finished_at": iso(now)})
            raise ActionError("This confirm code expired. Propose the payment again to get a new code.", 410)

        if not self._code_ok(action, req.confirm_code, check_payee=True):
            attempts = self.repo.count_failed_attempt(action["action_id"], MAX_ATTEMPTS)
            if attempts >= MAX_ATTEMPTS:
                raise ActionError("Too many wrong codes. This action is locked; propose it again.", 423)
            raise ActionError("That code does not match this action.", 403)

        mismatched = [
            name
            for name, sent, stored in (
                ("amount_cents", req.amount_cents, action["amount_cents"]),
                ("from", req.from_account, action["from_account"]),
                ("payee", req.payee, action["payee"]),
            )
            if sent is not None and sent != stored
        ]
        if mismatched:
            raise ActionError(f"The confirmation does not match the proposed action ({', '.join(mismatched)}).", 409)

        if not self.repo.transition_action(
            action["action_id"], "proposed", "executing", {"confirmed_at": iso(now)}, not_expired_at=iso(now)
        ):
            raise ActionError("This action was already confirmed or has expired.", 409)
        self.repo.append_audit(
            "confirmed",
            action["action_id"],
            {
                "amount_cents": action["amount_cents"],
                "from_tag": self._tag("from", action["from_account"]),
                "payee_tag": action["payee_tag"],
                "channel": action["channel"],
                "dry_run": action["dry_run"],
            },
            iso(now),
        )
        return self._execute(action)

    def _again(self, action: dict[str, Any], req: ConfirmRequest, now: dt.datetime) -> dict[str, Any]:
        """A confirm for a payment that already got its yes: the same answer again, or a look in the bank. Never a second payment."""
        status = action["status"]
        if not self._code_ok(action, req.confirm_code, check_payee=False):
            raise ActionError(f"This action is already {status}. Each confirm code works once.", 409)
        if status == "done":
            return self._replay(action)
        if status == "executing":
            confirmed = parse_iso(action["confirmed_at"]) if action.get("confirmed_at") else None
            if confirmed is None or now - confirmed < STUCK_AFTER:
                raise ActionError("This payment is being sent now. Check again in a moment.", 409)
        return self._reconcile(action)

    @contextlib.contextmanager
    def _bill_lock(self, bill_id: str | None) -> Iterator[None]:
        # Two proposals for the same bill, confirmed at once in this process, check and pay one at a time.
        if not bill_id:
            yield
            return
        with self._bill_locks_guard:
            lock = self._bill_locks.setdefault(bill_id, threading.Lock())
        with lock:
            yield

    def _facts(self, action: dict[str, Any]) -> BillFacts | None:
        bill_id = action.get("bill_id")
        if not bill_id:
            return None
        review = self.bill_review(bill_id)
        return BillFacts.from_review(review) if review else None

    def _execute(self, action: dict[str, Any]) -> dict[str, Any]:
        bank = self._bank(action["dry_run"])
        action_id = action["action_id"]
        try:
            facts = self._facts(action)
        except Exception as exc:  # the engine could not re-read the bill: nothing has moved yet
            raise self._record_failure(action, BankError(f"Tend could not read the bill again ({type(exc).__name__})")) from exc
        lines = facts.line_numbers(action.get("item_ids") or []) if facts else ()
        with self._bill_lock(facts.bill_id if facts else None):
            if facts is not None:
                self._guard_bill(bank, action, facts, lines)
            try:
                withdrawal_id = bank.withdraw(
                    action["from_account"],
                    action["amount_cents"],
                    withdrawal_description(action["payee"], action_id, facts.bill_id if facts else None, lines),
                    local_today(self.clock()),
                )
            except BankError as exc:
                # A write can land even when no answer came back; the action id in the description finds it.
                found = bank.find_withdrawal(action["from_account"], action_id) if exc.maybe_applied else None
                if found is None:
                    raise self._record_failure(action, exc) from exc
                withdrawal_id = found
        return self._finish(action, bank, withdrawal_id, facts, "executing")

    def _guard_bill(self, bank: Bank, action: dict[str, Any], facts: BillFacts, lines: tuple[int, ...]) -> None:
        try:
            records = bank.tagged_withdrawals(action["from_account"], f"[bill:{facts.bill_id}")
        except BankError as exc:
            raise self._record_failure(
                action, BankError(f"Tend could not check the bank for an earlier payment of this bill: {exc}")
            ) from exc
        prior = overlapping(records, facts.bill_id, lines, exclude_action=action["action_id"])
        if prior:
            raise self._record_failure(action, BankError(already_paid_message(prior[0])), kind="already_paid", status_code=409)

    def _finish(self, action: dict[str, Any], bank: Bank, withdrawal_id: str, facts: BillFacts | None, from_status: str) -> dict[str, Any]:
        action_id = action["action_id"]
        try:
            readback = check_readback(
                bank.read_withdrawal(withdrawal_id),
                withdrawal_id=withdrawal_id,
                account_id=action["from_account"],
                amount_cents=action["amount_cents"],
                action_id=action_id,
            )
        except BankError as exc:
            readback = {"ok": False, "checks": {}, "status": None, "error": "read-back failed", "detail": str(exc)}
        # The bill changes only once the bank shows the money that paid it.
        bill = self._settle_bill(bank, facts, action) if facts is not None and readback["ok"] else None
        status = "done" if readback["ok"] else "unverified"
        at = iso(self.clock())
        # The bank's description names the payee, so the stored copy of the read-back leaves it out. So does the
        # bill's outcome: ids, amounts, and rule ids only.
        stored: dict[str, Any] = {k: v for k, v in readback.items() if k in ("ok", "checks", "status")}
        if bill is not None:
            stored["bill"] = bill
        self.repo.transition_action(action_id, from_status, status, {"finished_at": at, "withdrawal_id": withdrawal_id, "readback": stored})
        data: dict[str, Any] = {
            "amount_cents": action["amount_cents"],
            "withdrawal_id": withdrawal_id,
            "readback_ok": readback["ok"],
            "bank": bank.mode,
            "dry_run": action["dry_run"],
        }
        if facts is not None:
            data.update({"bill_id": facts.bill_id, "bill_updated": bool(bill and bill.get("ok"))})
        row = self.repo.append_audit("executed" if readback["ok"] else "unverified", action_id, data, at)
        return self._result(action, withdrawal_id, readback, bill, facts, row, at)

    def _settle_bill(self, bank: Bank, facts: BillFacts, action: dict[str, Any]) -> dict[str, Any]:
        """Update the bank's bill to what is still owed, then read it back."""
        outcome: dict[str, Any] = {
            "bill_id": facts.bill_id,
            "held_cents": facts.held_cents,
            "held_rule_ids": facts.held_rule_ids,
            "total_cents": facts.total_cents,
        }
        try:
            paid = paid_cents(bank.tagged_withdrawals(action["from_account"], f"[bill:{facts.bill_id}"), facts.bill_id)
            target = bill_target(facts, paid)
            current = bank.read_bill(facts.bill_id)
            updated = current is None or not all(bill_matches(current, target).values())
            if updated:
                done = target["status"] == "completed"
                bank.update_bill(facts.bill_id, payment_date=local_today(self.clock()) if done else None, **target)
            after = bank.read_bill(facts.bill_id)
        except BankError as exc:
            cause = exc.__cause__ or exc
            return {**outcome, "ok": False, "updated": False, "error_kind": type(cause).__name__}
        checks = bill_matches(after, target)
        return {
            **outcome,
            "ok": all(checks.values()),
            "updated": updated,
            "checks": checks,
            "status": (after or {}).get("status"),
            "amount_cents": (after or {}).get("amount_cents"),
            "paid_cents": paid,
        }

    def _result(
        self,
        action: dict[str, Any],
        withdrawal_id: str | None,
        readback: dict[str, Any],
        bill: dict[str, Any] | None,
        facts: BillFacts | None,
        row: dict[str, Any] | None,
        at: str | None,
        replayed: bool = False,
    ) -> dict[str, Any]:
        amount = format_cents(action["amount_cents"])
        payee = action.get("payee")
        paid = f"Paid {amount} to {payee}." if payee else f"Paid {amount}."
        if replayed:
            paid = f"Paid {amount} earlier. Nothing moved this time."
        if action["dry_run"]:
            message = f"{paid} Dry run: Tend recorded it and read it back, but did not send it to the bank."
        elif readback["ok"]:
            message = f"{paid} Nessie recorded it as withdrawal {withdrawal_id}."
        else:
            message = (
                f"Sent, but the bank's record does not match what you approved. Check the account; Tend labeled it {action['action_id']}."
            )
        if bill is not None:
            message = f"{message} {self._bill_sentence(bill, facts, action['dry_run'])}"
        out: dict[str, Any] = {
            "action_id": action["action_id"],
            "status": "done" if readback["ok"] else "unverified",
            "amount_cents": action["amount_cents"],
            "from": action["from_account"],
            "payee": payee,
            "bill_id": action.get("bill_id"),
            "item_ids": action.get("item_ids") or [],
            "dry_run": action["dry_run"],
            "nessie_id": withdrawal_id,
            "withdrawal_id": withdrawal_id,
            "read_back_matches": readback["ok"],
            "readback": readback,
            "bill": bill,
            "message": message,
            "at": at,
            "replayed": replayed,
        }
        if row is not None:
            out["audit_id"] = f"aud_{row['seq']:06d}"
            out["audit"] = {"seq": row["seq"], "hash": row["hash"], "prev_hash": row["prev_hash"]}
        return out

    @staticmethod
    def _bill_sentence(bill: dict[str, Any], facts: BillFacts | None, dry_run: bool) -> str:
        if not bill.get("ok"):
            return "The bank did not take the bill update, so the bill there may still show the old amount."
        where = "here only" if dry_run else "in Nessie"
        if bill.get("status") == "completed":
            return f"The bill is marked paid {where}."
        left = format_cents(bill.get("amount_cents") or 0)
        note = facts.hold_note() if facts else None
        if note:
            return f"The bill {where} now shows {left} left: the {note}. Tend will not pay it."
        rules = bill.get("held_rule_ids") or []
        if bill.get("held_cents") and rules:
            return f"The bill {where} now shows {left} left, held under {rules[0]}. Tend will not pay it."
        return f"The bill {where} now shows {left} left."

    def _replay(self, action: dict[str, Any]) -> dict[str, Any]:
        stored = action.get("readback") or {}
        readback = {"ok": stored.get("ok") is True, "checks": stored.get("checks") or {}, "status": stored.get("status")}
        rows = [r for r in self.repo.audit_rows(action["action_id"]) if r["event"] in ("executed", "unverified")]
        return self._result(
            action,
            action.get("withdrawal_id"),
            readback,
            stored.get("bill"),
            None,
            rows[-1] if rows else None,
            action.get("finished_at"),
            replayed=True,
        )

    def _reconcile(self, action: dict[str, Any]) -> dict[str, Any]:
        """A payment whose answer never came back, or whose process went away: find it in the bank by its label."""
        bank = self._bank(action["dry_run"])
        action_id = action["action_id"]
        withdrawal_id = action.get("withdrawal_id") or bank.find_withdrawal(action["from_account"], action_id)
        if not withdrawal_id:
            if action["status"] == "executing":
                at = iso(self.clock())
                if self.repo.transition_action(action_id, "executing", "unverified", {"finished_at": at, "error_kind": "no_answer"}):
                    self.repo.append_audit(
                        "unverified", action_id, {"error_kind": "no_answer", "maybe_applied": True, "dry_run": action["dry_run"]}, at
                    )
            raise ActionError(
                f"The bank shows no payment labeled {action_id}. Tend will not send it again. "
                "If you still want to pay, start a new payment.",
                409,
            )
        try:
            record = bank.read_withdrawal(withdrawal_id)
        except BankError as exc:
            raise ActionError(f"The bank did not answer the check, so nothing new was sent. Try again. ({exc})", 502) from exc
        readback = check_readback(
            record, withdrawal_id=withdrawal_id, account_id=action["from_account"], amount_cents=action["amount_cents"], action_id=action_id
        )
        if not readback["ok"]:
            raise ActionError(
                f"The bank's record for this payment does not match what you approved. Check the account; Tend labeled it {action_id}.", 409
            )
        try:
            facts = self._facts(action)
        except Exception:  # the money is found either way; the bill can be settled on the next look
            facts = None
        result = self._finish(action, bank, withdrawal_id, facts, action["status"])
        return {**result, "replayed": True}

    def _record_failure(self, action: dict[str, Any], exc: BankError, kind: str | None = None, status_code: int = 502) -> ActionError:
        action_id = action["action_id"]
        status = "unverified" if exc.maybe_applied else "failed"
        at = iso(self.clock())
        # The bank's error text can echo the payee, so storage keeps only what kind of failure it was.
        kind = kind or (type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__)
        self.repo.transition_action(action_id, "executing", status, {"finished_at": at, "error_kind": kind})
        self.repo.append_audit(
            status, action_id, {"error_kind": kind, "maybe_applied": exc.maybe_applied, "dry_run": action["dry_run"]}, at
        )
        if exc.maybe_applied:
            return ActionError(
                f"The bank did not answer, so this payment may have gone through ({exc}). "
                f"Check the account before trying again; Tend labeled it {action_id}.",
                502,
            )
        if kind == "already_paid":
            return ActionError(str(exc), status_code)
        return ActionError(f"The bank refused this payment, so no money moved: {exc}", status_code)

    def view(self, action_id: str) -> dict[str, Any]:
        action = self.repo.get_action(action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        shown = {
            k: action.get(k)
            for k in (
                "action_id",
                "status",
                "amount_cents",
                "payee",
                "channel",
                "dry_run",
                "bill_id",
                "item_ids",
                "attempts",
                "created_at",
                "expires_at",
                "confirmed_at",
                "finished_at",
                "withdrawal_id",
                "readback",
                "error_kind",
            )
        }
        shown["from"] = action["from_account"]
        shown["audit"] = [{k: row[k] for k in ("seq", "ts", "event", "hash", "prev_hash")} for row in self.repo.audit_rows(action_id)]
        return shown
