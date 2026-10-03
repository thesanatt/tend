"""Payments that move only after the survivor's explicit yes.

propose returns a six-digit code that works once, for ten minutes. confirm checks it, writes the
withdrawal to the bank tagged with the action id, reads the bank's record back, and appends the
outcome to the hash-chained audit log. The code is never stored, only a MAC that binds it to the
action id, amount, account, and payee. The audit log holds amounts, ids, and keyed hashes, never
a name; the pending action loses its payee as soon as it finishes or expires.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import secrets
from collections.abc import Callable
from typing import Any

from .bank import Bank, BankError, check_readback
from .clock import Clock, iso, local_today, parse_iso
from .db import Repository
from .errors import TendError
from .models import ConfirmRequest, ProposeRequest
from .money import canonical_json, format_cents

CODE_TTL = dt.timedelta(minutes=10)
MAX_ATTEMPTS = 5
HELD_MESSAGE = "This line is held under the exam billing law. Ask billing to remove it first; Tend will not pay it."

# bill_id -> what Tend knows about that bill: persona, accounts, and each line with the engine's status.
BillReview = Callable[[str], dict[str, Any] | None]


class ActionError(TendError):
    pass


def code_mac(secret: bytes, action_id: str, amount_cents: int, from_account: str, payee: str, code: str) -> str:
    # The code verifies only against these exact values, so editing a stored action breaks confirmation.
    message = canonical_json({"action_id": action_id, "amount_cents": amount_cents, "from": from_account, "payee": payee, "code": code})
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def withdrawal_description(payee: str, action_id: str) -> str:
    # The [tend:...] tag lets the read-back find this record and the classifier set it aside later.
    return f"Payment to {payee[:70]} [tend:{action_id}]"


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
    ):
        self.repo = repo
        self.banks = banks
        self.default_mode = default_mode
        self.secret = secret
        self.clock = clock
        self.bill_review = bill_review or (lambda bill_id: None)
        self.live_accounts = live_accounts or set

    def _tag(self, kind: str, value: str) -> str:
        """A keyed hash: ties log rows to one account or payee without the log holding the name."""
        return hmac.new(self.secret, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()[:32]

    def propose(self, req: ProposeRequest, channel: str = "app") -> dict[str, Any]:
        now = self.clock()
        self.repo.sweep(iso(now))
        item_ids = self._check_bill(req) if req.bill_id else []
        # A request can ask for a dry run on a live server, never a live write on a dry-run server.
        dry_run = bool(req.dry_run) or self.default_mode == "dry_run"
        bank = self.banks["dry_run" if dry_run else "nessie"]
        if bank.whole_dollars and req.amount_cents % 100:
            raise ActionError("Nessie stores whole dollars, so a live payment has to be a whole-dollar amount.", 422)
        # The API has no sign-in, so live writes are limited to the demo personas' own accounts.
        if not dry_run and req.from_account not in self.live_accounts():
            raise ActionError("Live payments can only come from a demo persona's account.", 403)
        action_id = f"act_{secrets.token_hex(10)}"
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_at = iso(now + CODE_TTL)
        self.repo.insert_action(
            {
                "action_id": action_id,
                "status": "proposed",
                "amount_cents": req.amount_cents,
                "from_account": req.from_account,
                "payee": req.payee,
                "payee_tag": self._tag("payee", req.payee),
                "code_mac": code_mac(self.secret, action_id, req.amount_cents, req.from_account, req.payee, code),
                "channel": channel,
                "dry_run": dry_run,
                "bill_id": req.bill_id,
                "item_ids": item_ids,
                "created_at": iso(now),
                "expires_at": expires_at,
            }
        )
        return {
            "action_id": action_id,
            "status": "proposed",
            "kind": "pay_bill" if req.bill_id else "payment",
            "amount_cents": req.amount_cents,
            "from": req.from_account,
            "payee": req.payee,
            "bill_id": req.bill_id,
            "item_ids": item_ids,
            "confirm_code": code,
            "expires_at": expires_at,
            "dry_run": dry_run,
        }

    def _check_bill(self, req: ProposeRequest) -> list[str]:
        """Paying a bill Tend has read: the law engine runs on every line again, held lines are never paid,
        and the amount must be exactly the lines being paid. Nothing about the bill is stored."""
        review = self.bill_review(req.bill_id or "")
        if review is None:
            raise ActionError("Tend has no itemized record of this bill. Leave out bill_id to pay it as a plain payment.", 404)
        lines = {ln["item_id"]: ln for ln in review["lines"]}
        held = [i for i, ln in lines.items() if ln.get("status") == "held"]
        item_ids = list(dict.fromkeys(req.item_ids)) if req.item_ids else [i for i in lines if i not in held]
        unknown = [i for i in item_ids if i not in lines]
        if unknown:
            raise ActionError(f"These are not lines of this bill: {', '.join(unknown[:3])}.", 404)
        if any(i in held for i in item_ids):
            raise ActionError(HELD_MESSAGE, 409)
        total = sum(lines[i]["amount_cents"] for i in item_ids)
        if total != req.amount_cents:
            raise ActionError(f"The amount does not match the lines being paid ({format_cents(total)}).", 409)
        accounts = review.get("accounts") or set()
        if accounts and req.from_account not in accounts:
            raise ActionError("Payments can only come from your own accounts.", 403)
        return item_ids

    def confirm(self, req: ConfirmRequest, channel: str = "app") -> dict[str, Any]:
        action = self.repo.get_action(req.action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        if action["channel"] != channel:
            # An agent-proposed payment needs the survivor's typed approval, which only the agent route checks.
            raise ActionError(f"This payment was set up through the {action['channel']}; approve it there.", 409)
        now = self.clock()
        if action["status"] == "expired":
            raise ActionError("This confirm code expired. Propose the payment again to get a new code.", 410)
        if action["status"] == "locked":
            raise ActionError("Too many wrong codes. This action is locked; propose it again.", 423)
        if action["status"] != "proposed":
            raise ActionError(f"This action is already {action['status']}. Each confirm code works once.", 409)
        if parse_iso(action["expires_at"]) <= now:
            self.repo.transition_action(action["action_id"], "proposed", "expired", {"finished_at": iso(now)})
            raise ActionError("This confirm code expired. Propose the payment again to get a new code.", 410)

        expected = code_mac(
            self.secret, action["action_id"], action["amount_cents"], action["from_account"], action["payee"], req.confirm_code
        )
        if not hmac.compare_digest(expected, action["code_mac"]):
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

    def _execute(self, action: dict[str, Any]) -> dict[str, Any]:
        bank = self.banks["dry_run" if action["dry_run"] else "nessie"]
        action_id = action["action_id"]
        try:
            withdrawal_id = bank.withdraw(
                action["from_account"],
                action["amount_cents"],
                withdrawal_description(action["payee"], action_id),
                local_today(self.clock()),
            )
        except BankError as exc:
            # A write can land even when no answer came back; the action id in the description finds it.
            found = bank.find_withdrawal(action["from_account"], action_id) if exc.maybe_applied else None
            if found is None:
                raise self._record_failure(action, exc) from exc
            withdrawal_id = found

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
        status = "done" if readback["ok"] else "unverified"
        at = iso(self.clock())
        # The bank's description names the payee, so the stored copy of the read-back leaves it out.
        stored = {k: v for k, v in readback.items() if k in ("ok", "checks", "status")}
        self.repo.transition_action(action_id, "executing", status, {"finished_at": at, "withdrawal_id": withdrawal_id, "readback": stored})
        row = self.repo.append_audit(
            "executed" if readback["ok"] else "unverified",
            action_id,
            {
                "amount_cents": action["amount_cents"],
                "withdrawal_id": withdrawal_id,
                "readback_ok": readback["ok"],
                "bank": bank.mode,
                "dry_run": action["dry_run"],
            },
            at,
        )
        paid = f"Paid {format_cents(action['amount_cents'])} to {action['payee']}."
        if action["dry_run"]:
            message = f"{paid} Dry run: Tend recorded it and read it back, but did not send it to the bank."
        elif readback["ok"]:
            message = f"{paid} Nessie recorded it as withdrawal {withdrawal_id}."
        else:
            message = f"Sent, but the bank's record does not match what you approved. Check the account; Tend labeled it {action_id}."
        return {
            "action_id": action_id,
            "status": status,
            "amount_cents": action["amount_cents"],
            "from": action["from_account"],
            "payee": action["payee"],
            "bill_id": action.get("bill_id"),
            "item_ids": action.get("item_ids") or [],
            "dry_run": action["dry_run"],
            "nessie_id": withdrawal_id,
            "withdrawal_id": withdrawal_id,
            "read_back_matches": readback["ok"],
            "readback": readback,
            "audit_id": f"aud_{row['seq']:06d}",
            "audit": {"seq": row["seq"], "hash": row["hash"], "prev_hash": row["prev_hash"]},
            "message": message,
            "at": at,
        }

    def _record_failure(self, action: dict[str, Any], exc: BankError) -> ActionError:
        action_id = action["action_id"]
        status = "unverified" if exc.maybe_applied else "failed"
        at = iso(self.clock())
        # The bank's error text can echo the payee, so storage keeps only what kind of failure it was.
        kind = type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__
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
        return ActionError(f"The bank refused this payment, so no money moved: {exc}", 502)

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
