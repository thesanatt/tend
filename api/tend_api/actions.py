from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import secrets
from typing import Any

from .bank import Bank, BankError, check_readback
from .clock import Clock, iso, parse_iso
from .errors import TendError
from .models import ConfirmRequest, ProposeRequest
from .money import canonical_json
from .storage import Repository

CODE_TTL = dt.timedelta(minutes=10)
MAX_ATTEMPTS = 5


class ActionError(TendError):
    pass


def code_mac(secret: bytes, action_id: str, amount_cents: int, from_account: str, payee: str, code: str) -> str:
    # The code only verifies against these exact values, so editing a stored action breaks confirmation.
    message = canonical_json({"action_id": action_id, "amount_cents": amount_cents, "from": from_account, "payee": payee, "code": code})
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


class ActionService:
    def __init__(self, repo: Repository, banks: dict[str, Bank], default_mode: str, secret: bytes, clock: Clock):
        self.repo = repo
        self.banks = banks
        self.default_mode = default_mode
        self.secret = secret
        self.clock = clock

    def propose(self, req: ProposeRequest) -> dict[str, Any]:
        if req.claim_id is not None:
            self._check_claim_line(req.claim_id, req.item_id)
        # A request can ask for a dry run on a live server, never a live write on a dry-run server.
        dry_run = bool(req.dry_run) or self.default_mode == "dry_run"
        action_id = f"act_{secrets.token_hex(10)}"
        code = f"{secrets.randbelow(1_000_000):06d}"
        now = self.clock()
        expires_at = iso(now + CODE_TTL)
        self.repo.insert_action({
            "action_id": action_id, "status": "proposed", "amount_cents": req.amount_cents,
            "from_account": req.from_account, "payee": req.payee, "claim_id": req.claim_id, "item_id": req.item_id,
            "code_mac": code_mac(self.secret, action_id, req.amount_cents, req.from_account, req.payee, code),
            "dry_run": dry_run, "created_at": iso(now), "expires_at": expires_at,
        })
        self.repo.append_audit("proposed", action_id, {
            "amount_cents": req.amount_cents, "from": req.from_account, "payee": req.payee,
            "claim_id": req.claim_id, "item_id": req.item_id, "dry_run": dry_run, "expires_at": expires_at,
        }, iso(now))
        return {
            "action_id": action_id, "status": "proposed", "amount_cents": req.amount_cents, "from": req.from_account,
            "payee": req.payee, "confirm_code": code, "expires_at": expires_at, "dry_run": dry_run,
        }

    def _check_claim_line(self, claim_id: str, item_id: str | None) -> None:
        claim = self.repo.get_claim(claim_id)
        if claim is None:
            raise ActionError(f"claim {claim_id} not found", 404)
        if item_id is None:
            return
        line = next((ln for ln in claim["output"].get("lines", []) if ln.get("item_id") == item_id), None)
        if line is None:
            raise ActionError(f"item {item_id} is not a line of claim {claim_id}", 404)
        if line.get("status") == "held":
            raise ActionError("This line is held under the exam billing law. Ask billing to remove it first; Tend will not pay it.", 409)

    def confirm(self, req: ConfirmRequest) -> dict[str, Any]:
        action = self.repo.get_action(req.action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        now = self.clock()
        if action["status"] != "proposed":
            raise ActionError(f"This action is already {action['status']}. Each confirm code works once.", 409)
        if parse_iso(action["expires_at"]) <= now:
            if self.repo.transition_action(action["action_id"], "proposed", "expired", {"finished_at": iso(now)}):
                self.repo.append_audit("expired", action["action_id"], {}, iso(now))
            raise ActionError("This confirm code expired. Propose the payment again to get a new code.", 410)

        expected = code_mac(self.secret, action["action_id"], action["amount_cents"], action["from_account"], action["payee"], req.confirm_code)
        if not hmac.compare_digest(expected, action["code_mac"]):
            attempts = self.repo.count_failed_attempt(action["action_id"], MAX_ATTEMPTS)
            self.repo.append_audit("code_rejected", action["action_id"], {"attempts": attempts}, iso(now))
            if attempts >= MAX_ATTEMPTS:
                self.repo.append_audit("locked", action["action_id"], {"attempts": attempts}, iso(now))
                raise ActionError("Too many wrong codes. This action is locked; propose it again.", 423)
            raise ActionError("That code does not match this action.", 403)

        mismatched = [
            name for name, sent, stored in (
                ("amount_cents", req.amount_cents, action["amount_cents"]),
                ("from", req.from_account, action["from_account"]),
                ("payee", req.payee, action["payee"]),
            ) if sent is not None and sent != stored
        ]
        if mismatched:
            raise ActionError(f"The confirmation does not match the proposed action ({', '.join(mismatched)}).", 409)

        if not self.repo.transition_action(action["action_id"], "proposed", "executing", {"confirmed_at": iso(now)}, not_expired_at=iso(now)):
            raise ActionError("This action was already confirmed or has expired.", 409)
        self.repo.append_audit("confirmed", action["action_id"], {"amount_cents": action["amount_cents"]}, iso(now))
        return self._execute(action)

    def _execute(self, action: dict[str, Any]) -> dict[str, Any]:
        bank = self.banks["dry_run" if action["dry_run"] else "nessie"]
        action_id = action["action_id"]
        description = f"Tend {action_id} to {action['payee']}"[:120]
        try:
            withdrawal_id = bank.withdraw(action["from_account"], action["amount_cents"], description)
        except BankError as exc:
            at = iso(self.clock())
            self.repo.transition_action(action_id, "executing", "failed", {"finished_at": at, "error": str(exc)})
            self.repo.append_audit("failed", action_id, {"error": str(exc)[:300], "dry_run": action["dry_run"]}, at)
            raise ActionError(f"The bank did not accept the payment, so no money moved: {exc}", 502) from exc

        try:
            readback = check_readback(
                bank.read_withdrawal(withdrawal_id), withdrawal_id=withdrawal_id, account_id=action["from_account"],
                amount_cents=action["amount_cents"], action_id=action_id,
            )
        except BankError as exc:
            readback = {"ok": False, "error": str(exc)}
        status = "executed" if readback["ok"] else "unverified"
        at = iso(self.clock())
        self.repo.transition_action(action_id, "executing", status, {"finished_at": at, "nessie_id": withdrawal_id, "readback": readback})
        row = self.repo.append_audit(status, action_id, {
            "amount_cents": action["amount_cents"], "from": action["from_account"], "payee": action["payee"],
            "withdrawal_id": withdrawal_id, "readback_ok": readback["ok"], "dry_run": action["dry_run"], "bank": bank.mode,
        }, at)
        return {
            "action_id": action_id, "status": status, "amount_cents": action["amount_cents"], "from": action["from_account"],
            "payee": action["payee"], "dry_run": action["dry_run"], "withdrawal_id": withdrawal_id, "readback": readback,
            "audit": {"seq": row["seq"], "hash": row["hash"], "prev_hash": row["prev_hash"]},
        }

    def view(self, action_id: str) -> dict[str, Any]:
        action = self.repo.get_action(action_id)
        if action is None:
            raise ActionError("No action with that id.", 404)
        action.pop("code_mac", None)
        action["from"] = action.pop("from_account")
        action["audit"] = [
            {k: row[k] for k in ("seq", "ts", "event", "hash", "prev_hash")} for row in self.repo.audit_rows(action_id)
        ]
        return action
