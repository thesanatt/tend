from __future__ import annotations

import threading
import uuid
from typing import Any, Protocol

from .money import matches_cents


class BankError(Exception):
    pass


class Bank(Protocol):
    mode: str

    def withdraw(self, account_id: str, amount_cents: int, description: str) -> str: ...
    def read_withdrawal(self, withdrawal_id: str) -> dict[str, Any]: ...


class DryRunBank:
    """Records withdrawals in memory and reads them back the same way the Nessie path does."""

    mode = "dry_run"

    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def withdraw(self, account_id: str, amount_cents: int, description: str) -> str:
        withdrawal_id = f"dryrun-{uuid.uuid4().hex}"
        with self._lock:
            self._records[withdrawal_id] = {
                "_id": withdrawal_id, "type": "withdrawal", "payer_id": account_id, "medium": "balance",
                "status": "completed", "amount_cents": amount_cents, "description": description,
            }
        return withdrawal_id

    def read_withdrawal(self, withdrawal_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(withdrawal_id)
        if record is None:
            raise BankError(f"withdrawal {withdrawal_id} not found")
        return dict(record)


class NessieBank:
    """Live writes through tend_api.nessie.NessieClient.

    Expects create_withdrawal(account_id, amount_cents=..., description=...) returning the created
    withdrawal (or Nessie's {"objectCreated": {...}} envelope) and get_withdrawal(withdrawal_id).
    """

    mode = "nessie"

    def __init__(self, client: Any | None = None):
        self._client = client

    def client(self) -> Any:
        if self._client is None:
            try:
                from tend_api.nessie import NessieClient
            except ImportError as exc:
                raise BankError(f"Nessie client is not installed: {exc}") from exc
            self._client = NessieClient()
        return self._client

    def withdraw(self, account_id: str, amount_cents: int, description: str) -> str:
        try:
            created = self.client().create_withdrawal(account_id, amount_cents=amount_cents, description=description)
        except BankError:
            raise
        except Exception as exc:
            raise BankError(f"Nessie withdrawal failed: {exc}") from exc
        record = unwrap(created)
        withdrawal_id = record.get("_id") or record.get("id")
        if not withdrawal_id:
            raise BankError("Nessie did not return a withdrawal id")
        return str(withdrawal_id)

    def read_withdrawal(self, withdrawal_id: str) -> dict[str, Any]:
        try:
            return unwrap(self.client().get_withdrawal(withdrawal_id))
        except Exception as exc:
            raise BankError(f"Nessie read-back failed: {exc}") from exc


def unwrap(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise BankError(f"unexpected Nessie response: {type(result).__name__}")
    inner = result.get("objectCreated")
    return inner if isinstance(inner, dict) else result


def check_readback(record: dict[str, Any], *, withdrawal_id: str, account_id: str, amount_cents: int, action_id: str) -> dict[str, Any]:
    """Compare what the bank now holds with what was confirmed. None means the bank did not report that field."""
    record = unwrap(record)
    checks: dict[str, bool | None] = {
        "id": str(record.get("_id") or record.get("id") or "") == withdrawal_id,
        "tagged_with_action": action_id in str(record.get("description") or ""),
    }
    payer = record.get("payer_id", record.get("account_id"))
    checks["account"] = None if payer is None else str(payer) == account_id
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
    # Nessie stores a bare number; accept it as cents or as dollars, compared exactly.
    return matches_cents(record["amount"], amount_cents)
