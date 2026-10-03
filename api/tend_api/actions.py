from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import secrets
from collections.abc import Callable
from typing import Any

from .bank import Bank, BankError, check_readback
from .clock import Clock, iso, local_today, parse_iso
from .errors import TendError
from .models import ConfirmRequest, ProposeRequest
from .money import canonical_json, format_cents
from .storage import Repository

CODE_TTL = dt.timedelta(minutes=10)
MAX_ATTEMPTS = 5
HELD_MESSAGE = "This line is held under the exam billing law. Ask billing to remove it first; Tend will not pay it."

UNCHECKED_MESSAGE = "Tend has not checked this bill against the law yet. Check the bill first, then pay what is left."

AccountsForScan = Callable[[str], set[str] | None]


class ActionError(TendError):
    pass


def code_mac(secret: bytes, action_id: str, amount_cents: int, from_account: str, payee: str, code: str) -> str:
    # The code only verifies against these exact values, so editing a stored action breaks confirmation.
    message = canonical_json({"action_id": action_id, "amount_cents": amount_cents, "from": from_account, "payee": payee, "code": code})
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


class ActionService:
    def __init__(
        self,
        repo: Repository,
        banks: dict[str, Bank],
        default_mode: str,
        secret: bytes,
        clock: Clock,
        accounts_for_scan: AccountsForScan | None = None,
        live_accounts: Callable[[], set[str]] | None = None,
    ):
        self.repo = repo
        self.banks = banks
        self.default_mode = default_mode
        self.secret = secret
        self.clock = clock
        self.accounts_for_scan = accounts_for_scan or (lambda scan_id: None)
        self.live_accounts = live_accounts or set

    def propose(self, req: ProposeRequest, channel: str = "app") -> dict[str, Any]:
        if req.claim_id is not None:
            self._check_claim_line(req.claim_id, req.item_id, req.amount_cents)
        if req.item_ids:
            self._check_bill_lines(req.item_ids, req.amount_cents, req.from_account)
        # A request can ask for a dry run on a live server, never a live write on a dry-run server.
        dry_run = bool(req.dry_run) or self.default_mode == "dry_run"
        bank = self.banks["dry_run" if dry_run else "nessie"]
        if bank.whole_dollars and req.amount_cents % 100:
            raise ActionError("Nessie stores whole dollars, so a live payment has to be a whole-dollar amount.", 422)
        # The API has no sign-in yet, so live writes are limited to the demo personas' own accounts.
        if not dry_run and req.from_account not in self.live_accounts():
            raise ActionError("Live payments can only come from a demo persona's account.", 403)
        action_id = f"act_{secrets.token_hex(10)}"
        code = f"{secrets.randbelow(1_000_000):06d}"
        now = self.clock()
        expires_at = iso(now + CODE_TTL)
        self.repo.insert_action(
            {
                "action_id": action_id,
                "status": "proposed",
                "amount_cents": req.amount_cents,
                "from_account": req.from_account,
                "payee": req.payee,
                "claim_id": req.claim_id,
                "item_id": req.item_id,
                "bill_id": req.bill_id,
                "item_ids": req.item_ids or [],
                "code_mac": code_mac(self.secret, action_id, req.amount_cents, req.from_account, req.payee, code),
                "channel": channel,
                "dry_run": dry_run,
                "created_at": iso(now),
                "expires_at": expires_at,
            }
        )
        self.repo.append_audit(
            "proposed",
            action_id,
            {
                "amount_cents": req.amount_cents,
                **self._tags(req.from_account, req.payee),
                "claim_id": req.claim_id,
                "item_id": req.item_id,
                "bill_id": req.bill_id,
                "item_ids": req.item_ids or [],
                "channel": channel,
                "dry_run": dry_run,
                "expires_at": expires_at,
            },
            iso(now),
        )
        return {
            "action_id": action_id,
            "status": "proposed",
            "kind": req.kind or "payment",
            "amount_cents": req.amount_cents,
            "from": req.from_account,
            "payee": req.payee,
            "bill_id": req.bill_id,
            "item_ids": req.item_ids or [],
            "confirm_code": code,
            "expires_at": expires_at,
            "dry_run": dry_run,
        }

    def _check_claim_line(self, claim_id: str, item_id: str | None, amount_cents: int) -> None:
        claim = self.repo.get_claim(claim_id)
        if claim is None:
            raise ActionError(f"claim {claim_id} not found", 404)
        if item_id is None:
            return
        line = next((ln for ln in claim["output"].get("lines", []) if ln.get("item_id") == item_id), None)
        if line is None:
            raise ActionError(f"item {item_id} is not a line of claim {claim_id}", 404)
        if line.get("status") == "held":
            raise ActionError(HELD_MESSAGE, 409)
        owed = line.get("requested_cents")
        if isinstance(owed, int) and amount_cents > owed:
            raise ActionError(f"The amount is more than this line ({format_cents(owed)}).", 409)

    def _check_bill_lines(self, item_ids: list[str], amount_cents: int, from_account: str) -> None:
        """Paying named lines: each must be a line Tend read, none held, and the amount must be exactly their sum."""
        records = self.repo.evidence_for(item_ids)
        unknown = [i for i in item_ids if i not in records]
        if unknown:
            raise ActionError(f"Tend has no record of {', '.join(unknown[:3])}. Scan or audit the bill first.", 404)
        if any(records[i]["held"] for i in item_ids):
            raise ActionError(HELD_MESSAGE, 409)
        # A scan reads the itemized bill but does not run the law on it; the exam line could be among these.
        if not all(records[i]["checked"] for i in item_ids):
            raise ActionError(UNCHECKED_MESSAGE, 409)
        total = sum(records[i]["amount_cents"] for i in set(item_ids))
        if total != amount_cents:
            raise ActionError(f"The amount does not match the lines being paid ({format_cents(total)}).", 409)
        for scan_id in {records[i]["scan_id"] for i in item_ids}:
            accounts = self.accounts_for_scan(scan_id)
            if accounts and from_account not in accounts:
                raise ActionError("Payments can only come from your own accounts.", 403)

    def confirm(self, req: ConfirmRequest, channel: str = "app") -> dict[str, Any]:
        action = self.repo.get_action(req.action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        if action["channel"] != channel:
            # An agent-proposed payment needs the survivor's typed approval, which only the agent route checks.
            raise ActionError(f"This payment was set up through the {action['channel']}; approve it there.", 409)
        now = self.clock()
        if action["status"] != "proposed":
            raise ActionError(f"This action is already {action['status']}. Each confirm code works once.", 409)
        if parse_iso(action["expires_at"]) <= now:
            if self.repo.transition_action(action["action_id"], "proposed", "expired", {"finished_at": iso(now)}):
                self.repo.append_audit("expired", action["action_id"], {}, iso(now))
            raise ActionError("This confirm code expired. Propose the payment again to get a new code.", 410)

        expected = code_mac(
            self.secret, action["action_id"], action["amount_cents"], action["from_account"], action["payee"], req.confirm_code
        )
        if not hmac.compare_digest(expected, action["code_mac"]):
            attempts = self.repo.count_failed_attempt(action["action_id"], MAX_ATTEMPTS)
            self.repo.append_audit("code_rejected", action["action_id"], {"attempts": attempts}, iso(now))
            if attempts >= MAX_ATTEMPTS:
                self.repo.append_audit("locked", action["action_id"], {"attempts": attempts}, iso(now))
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
        self.repo.append_audit("confirmed", action["action_id"], {"amount_cents": action["amount_cents"]}, iso(now))
        return self._execute(action)

    def _execute(self, action: dict[str, Any]) -> dict[str, Any]:
        bank = self.banks["dry_run" if action["dry_run"] else "nessie"]
        action_id = action["action_id"]
        description = f"Tend {action_id} to {action['payee']}"[:120]
        try:
            withdrawal_id = bank.withdraw(action["from_account"], action["amount_cents"], description, local_today(self.clock()))
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
            readback = {"ok": False, "error": str(exc)}
        status = "done" if readback["ok"] else "unverified"
        at = iso(self.clock())
        self.repo.transition_action(action_id, "executing", status, {"finished_at": at, "nessie_id": withdrawal_id, "readback": readback})
        row = self.repo.append_audit(
            "executed" if readback["ok"] else "unverified",
            action_id,
            {
                "amount_cents": action["amount_cents"],
                **self._tags(action["from_account"], action["payee"]),
                "withdrawal_id": withdrawal_id,
                "readback_ok": readback["ok"],
                "dry_run": action["dry_run"],
                "bank": bank.mode,
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
        self.repo.transition_action(action_id, "executing", status, {"finished_at": at, "error": str(exc)})
        # The bank's error text can echo the payee, so the permanent log keeps only what kind of failure it was.
        kind = type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__
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

    def _tags(self, from_account: str, payee: str) -> dict[str, str]:
        """Keyed hashes that tie an audit row to its action without the log holding a name (docs/PRIVACY.md)."""

        def tag(kind: str, value: str) -> str:
            return hmac.new(self.secret, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()[:32]

        return {"from_tag": tag("from", from_account), "payee_tag": tag("payee", payee)}

    def view(self, action_id: str) -> dict[str, Any]:
        action = self.repo.get_action(action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        action.pop("code_mac", None)
        action["from"] = action.pop("from_account")
        action["audit"] = [{k: row[k] for k in ("seq", "ts", "event", "hash", "prev_hash")} for row in self.repo.audit_rows(action_id)]
        return action
