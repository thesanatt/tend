"""Typed client for Capital One's Nessie mock bank (the 2026 rebuild at api.nessieisreal.com).

Built from a live spike on 2026-10-03; seed/NESSIE_NOTES.md records what the API really does
where it differs from its published spec. Tend works in integer cents. Nessie stores whole
dollars and silently truncates decimals, so writes refuse amounts that are not whole dollars.
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field, replace
from datetime import date as _date
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

import httpx

DEFAULT_BASE_URL = "https://api.nessieisreal.com"
DEFAULT_TIMEOUT_S = 10.0
SNAPSHOT_FORMAT = "tend-bank-snapshot/1"
SNAPSHOT_DIR = Path(os.environ.get("TEND_SNAPSHOT_DIR", Path(__file__).resolve().parents[2] / "seed" / "snapshots"))

TxnKind = Literal["purchase", "deposit", "withdrawal", "transfer"]
TXN_KINDS: tuple[TxnKind, ...] = ("purchase", "deposit", "withdrawal", "transfer")
TXN_STATUSES = frozenset({"pending", "completed", "cancelled"})
BILL_STATUSES = frozenset({"pending", "completed", "cancelled", "recurring"})

# Collection path under /accounts/{id}/ and the single-object path for each kind.
# The single paths really are this inconsistent; the other spelling answers 403.
_COLLECTION = {"purchase": "purchases", "deposit": "deposits", "withdrawal": "withdrawals",
               "transfer": "transfers", "bill": "bills"}
_SINGLE = {"purchase": "/purchase/{}", "deposit": "/deposits/{}", "withdrawal": "/withdrawal/{}",
           "transfer": "/transfers/{}", "bill": "/bills/{}"}
_DATE_FIELD = {"purchase": "purchase_date", "deposit": "transaction_date",
               "withdrawal": "transaction_date", "transfer": "transaction_date"}

_PAYEE_TAG = re.compile(r"\s*\[payee:([0-9A-Za-z-]+)\]")
_ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


class NessieError(RuntimeError):
    def __init__(self, method: str, path: str, status: int | None, body: Any, hint: str = ""):
        self.method, self.path, self.status, self.body = method, path, status, body
        detail = body if isinstance(body, str) else json.dumps(body)[:300]
        super().__init__(f"Nessie {method} {path} -> {status}: {detail}{' (' + hint + ')' if hint else ''}")


class NessieNotFound(NessieError):
    pass


class NessieRejected(NessieError):
    """400: Nessie's validator refused the request body."""


class NessieListCorrupt(NessieRejected):
    """A list read fails because one stored record is missing required fields.

    Nessie accepts such records on create and then cannot serialize the list. Only deleting the
    bad record by id repairs it. This client never writes incomplete records.
    """


class NessieUnavailable(NessieError):
    def __init__(self, method: str, path: str, status: int | None, body: Any, maybe_applied: bool = False):
        # maybe_applied: a write may have landed even though no answer came back; look it up
        # (for example with find_txns and the marker in its description) before trying again.
        self.maybe_applied = maybe_applied
        super().__init__(method, path, status, body)


@dataclass(frozen=True)
class Address:
    street_number: str
    street_name: str
    city: str
    state: str
    zip: str


@dataclass(frozen=True)
class Customer:
    id: str
    first_name: str
    last_name: str
    address: Address | None


@dataclass(frozen=True)
class Account:
    id: str
    customer_id: str
    type: str
    nickname: str
    opening_balance_cents: int  # Nessie's balance field: set at creation, never moves
    rewards: int = 0
    account_number: str = ""


@dataclass(frozen=True)
class Merchant:
    id: str
    name: str
    category: str = ""
    address: Address | None = None
    lat: float | None = None
    lng: float | None = None


@dataclass(frozen=True)
class Txn:
    id: str
    kind: TxnKind
    account_id: str
    date: str
    amount_cents: int
    status: str
    description: str
    medium: str | None = None
    merchant_id: str | None = None
    payee_account_id: str | None = None  # transfers only, parsed from "[payee:<id>]"

    @property
    def item_id(self) -> str:
        return f"nessie:{self.id}"

    @property
    def display_description(self) -> str:
        return _PAYEE_TAG.sub("", self.description).strip()


@dataclass(frozen=True)
class Bill:
    id: str
    account_id: str
    payee: str
    nickname: str
    status: str
    amount_cents: int
    payment_date: str | None = None
    recurring_date: int | None = None
    upcoming_payment_date: str | None = None
    creation_date: str | None = None

    @property
    def item_id(self) -> str:
        return f"nessie:{self.id}"


def cents_to_dollars(amount_cents: int) -> int:
    if isinstance(amount_cents, bool) or not isinstance(amount_cents, int):
        raise TypeError(f"amount_cents must be an int, got {type(amount_cents).__name__}")
    if amount_cents <= 0:
        raise ValueError(f"amount must be positive, got {amount_cents} cents")
    if amount_cents % 100:
        raise ValueError(f"Nessie stores whole dollars and would truncate {amount_cents} cents")
    return amount_cents // 100


def number_to_cents(value: Any) -> int:
    """Nessie money fields are JSON numbers in dollars; bills come back as floats like 443.0."""
    if isinstance(value, bool) or value is None:
        raise ValueError(f"not an amount: {value!r}")
    if isinstance(value, int):
        return value * 100
    cents = Decimal(str(value)) * 100
    if cents != cents.to_integral_value():
        raise ValueError(f"amount {value!r} has fractions of a cent")
    return int(cents)


def _bill_amount(amount_cents: int) -> int | float:
    if isinstance(amount_cents, bool) or not isinstance(amount_cents, int) or amount_cents <= 0:
        raise ValueError(f"bill amount must be a positive int of cents, got {amount_cents!r}")
    # Bills keep decimals (payment_amount is a float field); everything else truncates.
    return amount_cents // 100 if amount_cents % 100 == 0 else float(Decimal(amount_cents) / 100)


def _iso(day: str | _date) -> str:
    # Nessie stores "not-a-date" without complaint, and fromisoformat alone also takes forms
    # like "2026-W24-7", so the exact shape is checked first.
    text = day.isoformat() if isinstance(day, _date) else str(day)
    if not _ISO_DAY.fullmatch(text):
        raise ValueError(f"expected YYYY-MM-DD, got {text!r}")
    _date.fromisoformat(text)
    return text


def _status(status: str, allowed: frozenset[str] = TXN_STATUSES) -> str:
    if status not in allowed:
        raise ValueError(f"status must be one of {sorted(allowed)}, got {status!r}")
    return status


def _oid(obj: dict) -> str:
    # Transfers come back keyed "id"; every other object uses "_id".
    oid = obj.get("_id") or obj.get("id")
    if not oid:
        raise ValueError(f"Nessie object without an id: {obj!r}")
    return str(oid)


def _unwrap(data: Any) -> dict | None:
    """Creates answer {code, message, objectCreated}; updates answer {..., objectUpdated}.

    The published spec says a bare string ("Withdrawal created"), and some objects come back
    bare. Returns the object when there is one, None when Nessie sent only a message.
    """
    if isinstance(data, dict):
        for key in ("objectCreated", "objectUpdated"):
            if isinstance(data.get(key), dict):
                return data[key]
        if "_id" in data or "id" in data:
            return data
    return None


def _address(raw: Any) -> Address | None:
    if not isinstance(raw, dict):
        return None
    return Address(**{k: str(raw.get(k, "")) for k in ("street_number", "street_name", "city", "state", "zip")})


def parse_customer(obj: dict) -> Customer:
    return Customer(_oid(obj), obj.get("first_name", ""), obj.get("last_name", ""), _address(obj.get("address")))


def parse_account(obj: dict) -> Account:
    return Account(
        id=_oid(obj),
        customer_id=str(obj.get("customer_id", "")),
        type=obj.get("type", ""),
        nickname=obj.get("nickname", ""),
        opening_balance_cents=number_to_cents(obj.get("balance", 0)),
        rewards=int(obj.get("rewards", 0) or 0),
        account_number=str(obj.get("account_number", "")),
    )


def parse_merchant(obj: dict) -> Merchant:
    geo = obj.get("geocode") if isinstance(obj.get("geocode"), dict) else {}
    return Merchant(_oid(obj), obj.get("name", ""), obj.get("category", "") or "", _address(obj.get("address")),
                    geo.get("lat"), geo.get("lng"))


def parse_txn(kind: TxnKind, obj: dict, account_id: str | None = None) -> Txn:
    description = obj.get("description", "") or ""
    payee = _PAYEE_TAG.search(description) if kind == "transfer" else None
    return Txn(
        id=_oid(obj),
        kind=kind,
        # Deposits and transfers carry no account field, so the caller passes the one it listed.
        account_id=account_id or str(obj.get("payer_id", "")),
        date=str(obj.get(_DATE_FIELD[kind], "")),
        amount_cents=number_to_cents(obj.get("amount", 0)),
        status=obj.get("status", ""),
        description=description,
        medium=obj.get("medium"),
        merchant_id=obj.get("merchant_id"),
        payee_account_id=payee.group(1) if payee else None,
    )


def parse_bill(obj: dict, account_id: str | None = None) -> Bill:
    return Bill(
        id=_oid(obj),
        account_id=account_id or str(obj.get("account_id", "")),
        payee=obj.get("payee", ""),
        nickname=obj.get("nickname", "") or "",
        status=obj.get("status", ""),
        amount_cents=number_to_cents(obj.get("payment_amount", 0)),
        payment_date=obj.get("payment_date"),
        recurring_date=obj.get("recurring_date"),
        upcoming_payment_date=obj.get("upcoming_payment_date"),
        creation_date=obj.get("creation_date"),
    )


def computed_balance_cents(account: Account, txns: Iterable[Txn], as_of: str | None = None) -> int:
    """Nessie never moves account.balance, so the balance is opening + records.

    Bills are obligations, not ledger entries: paying one shows up as the withdrawal that paid it.
    Transfers are stored only on the sending account; the payee tag credits the other side.
    """
    total = account.opening_balance_cents
    for t in txns:
        if t.status == "cancelled" or (as_of and t.date > as_of):
            continue
        if t.account_id == account.id:
            total += t.amount_cents if t.kind == "deposit" else -t.amount_cents
        elif t.kind == "transfer" and t.payee_account_id == account.id:
            total += t.amount_cents
    return total


class NessieClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = DEFAULT_TIMEOUT_S,
                 transport: httpx.BaseTransport | None = None):
        if not api_key:
            raise ValueError("NESSIE_API_KEY is empty; a wrong key does not fail, it reads an empty bank")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(timeout=timeout, transport=transport)

    @classmethod
    def from_env(cls, **kwargs: Any) -> NessieClient:
        base_url = os.environ.get("NESSIE_BASE_URL") or DEFAULT_BASE_URL
        return cls(os.environ.get("NESSIE_API_KEY", ""), base_url, **kwargs)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> NessieClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, body: dict | None = None, *, missing_is_empty: bool = False) -> Any:
        # GETs get one retry on 5xx or a transport error. Writes are never retried: Nessie has
        # no idempotency keys, so a blind retry can move money twice.
        attempts = 2 if method == "GET" else 1
        resp = None
        for attempt in range(attempts):
            try:
                resp = self._http.request(method, self.base_url + path, params={"key": self.api_key}, json=body)
            except httpx.TransportError as exc:
                if attempt + 1 < attempts:
                    continue
                sent = not isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))
                raise NessieUnavailable(method, path, None, f"{type(exc).__name__}: {exc}",
                                        maybe_applied=method != "GET" and sent) from exc
            if resp.status_code >= 500 and attempt + 1 < attempts:
                continue
            break
        assert resp is not None
        try:
            data = resp.json()
        except ValueError:
            data = resp.text
        status = resp.status_code
        if status < 400:
            return data
        if status == 404 and missing_is_empty:
            return []
        if status == 404:
            raise NessieNotFound(method, path, status, data)
        if status == 400:
            if method == "GET" and isinstance(data, str) and "validation error" in data:
                raise NessieListCorrupt(method, path, status, data, "a stored record is missing required fields")
            raise NessieRejected(method, path, status, data)
        if status == 403 and isinstance(data, dict) and data.get("message") == "Missing Authentication Token":
            raise NessieError(method, path, status, data, "no such route; check singular vs plural path")
        if status >= 500:
            raise NessieUnavailable(method, path, status, data, maybe_applied=method != "GET")
        raise NessieError(method, path, status, data)

    def _list(self, path: str) -> list[dict]:
        data = self._request("GET", path, missing_is_empty=True)
        if not isinstance(data, list):
            raise NessieError("GET", path, 200, data, "expected a list")
        return data

    def _create(self, path: str, body: dict, find: Callable[[], list[dict]], match: Callable[[dict], bool]) -> dict:
        obj = _unwrap(self._request("POST", path, body))
        if obj is not None:
            return obj
        # Message-only answer: recover the id by listing and matching what was sent.
        hits = [o for o in find() if match(o)]
        if len(hits) != 1:
            raise NessieError("POST", path, 201, body, f"created, but {len(hits)} records match; id unknown")
        return hits[0]

    # customers and accounts

    def list_customers(self) -> list[Customer]:
        return [parse_customer(o) for o in self._list("/customers")]

    def get_customer(self, customer_id: str) -> Customer:
        return parse_customer(self._request("GET", f"/customers/{customer_id}"))

    def create_customer(self, first_name: str, last_name: str, address: Address) -> Customer:
        body = {"first_name": first_name, "last_name": last_name, "address": asdict(address)}
        obj = self._create("/customers", body, lambda: self._list("/customers"),
                           lambda o: o.get("first_name") == first_name and o.get("last_name") == last_name
                           and _address(o.get("address")) == address)
        return parse_customer(obj)

    def find_customer(self, first_name: str, last_name: str, address: Address) -> Customer | None:
        # Customers cannot be deleted (no DELETE route), so seeding reuses them.
        for c in self.list_customers():
            if (c.first_name, c.last_name, c.address) == (first_name, last_name, address):
                return c
        return None

    def list_accounts(self, customer_id: str) -> list[Account]:
        return [parse_account(o) for o in self._list(f"/customers/{customer_id}/accounts")]

    def get_account(self, account_id: str) -> Account:
        return parse_account(self._request("GET", f"/accounts/{account_id}"))

    def create_account(self, customer_id: str, type: str, nickname: str, opening_balance_cents: int = 0,
                       rewards: int = 0) -> Account:
        if type not in ("Checking", "Savings", "Credit Card"):
            raise ValueError(f"unknown account type {type!r}")
        balance = 0 if opening_balance_cents == 0 else cents_to_dollars(opening_balance_cents)
        body = {"type": type, "nickname": nickname, "rewards": rewards, "balance": balance}
        obj = self._create(f"/customers/{customer_id}/accounts", body,
                           lambda: self._list(f"/customers/{customer_id}/accounts"),
                           lambda o: o.get("nickname") == nickname and o.get("type") == type)
        return parse_account(obj)

    def delete_account(self, account_id: str) -> None:
        # Does not cascade: purchases, deposits and the rest stay readable under the dead id.
        self._request("DELETE", f"/accounts/{account_id}")

    # merchants (no DELETE route; they live as long as the key)

    def list_merchants(self) -> list[Merchant]:
        return [parse_merchant(o) for o in self._list("/merchants")]

    def get_merchant(self, merchant_id: str) -> Merchant:
        return parse_merchant(self._request("GET", f"/merchants/{merchant_id}"))

    def create_merchant(self, name: str, category: str, address: Address | None = None,
                        lat: float | None = None, lng: float | None = None) -> Merchant:
        body: dict[str, Any] = {"name": name, "category": category}
        if address is not None:
            body["address"] = asdict(address)
        if lat is not None and lng is not None:
            body["geocode"] = {"lat": lat, "lng": lng}
        obj = self._create("/merchants", body, lambda: self._list("/merchants"),
                           lambda o: o.get("name") == name and _address(o.get("address")) == address)
        return parse_merchant(obj)

    def update_merchant(self, merchant_id: str, **fields: Any) -> Merchant:
        obj = _unwrap(self._request("PUT", f"/merchants/{merchant_id}", fields))
        return parse_merchant(obj) if obj else self.get_merchant(merchant_id)

    # purchases, deposits, withdrawals, transfers

    def list_txns(self, account_id: str, kind: TxnKind) -> list[Txn]:
        rows = self._list(f"/accounts/{account_id}/{_COLLECTION[kind]}")
        return [parse_txn(kind, o, account_id) for o in rows]

    def account_txns(self, account_id: str) -> list[Txn]:
        txns = [t for kind in TXN_KINDS for t in self.list_txns(account_id, kind)]
        return sorted(txns, key=lambda t: (t.date, t.kind, t.id))

    def get_txn(self, kind: TxnKind, txn_id: str, account_id: str | None = None) -> Txn:
        return parse_txn(kind, self._request("GET", _SINGLE[kind].format(txn_id)), account_id)

    def find_txns(self, account_id: str, kind: TxnKind, marker: str) -> list[Txn]:
        return [t for t in self.list_txns(account_id, kind) if marker in t.description]

    def delete_txn(self, kind: TxnKind, txn_id: str) -> None:
        # Answers 200 whether or not the id exists.
        self._request("DELETE", _SINGLE[kind].format(txn_id))

    def _create_txn(self, kind: TxnKind, account_id: str, body: dict) -> Txn:
        path = f"/accounts/{account_id}/{_COLLECTION[kind]}"
        date_field = _DATE_FIELD[kind]
        obj = self._create(path, body, lambda: self._list(path),
                           lambda o: all(o.get(k) == body[k] for k in (date_field, "amount", "description")))
        return parse_txn(kind, obj, account_id)

    def create_purchase(self, account_id: str, *, merchant_id: str, amount_cents: int, date: str | _date,
                        description: str, status: str = "completed", medium: str = "balance") -> Txn:
        # purchase_date and status look optional, but a purchase stored without them makes
        # GET /accounts/{id}/purchases fail for the whole account until it is deleted.
        if not merchant_id:
            raise ValueError("purchases need a merchant_id")
        return self._create_txn("purchase", account_id, {
            "merchant_id": merchant_id, "medium": medium, "purchase_date": _iso(date),
            "amount": cents_to_dollars(amount_cents), "status": _status(status), "description": description,
        })

    def create_deposit(self, account_id: str, *, amount_cents: int, date: str | _date, description: str,
                       status: str = "completed", medium: str = "balance") -> Txn:
        return self._create_txn("deposit", account_id, {
            "medium": medium, "transaction_date": _iso(date), "status": _status(status),
            "amount": cents_to_dollars(amount_cents), "description": description,
        })

    def create_withdrawal(self, account_id: str, *, amount_cents: int, date: str | _date, description: str,
                          status: str = "completed", medium: str = "balance") -> Txn:
        return self._create_txn("withdrawal", account_id, {
            "medium": medium, "transaction_date": _iso(date), "status": _status(status),
            "amount": cents_to_dollars(amount_cents), "description": description,
        })

    def create_transfer(self, account_id: str, *, payee_account_id: str | None, amount_cents: int,
                        date: str | _date, description: str, status: str = "completed") -> Txn:
        # TransferCreate rejects medium and payee_id ("extra fields not permitted"), so the
        # destination rides in the description, where parse_txn reads it back.
        text = description.strip()
        if payee_account_id:
            if _PAYEE_TAG.search(text):
                raise ValueError("description already carries a payee tag")
            text = f"{text} [payee:{payee_account_id}]"
        return self._create_txn("transfer", account_id, {
            "transaction_date": _iso(date), "status": _status(status),
            "amount": cents_to_dollars(amount_cents), "description": text,
        })

    def update_purchase(self, purchase_id: str, **fields: Any) -> dict:
        # PurchaseUpdate accepts description, amount, purchase_date, medium and payer_id only.
        bad = set(fields) - {"description", "amount", "purchase_date", "medium", "payer_id"}
        if bad:
            raise ValueError(f"Nessie rejects updates to {sorted(bad)} on purchases")
        return _unwrap(self._request("PUT", f"/purchase/{purchase_id}", fields)) or {}

    # bills

    def list_bills(self, account_id: str) -> list[Bill]:
        return [parse_bill(o, account_id) for o in self._list(f"/accounts/{account_id}/bills")]

    def customer_bills(self, customer_id: str) -> list[Bill]:
        return [parse_bill(o) for o in self._list(f"/customers/{customer_id}/bills")]

    def get_bill(self, bill_id: str) -> Bill:
        return parse_bill(self._request("GET", f"/bills/{bill_id}"))

    def create_bill(self, account_id: str, *, payee: str, nickname: str, amount_cents: int,
                    payment_date: str | _date, recurring_date: int, status: str = "pending") -> Bill:
        # A bill created without payment_date and recurring_date never gets an
        # upcoming_payment_date, and then every bill list on the account and customer fails.
        if not 1 <= int(recurring_date) <= 31:
            raise ValueError("recurring_date must be a day of the month")
        body = {"status": _status(status, BILL_STATUSES), "payee": payee, "nickname": nickname,
                "payment_date": _iso(payment_date), "recurring_date": int(recurring_date),
                "payment_amount": _bill_amount(amount_cents)}
        path = f"/accounts/{account_id}/bills"
        obj = self._create(path, body, lambda: self._list(path),
                           lambda o: o.get("payee") == payee and o.get("nickname") == nickname)
        return parse_bill(obj, account_id)

    def update_bill(self, bill_id: str, *, status: str | None = None, amount_cents: int | None = None,
                    payment_date: str | _date | None = None, nickname: str | None = None,
                    payee: str | None = None) -> Bill:
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = _status(status, BILL_STATUSES)
        if amount_cents is not None:
            body["payment_amount"] = _bill_amount(amount_cents)
        if payment_date is not None:
            body["payment_date"] = _iso(payment_date)
        if nickname is not None:
            body["nickname"] = nickname
        if payee is not None:
            body["payee"] = payee
        if not body:
            raise ValueError("nothing to update")
        obj = _unwrap(self._request("PUT", f"/bills/{bill_id}", body))
        return parse_bill(obj) if obj and "payee" in obj else self.get_bill(bill_id)

    def delete_bill(self, bill_id: str) -> None:
        self._request("DELETE", f"/bills/{bill_id}")

    # whole-customer reads

    def snapshot(self, customer_id: str, meta: dict | None = None) -> BankSnapshot:
        customer = self.get_customer(customer_id)
        accounts = sorted(self.list_accounts(customer_id), key=lambda a: (a.type, a.nickname, a.id))
        txns = sorted((t for a in accounts for t in self.account_txns(a.id)), key=lambda t: (t.date, t.kind, t.id))
        bills = sorted((b for a in accounts for b in self.list_bills(a.id)), key=lambda b: b.id)
        wanted = {t.merchant_id for t in txns if t.merchant_id}
        merchants = sorted((m for m in self.list_merchants() if m.id in wanted), key=lambda m: (m.name, m.id))
        return BankSnapshot(customer, accounts, merchants, txns, bills, dict(meta or {}))


@dataclass
class BankSnapshot:
    """One customer's bank, read live or loaded from seed/snapshots so a demo survives Nessie being down."""

    customer: Customer
    accounts: list[Account]
    merchants: list[Merchant]
    txns: list[Txn]
    bills: list[Bill]
    meta: dict = field(default_factory=dict)

    def account(self, account_id: str) -> Account:
        for a in self.accounts:
            if a.id == account_id:
                return a
        raise KeyError(account_id)

    def account_by_type(self, type: str) -> Account:
        for a in self.accounts:
            if a.type == type:
                return a
        raise KeyError(type)

    def merchant(self, merchant_id: str | None) -> Merchant | None:
        return next((m for m in self.merchants if m.id == merchant_id), None)

    def balance_cents(self, account_id: str, as_of: str | None = None) -> int:
        return computed_balance_cents(self.account(account_id), self.txns, as_of)

    def to_dict(self) -> dict:
        return {
            "format": SNAPSHOT_FORMAT,
            "meta": self.meta,
            "customer": asdict(self.customer),
            "accounts": [asdict(a) for a in self.accounts],
            "merchants": [asdict(m) for m in self.merchants],
            "transactions": [asdict(t) for t in self.txns],
            "bills": [asdict(b) for b in self.bills],
            "balances": {a.id: {"opening_cents": a.opening_balance_cents,
                                "computed_cents": self.balance_cents(a.id)} for a in self.accounts},
        }

    @classmethod
    def from_dict(cls, data: dict) -> BankSnapshot:
        if data.get("format") != SNAPSHOT_FORMAT:
            raise ValueError(f"unsupported snapshot format {data.get('format')!r}")

        def addr(raw: Any) -> Address | None:
            return Address(**raw) if raw else None

        cust = data["customer"]
        return cls(
            customer=Customer(cust["id"], cust["first_name"], cust["last_name"], addr(cust.get("address"))),
            accounts=[Account(**a) for a in data["accounts"]],
            merchants=[replace(Merchant(**m), address=addr(m.get("address"))) for m in data["merchants"]],
            txns=[Txn(**t) for t in data["transactions"]],
            bills=[Bill(**b) for b in data["bills"]],
            meta=data.get("meta", {}),
        )

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=1, sort_keys=False) + "\n")
        tmp.replace(path)

    @classmethod
    def load(cls, path: str | Path) -> BankSnapshot:
        return cls.from_dict(json.loads(Path(path).read_text()))


def load_persona_snapshot(persona_id: str, directory: str | Path | None = None) -> BankSnapshot:
    return BankSnapshot.load(Path(directory or SNAPSHOT_DIR) / f"{persona_id}.json")


def list_persona_snapshots(directory: str | Path | None = None) -> list[str]:
    return sorted(p.stem for p in Path(directory or SNAPSHOT_DIR).glob("*.json"))
