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


class DryRunBank:
    """Records withdrawals in memory and reads them back the same way the Nessie path does."""

    mode = "dry_run"
    whole_dollars = False

    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}
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


class NessieBank:
    """Live writes through tend_api.nessie.NessieClient.

    Uses create_withdrawal(account_id, *, amount_cents, date, description), get_txn("withdrawal", id),
    and find_txns(account_id, "withdrawal", marker). Older clients with get_withdrawal(id) also work.
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


def _amount_matches(record: dict[str, Any], amount_cents: int) -> bool | None:
    if "amount_cents" in record:
        value = record["amount_cents"]
        return isinstance(value, int) and not isinstance(value, bool) and value == amount_cents
    if "amount" not in record:
        return None
    # A raw Nessie record holds a bare number in dollars; compare it exactly.
    return dollars_match_cents(record["amount"], amount_cents)
