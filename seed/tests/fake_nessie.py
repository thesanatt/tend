"""In-memory stand-in for the 2026 Nessie API, copying the behavior recorded in seed/NESSIE_NOTES.md.

It reproduces the quirks the client is built around: the objectCreated wrapper, singular and
plural single-object paths, 404 for an empty transfer list, transfers keyed "id", truncated
amounts, transfers that refuse medium and payee_id, list reads that break on incomplete records,
balances that never move, deletes that answer 200 for anything, and 403 for unknown routes.
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from datetime import date

import httpx

COLLECTIONS = {"purchases": "purchase", "deposits": "deposit", "withdrawals": "withdrawal",
               "transfers": "transfer", "bills": "bill"}
SINGLE = {"purchase": "purchase", "deposits": "deposit", "withdrawal": "withdrawal",
          "transfers": "transfer", "bills": "bill"}
CREATED = {"purchase": "Purchase created", "deposit": "Deposit created", "withdrawal": "Withdrawal created",
           "transfer": "Transfer created", "bill": "Bill created"}
DELETED = {"purchase": "Purchase deleted", "withdrawal": "Withdrawal deleted", "bill": "Bill deleted"}
ALLOWED = {
    "purchase": {"merchant_id", "medium", "purchase_date", "amount", "status", "description"},
    "deposit": {"medium", "transaction_date", "status", "amount", "description"},
    "withdrawal": {"medium", "transaction_date", "status", "amount", "description"},
    "transfer": {"transaction_date", "status", "amount", "description"},
    "bill": {"status", "payee", "nickname", "payment_date", "recurring_date", "payment_amount"},
}
REQUIRED = {"purchase": ("merchant_id",), "deposit": ("medium", "transaction_date", "status", "amount", "description"),
            "withdrawal": ("medium", "transaction_date", "status", "amount", "description"),
            "transfer": ("transaction_date", "status", "amount", "description"),
            "bill": ("status", "payee", "payment_amount")}
# Fields a stored record must have or its list read fails (the "poisoned list" quirk).
READ_REQUIRED = {"purchase": ("purchase_date", "status"),
                 "bill": ("payment_date", "recurring_date", "upcoming_payment_date")}
UPDATABLE = {"purchase": {"description", "amount", "purchase_date", "medium", "payer_id"},
             "bill": {"status", "payee", "nickname", "payment_date", "recurring_date", "payment_amount"},
             "deposit": {"medium", "transaction_date", "status", "amount", "description"},
             "withdrawal": {"medium", "transaction_date", "status", "amount", "description"},
             "transfer": {"transaction_date", "status", "amount", "description"}}
NO_ROUTE = {"message": "Missing Authentication Token"}


class FakeNessie:
    def __init__(self, key: str = "test-key", bare_string_creates: bool = False, today: str = "2026-10-03"):
        self.key = key
        self.bare_string_creates = bare_string_creates
        self.today = today
        self.customers: dict[str, dict] = {}
        self.accounts: dict[str, dict] = {}
        self.merchants: dict[str, dict] = {}
        self.records: dict[str, dict[str, tuple[str, dict]]] = {k: {} for k in CREATED}
        self.requests: list[tuple[str, str, dict | None]] = []
        self.fail_next: list[int] = []
        self._ids = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def new_id(self) -> str:
        self._ids += 1
        return str(uuid.UUID(int=self._ids))

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        path = request.url.path
        self.requests.append((request.method, path, body))
        if self.fail_next:
            return httpx.Response(self.fail_next.pop(0), json={"message": "Internal server error"})
        key = request.url.params.get("key")
        if not key:
            return httpx.Response(502, json={"message": "Internal server error"})
        if key != self.key:
            # A wrong key is not rejected; it simply sees nothing of ours.
            return httpx.Response(200, json=[]) if request.method == "GET" else httpx.Response(201, json="ok")
        try:
            return self.route(request.method, path.strip("/").split("/"), body)
        except _Fail as fail:
            return httpx.Response(fail.status, json=fail.body)

    def route(self, method: str, parts: list[str], body: dict | None) -> httpx.Response:
        head = parts[0]
        if head == "customers":
            return self.customers_route(method, parts, body)
        if head == "accounts":
            return self.accounts_route(method, parts, body)
        if head == "merchants":
            return self.merchants_route(method, parts, body)
        if head in SINGLE and len(parts) == 2:
            return self.single_route(SINGLE[head], method, parts[1], body)
        raise _Fail(403, NO_ROUTE)

    def customers_route(self, method, parts, body):
        if len(parts) == 1 and method == "GET":
            return _ok(list(self.customers.values()))
        if len(parts) == 1 and method == "POST":
            obj = {**body, "_id": self.new_id()}
            self.customers[obj["_id"]] = obj
            return self.created("Customer created", obj)
        cid = parts[1]
        if len(parts) == 2 and method == "GET":
            if cid not in self.customers:
                raise _Fail(404, "Customer not found")
            return _ok(self.customers[cid])
        if len(parts) == 3 and parts[2] == "accounts" and method == "GET":
            return _ok([a for a in self.accounts.values() if a["customer_id"] == cid])
        if len(parts) == 3 and parts[2] == "accounts" and method == "POST":
            obj = {**body, "_id": self.new_id(), "account_number": f"{self._ids:016d}", "customer_id": cid}
            obj["balance"] = int(obj.get("balance", 0))
            self.accounts[obj["_id"]] = obj
            return self.created("Account created", obj)
        if len(parts) == 3 and parts[2] == "bills" and method == "GET":
            mine = {a for a, acct in self.accounts.items() if acct["customer_id"] == cid}
            return _ok(self.read_list("bill", [r for acct, r in self.records["bill"].values() if acct in mine]))
        raise _Fail(403, NO_ROUTE)  # includes DELETE /customers/{id}

    def accounts_route(self, method, parts, body):
        if len(parts) == 1 and method == "GET":
            return _ok(list(self.accounts.values()))
        aid = parts[1]
        if len(parts) == 2:
            if method == "GET":
                if aid not in self.accounts:
                    raise _Fail(404, "")
                return _ok(self.accounts[aid])
            if method == "DELETE":
                self.accounts.pop(aid, None)  # children stay behind
                return _ok("")
        if len(parts) == 3 and parts[2] in COLLECTIONS:
            kind = COLLECTIONS[parts[2]]
            if method == "GET":
                rows = [r for acct, r in self.records[kind].values() if acct == aid]
                if kind == "transfer" and not rows:
                    raise _Fail(404, "No transfers found for this account")
                return _ok(self.read_list(kind, rows))
            if method == "POST":
                return self.create(kind, aid, body)
        raise _Fail(403, NO_ROUTE)

    def merchants_route(self, method, parts, body):
        if len(parts) == 1 and method == "GET":
            return _ok(list(self.merchants.values()))
        if len(parts) == 1 and method == "POST":
            obj = {**body, "_id": self.new_id()}
            self.merchants[obj["_id"]] = obj
            return self.created("Merchant created", obj)
        if len(parts) == 2 and method == "GET":
            if parts[1] not in self.merchants:
                raise _Fail(404, "Merchant not found")
            return _ok(self.merchants[parts[1]])
        if len(parts) == 2 and method == "PUT":
            obj = self.merchants[parts[1]]
            obj.update(body)
            return httpx.Response(202, json={"code": 202, "message": "Accepted merchant update", "objectUpdated": obj})
        raise _Fail(403, NO_ROUTE)

    def create(self, kind: str, account_id: str, body: dict) -> httpx.Response:
        extra = set(body) - ALLOWED[kind]
        if extra:
            lines = "".join(f"\n{f}\n  extra fields not permitted (type=value_error.extra)" for f in sorted(extra))
            plural = "s" if len(extra) > 1 else ""
            raise _Fail(400, f"{len(extra)} validation error{plural} for {kind.title()}Create{lines}")
        missing = [f for f in REQUIRED[kind] if f not in body]
        if missing:
            raise _Fail(400, f"1 validation error for {kind.title()}Create\n{missing[0]}\n  field required")
        obj = dict(body)
        if kind == "bill":
            obj["payment_amount"] = float(obj["payment_amount"])
            obj["creation_date"] = self.today
            obj["account_id"] = account_id
            if "recurring_date" in obj:
                obj["upcoming_payment_date"] = _next_day_of_month(self.today, obj["recurring_date"])
        else:
            if not isinstance(obj["amount"], (int, float)):
                raise _Fail(400, f"1 validation error for {kind.title()}Create\namount\n  value is not a valid integer")
            obj["amount"] = int(obj["amount"])  # 11.20 becomes 11
            if kind in ("purchase", "withdrawal"):
                obj["payer_id"] = account_id
                obj["type"] = "merchant" if kind == "purchase" else "withdrawal"
            if kind in ("deposit", "withdrawal"):
                obj["creation_date"] = self.today
        obj["_id"] = self.new_id()
        self.records[kind][obj["_id"]] = (account_id, obj)
        return self.created(CREATED[kind], obj)

    def single_route(self, kind: str, method: str, oid: str, body: dict | None) -> httpx.Response:
        entry = self.records[kind].get(oid)
        if method == "DELETE":
            self.records[kind].pop(oid, None)  # 200 whether or not it existed
            return _ok(DELETED.get(kind, ""))
        if entry is None:
            raise _Fail(404, f"{kind.title()} with this id does not exist")
        if method == "GET":
            return _ok(self.read_one(kind, entry[1]))
        if method == "PUT":
            extra = set(body) - UPDATABLE[kind]
            if extra:
                field = sorted(extra)[0]
                raise _Fail(400, f"1 validation error for {kind.title()}Update\n{field}\n  extra fields not permitted")
            entry[1].update(body)
            return httpx.Response(202, json={"code": 202, "message": f"Accepted {kind} update",
                                             "objectUpdated": copy.deepcopy(entry[1])})
        raise _Fail(403, NO_ROUTE)

    def read_list(self, kind: str, rows: list[dict]) -> list[dict]:
        for row in rows:
            missing = [f for f in READ_REQUIRED.get(kind, ()) if f not in row]
            if missing:
                detail = "".join(f"\n{f}\n  field required (type=value_error.missing)" for f in missing)
                raise _Fail(400, f"{len(missing)} validation errors for {kind.title()}{detail}")
        return [self.read_one(kind, r) for r in rows]

    def read_one(self, kind: str, row: dict) -> dict:
        out = copy.deepcopy(row)
        if kind in ("deposit", "withdrawal"):
            out.pop("creation_date", None)  # only the create answer carries it
        if kind == "transfer":
            out["id"] = out.pop("_id")
        return out

    def created(self, message: str, obj: dict) -> httpx.Response:
        if self.bare_string_creates:
            return httpx.Response(201, json=message)
        return httpx.Response(201, json={"code": 201, "message": message, "objectCreated": copy.deepcopy(obj)})

    def count(self, method: str | None = None, pattern: str = "") -> int:
        return sum(1 for m, p, _ in self.requests if (method is None or m == method) and re.search(pattern, p))


class _Fail(Exception):
    def __init__(self, status: int, body):
        self.status, self.body = status, body


def _ok(data) -> httpx.Response:
    return httpx.Response(200, json=data)


def _next_day_of_month(today: str, day: int) -> str:
    t = date.fromisoformat(today)
    year, month = (t.year + (t.month == 12), t.month % 12 + 1) if t.day >= day else (t.year, t.month)
    return date(year, month, min(day, 28)).isoformat()
