"""What it looks like when the program pays: a demo deposit into a fictional persona's account.

Track's "Show what it looks like when the program pays (demo)" sends the amount the device's law engine
computed as claimable. Tend writes one deposit to Capital One's Nessie mock bank, from the state's
program (named in the description, because a Nessie deposit has no payer field), into the persona's
checking account, and reads it back. It shows a future event and promises nothing: the program decides
what it pays, and when. Only fictional demo personas; whole dollars only, because Nessie truncates
anything else; one demo payment per account: the same request again is the same deposit, and a new amount replaces it. Nothing about it is
stored on Tend's server.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .bank import Bank, BankError, record_cents
from .clock import local_today
from .errors import TendError
from .money import format_cents
from .nessie import BankSnapshot
from .relay import BankRelay

MARKER = "[tend:payout"
# A demo payment larger than this is a client error, whatever the state's cap.
MAX_PAYOUT_CENTS = 100_000_000


class PayoutError(TendError):
    pass


class PayoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    st: Annotated[str, Field(pattern=r"^[A-Z]{2}$")]
    amount_cents: Annotated[int, Field(strict=True, gt=0, le=MAX_PAYOUT_CENTS)]  # what the device computed as claimable

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return v.strip().upper() if isinstance(v, str) else v


def program_name(law: dict[str, Any]) -> str:
    """The program as a bank statement would name the payer: "Michigan Crime Victim Compensation"."""
    state = str(law.get("name") or law.get("jurisdiction") or "").strip()
    program = str((law.get("program") or {}).get("program_name") or "Crime Victim Compensation").strip()
    named = program if state and state.lower() in program.lower() else f"{state} {program}".strip()
    return named[:80]


def payout_description(program: str, st: str) -> str:
    return f"{program} demo payment (fictional) [tend:payout-{st}]"


def total_cap_cents(law: dict[str, Any]) -> int | None:
    caps = [
        r["params"]["amount_cents"]
        for r in law.get("rules") or []
        if r.get("category") == "total_cap" and isinstance((r.get("params") or {}).get("amount_cents"), int)
    ]
    return min(caps) if caps else None  # several caps: the smallest, as the engine reads them


class Payouts:
    def __init__(self, relay: BankRelay, rules: Any, banks: dict[str, Bank], bank_mode: str, clock: Any):
        self.relay = relay
        self.rules = rules
        self.banks = banks
        self.bank_mode = bank_mode
        self.clock = clock

    @classmethod
    def from_services(cls, svc: Any) -> Payouts:
        return cls(svc.relay, svc.rules, svc.actions.banks, svc.settings.bank_mode, svc.clock)

    def bank(self) -> Bank:
        return self.banks["dry_run" if self.bank_mode == "dry_run" else "nessie"]

    def persona(self, persona_id: str) -> BankSnapshot:
        snapshot = self.relay.saved(persona_id)
        if snapshot.meta.get("fictional") is not True:
            raise PayoutError("Demo payments go only to fictional demo personas.", 403)
        return snapshot

    def pay(self, persona_id: str, req: PayoutRequest) -> dict[str, Any]:
        snapshot = self.persona(persona_id)
        law = self.rules.get(req.st)
        if law is None:
            raise PayoutError(f"No verified rules for {req.st}.", 404)
        cap = total_cap_cents(law)
        if cap is not None and req.amount_cents > cap:
            raise PayoutError(
                f"That is more than {law.get('name') or req.st}'s cap of {format_cents(cap)}, so it is not a claimable amount.", 422
            )
        account = BankRelay.account(snapshot, "checking")
        bank = self.bank()
        cents = req.amount_cents - req.amount_cents % 100 if bank.whole_dollars else req.amount_cents
        if cents <= 0:
            raise PayoutError("Nessie keeps whole dollars, and this is less than one.", 422)
        tag = f"[tend:payout-{req.st}]"
        try:
            existing = bank.tagged_deposits(account.id, MARKER)
        except BankError as exc:
            raise PayoutError(f"The bank did not answer, so nothing was deposited. ({exc})", 502) from exc
        same = [d for d in existing if tag in str(d.get("description") or "") and record_cents(d) == cents]
        replaced: list[str] = []
        if same:
            deposit_id, replayed = str(same[0].get("id") or same[0].get("_id")), True
        else:
            # One demo payment per account. An earlier one for another amount (a device that was cleared without
            # its undo, or a claim that changed since) is replaced, so the demo never gets stuck behind it.
            try:
                for old in existing:
                    old_id = str(old.get("id") or old.get("_id"))
                    bank.delete_deposit(old_id)
                    replaced.append(old_id)
            except BankError as exc:
                raise PayoutError(f"The bank did not remove the earlier demo deposit, so nothing new was deposited. ({exc})", 502) from exc
            deposit_id, replayed = self._deposit(bank, account.id, cents, payout_description(program_name(law), req.st), tag), False
        readback = self._readback(bank, account.id, deposit_id, cents, tag)
        record = readback.pop("record", {})
        out = self._result(snapshot, law, req, account, bank, deposit_id, cents, readback, record, replayed)
        if replaced:
            out["replaced"] = replaced
            out["message"] = out["message"].replace(" It is fictional.", " It replaces an earlier demo deposit. It is fictional.", 1)
        return out

    def _deposit(self, bank: Bank, account_id: str, cents: int, description: str, tag: str) -> str:
        try:
            return bank.deposit(account_id, cents, description, local_today(self.clock()))
        except BankError as exc:
            # A deposit that may have landed is looked up by its tag before anyone tries again.
            found = None
            if exc.maybe_applied:
                try:
                    found = next((d for d in bank.tagged_deposits(account_id, tag)), None)
                except BankError:
                    found = None
            if found is None:
                raise PayoutError(f"The bank did not take the demo deposit, so nothing changed. ({exc})", 502) from exc
            return str(found.get("id") or found.get("_id"))

    @staticmethod
    def _readback(bank: Bank, account_id: str, deposit_id: str, cents: int, tag: str) -> dict[str, Any]:
        try:
            record = bank.read_deposit(deposit_id)
            # A Nessie deposit carries no account field, so the account check is the account's own list.
            listed = {str(d.get("id") or d.get("_id")) for d in bank.tagged_deposits(account_id, tag)}
        except BankError as exc:
            return {"ok": False, "checks": {}, "error": str(exc), "record": {}}
        checks = {
            "id": str(record.get("id") or record.get("_id") or "") == deposit_id,
            "amount": record_cents(record) == cents,
            "tagged": tag in str(record.get("description") or ""),
            "account": deposit_id in listed,
        }
        return {"ok": all(checks.values()), "checks": checks, "record": record}

    def _result(self, snapshot, law, req, account, bank, deposit_id, cents, readback, record, replayed) -> dict[str, Any]:
        program = program_name(law)
        number = account.account_number or ""
        where = f"{account.nickname} {number[-4:]}".strip()
        dry_run = bank.mode == "dry_run"
        amount = format_cents(cents)
        if dry_run:
            message = f"Demo: Tend recorded a deposit of {amount} from {program} into {where}, here only. Nothing was sent to the bank."
        elif replayed:
            message = f"Demo: this deposit of {amount} from {program} is already in {where} (Nessie deposit {deposit_id})."
        else:
            message = f"Demo: Nessie recorded a deposit of {amount} from {program} into {where} (deposit {deposit_id})."
        if cents != req.amount_cents:
            message += f" Nessie keeps whole dollars, so it is {amount}; the claim is {format_cents(req.amount_cents)}."
        message += " It is fictional. The program decides what it pays, and when."
        return {
            "deposit_id": deposit_id,
            "amount_cents": cents,
            "requested_cents": req.amount_cents,
            "program": program,
            "st": req.st,
            "persona_id": snapshot.meta.get("persona_id"),
            "account": {"id": account.id, "nickname": account.nickname, "mask": number[-4:] or None},
            "date": record.get("date") or record.get("transaction_date"),
            "dry_run": dry_run,
            "readback": readback,
            "read_back_matches": readback["ok"],
            "replayed": replayed,
            "fictional": True,
            "notice": snapshot.meta.get("notice"),
            "message": message,
        }

    def undo(self, persona_id: str) -> dict[str, Any]:
        snapshot = self.persona(persona_id)
        bank = self.bank()
        deleted = []
        try:
            for account in snapshot.accounts:
                for record in bank.tagged_deposits(account.id, MARKER):
                    record_id = str(record.get("id") or record.get("_id"))
                    bank.delete_deposit(record_id)
                    deleted.append(record_id)
        except BankError as exc:
            raise PayoutError(f"The bank did not answer, so the demo deposit may still be there. ({exc})", 502) from exc
        return {
            "deleted": deleted,
            "dry_run": bank.mode == "dry_run",
            "message": "Removed the demo deposit." if deleted else "There was no demo deposit to remove.",
        }
