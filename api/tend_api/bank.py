from __future__ import annotations

import dataclasses
import datetime as dt
import threading
import uuid
from typing import Any, Protocol

from .money import dollars_match_cents


class BankError(Exception):
    def __init__(self, message: str, maybe_applied: bool = False):
        super().__init__(message)
        # True when the write may have landed even though no answer came back.
        self.maybe_applied = maybe_applied


class Bank(Protocol):
    mode: str
    whole_dollars: bool

    def withdraw(self, account_id: str, amount_cents: int, description: str, on_date: dt.date) -> str: ...
    def read_withdrawal(self, withdrawal_id: str) -> dict[str, Any]: ...
    def find_withdrawal(self, account_id: str, marker: str) -> str | None: ...
    # Every withdrawal on the account whose description carries the marker. Raises BankError when the bank
    # cannot be read, because a payment that cannot check for an earlier one must not go ahead.
    def tagged_withdrawals(self, account_id: str, marker: str) -> list[dict[str, Any]]: ...
    def read_bill(self, bill_id: str) -> dict[str, Any] | None: ...
    def update_bill(
        self, bill_id: str, *, amount_cents: int, status: str, nickname: str, payment_date: dt.date | None = None
    ) -> dict[str, Any]: ...
    def deposit(self, account_id: str, amount_cents: int, description: str, on_date: dt.date) -> str: ...
    def tagged_deposits(self, account_id: str, marker: str) -> list[dict[str, Any]]: ...
    def read_deposit(self, deposit_id: str) -> dict[str, Any]: ...
    def delete_deposit(self, deposit_id: str) -> None: ...


class DryRunBank:
    """Records withdrawals, deposits, and bill changes in memory and reads them back the same way the Nessie path does."""

    mode = "dry_run"
    whole_dollars = False

    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}
        self._deposits: dict[str, dict[str, Any]] = {}
        self._bills: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def withdraw(self, account_id: str, amount_cents: int, description: str, on_date: dt.date) -> str:
        withdrawal_id = f"dryrun-{uuid.uuid4().hex}"
        with self._lock:
            self._records[withdrawal_id] = {
                "id": withdrawal_id,
                "kind": "withdrawal",
                "account_id": account_id,
                "date": on_date.isoformat(),
                "status": "completed",
                "amount_cents": amount_cents,
                "description": description,
            }
        return withdrawal_id

    def read_withdrawal(self, withdrawal_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(withdrawal_id)
        if record is None:
            raise BankError(f"withdrawal {withdrawal_id} not found")
        return dict(record)

    def find_withdrawal(self, account_id: str, marker: str) -> str | None:
        with self._lock:
            return next((r["id"] for r in self._records.values() if r["account_id"] == account_id and marker in r["description"]), None)

    def tagged_withdrawals(self, account_id: str, marker: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._records.values() if r["account_id"] == account_id and marker in r["description"]]

    def read_bill(self, bill_id: str) -> dict[str, Any] | None:
        with self._lock:
            bill = self._bills.get(bill_id)
        return dict(bill) if bill else None

    def update_bill(
        self, bill_id: str, *, amount_cents: int, status: str, nickname: str, payment_date: dt.date | None = None
    ) -> dict[str, Any]:
        with self._lock:
            bill = self._bills.setdefault(bill_id, {"id": bill_id})
            bill.update({"amount_cents": amount_cents, "status": status, "nickname": nickname})
            if payment_date is not None:
                bill["payment_date"] = payment_date.isoformat()
            return dict(bill)

    def deposit(self, account_id: str, amount_cents: int, description: str, on_date: dt.date) -> str:
        deposit_id = f"dryrun-d-{uuid.uuid4().hex}"
        with self._lock:
            self._deposits[deposit_id] = {
                "id": deposit_id,
                "kind": "deposit",
                "account_id": account_id,
                "date": on_date.isoformat(),
                "status": "completed",
                "amount_cents": amount_cents,
                "description": description,
            }
        return deposit_id

    def tagged_deposits(self, account_id: str, marker: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._deposits.values() if r["account_id"] == account_id and marker in r["description"]]

    def read_deposit(self, deposit_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._deposits.get(deposit_id)
        if record is None:
            raise BankError(f"deposit {deposit_id} not found")
        return dict(record)

    def delete_deposit(self, deposit_id: str) -> None:
        with self._lock:
            self._deposits.pop(deposit_id, None)

    def records(self, account_ids: set[str]) -> list[dict[str, Any]]:
        """What a dry run wrote for these accounts, for the bank activity panel. Never sent to Nessie."""
        with self._lock:
            rows = [dict(r) for r in (*self._records.values(), *self._deposits.values()) if r["account_id"] in account_ids]
            bills = [dict(b) for b in self._bills.values()]
        return sorted(rows, key=lambda r: (r["date"], r["id"])) + [{**b, "kind": "bill"} for b in bills]


class NessieBank:
    """Live writes through tend_api.nessie.NessieClient.

    Uses create_withdrawal(account_id, *, amount_cents, date, description), get_txn("withdrawal", id),
    and find_txns(account_id, "withdrawal", marker). Older clients with get_withdrawal(id) also work.
    Bill payments also use get_bill and update_bill; the demo payout uses create_deposit and delete_txn.
    """

    mode = "nessie"
    whole_dollars = True  # Nessie stores whole dollars

    def __init__(self, client: Any | None = None):
        self._client = client

    def client(self) -> Any:
        if self._client is None:
            try:
                from tend_api.nessie import NessieClient
            except ImportError as exc:
                raise BankError(f"Nessie client is not installed: {exc}") from exc
            try:
                self._client = NessieClient.from_env() if hasattr(NessieClient, "from_env") else NessieClient()
            except Exception as exc:
                raise BankError(f"Nessie client could not start: {exc}") from exc
        return self._client

    def calls(self) -> list[Any]:
        return list(getattr(self._client, "calls", None) or [])

    def withdraw(self, account_id: str, amount_cents: int, description: str, on_date: dt.date) -> str:
        client = self.client()
        try:
            created = client.create_withdrawal(account_id, amount_cents=amount_cents, date=on_date, description=description)
        except Exception as exc:
            raise BankError(f"Nessie withdrawal failed: {exc}", maybe_applied=_maybe_applied(exc)) from exc
        withdrawal_id = as_record(created).get("id") or as_record(created).get("_id")
        if not withdrawal_id:
            raise BankError("Nessie did not return a withdrawal id", maybe_applied=True)
        return str(withdrawal_id)

    def read_withdrawal(self, withdrawal_id: str) -> dict[str, Any]:
        client = self.client()
        try:
            # No account id here: the account check must come from Nessie's own record, not an echo.
            raw = client.get_txn("withdrawal", withdrawal_id) if hasattr(client, "get_txn") else client.get_withdrawal(withdrawal_id)
        except Exception as exc:
            raise BankError(f"Nessie read-back failed: {exc}") from exc
        return as_record(raw)

    def find_withdrawal(self, account_id: str, marker: str) -> str | None:
        client = self.client()
        if not hasattr(client, "find_txns"):
            return None
        try:
            found = client.find_txns(account_id, "withdrawal", marker)
        except Exception:
            return None
        return str(as_record(found[0]).get("id")) if len(found) == 1 else None

    def _tagged(self, account_id: str, kind: str, marker: str) -> list[dict[str, Any]]:
        client = self.client()
        try:
            found = client.find_txns(account_id, kind, marker)
        except Exception as exc:
            raise BankError(f"Nessie could not list the {kind}s: {exc}") from exc
        return [r for r in map(as_record, found) if r.get("status") != "cancelled"]

    def tagged_withdrawals(self, account_id: str, marker: str) -> list[dict[str, Any]]:
        return self._tagged(account_id, "withdrawal", marker)

    def read_bill(self, bill_id: str) -> dict[str, Any] | None:
        client = self.client()
        try:
            bill = client.get_bill(bill_id)
        except Exception as exc:
            if type(exc).__name__ == "NessieNotFound":
                return None
            raise BankError(f"Nessie could not read the bill: {exc}") from exc
        return as_record(bill)

    def update_bill(
        self, bill_id: str, *, amount_cents: int, status: str, nickname: str, payment_date: dt.date | None = None
    ) -> dict[str, Any]:
        client = self.client()
        try:
            bill = client.update_bill(bill_id, status=status, amount_cents=amount_cents, nickname=nickname, payment_date=payment_date)
        except Exception as exc:
            raise BankError(f"Nessie did not take the bill update: {exc}", maybe_applied=_maybe_applied(exc)) from exc
        return as_record(bill)

    def deposit(self, account_id: str, amount_cents: int, description: str, on_date: dt.date) -> str:
        client = self.client()
        try:
            created = client.create_deposit(account_id, amount_cents=amount_cents, date=on_date, description=description)
        except Exception as exc:
            raise BankError(f"Nessie deposit failed: {exc}", maybe_applied=_maybe_applied(exc)) from exc
        deposit_id = as_record(created).get("id") or as_record(created).get("_id")
        if not deposit_id:
            raise BankError("Nessie did not return a deposit id", maybe_applied=True)
        return str(deposit_id)

    def tagged_deposits(self, account_id: str, marker: str) -> list[dict[str, Any]]:
        return self._tagged(account_id, "deposit", marker)

    def read_deposit(self, deposit_id: str) -> dict[str, Any]:
        client = self.client()
        try:
            return as_record(client.get_txn("deposit", deposit_id))
        except Exception as exc:
            raise BankError(f"Nessie read-back failed: {exc}") from exc

    def delete_deposit(self, deposit_id: str) -> None:
        client = self.client()
        try:
            client.delete_txn("deposit", deposit_id)
        except Exception as exc:
            raise BankError(f"Nessie did not delete the deposit: {exc}") from exc


def _maybe_applied(exc: BaseException) -> bool:
    if hasattr(exc, "maybe_applied"):
        return bool(exc.maybe_applied)
    status = getattr(exc, "status", None)
    if isinstance(status, int) and 400 <= status < 500:
        return False  # Nessie refused the request
    return not isinstance(exc, (ValueError, TypeError))  # those are raised before anything is sent


def as_record(result: Any) -> dict[str, Any]:
    if dataclasses.is_dataclass(result) and not isinstance(result, type):
        return dataclasses.asdict(result)
    if not isinstance(result, dict):
        raise BankError(f"unexpected Nessie response: {type(result).__name__}")
    inner = result.get("objectCreated")
    return inner if isinstance(inner, dict) else result


def check_readback(record: dict[str, Any], *, withdrawal_id: str, account_id: str, amount_cents: int, action_id: str) -> dict[str, Any]:
    """Compare what the bank now holds with what was confirmed. None means the bank did not report that field."""
    record = as_record(record)
    checks: dict[str, bool | None] = {
        "id": str(record.get("id") or record.get("_id") or "") == withdrawal_id,
        "tagged_with_action": action_id in str(record.get("description") or ""),
    }
    payer = record.get("payer_id") or record.get("account_id")
    checks["account"] = None if not payer else str(payer) == account_id
    checks["amount"] = _amount_matches(record, amount_cents)
    return {
        "ok": all(v is not False for v in checks.values()) and checks["amount"] is True,
        "checks": checks,
        "status": record.get("status"),
        "description": record.get("description"),
    }


def record_cents(record: dict[str, Any]) -> int | None:
    """A record's amount in cents, whether it is Tend's shape (amount_cents) or Nessie's (dollars)."""
    value = record.get("amount_cents")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    raw = record.get("amount")
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw * 100
    return None


def _amount_matches(record: dict[str, Any], amount_cents: int) -> bool | None:
    if "amount_cents" in record:
        value = record["amount_cents"]
        return isinstance(value, int) and not isinstance(value, bool) and value == amount_cents
    if "amount" not in record:
        return None
    # A raw Nessie record holds a bare number in dollars; compare it exactly.
    return dollars_match_cents(record["amount"], amount_cents)
