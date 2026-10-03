"""Engine input: strict JSON reading and validation, in document order (engine/FORMAT.md section 5).

The C++ engine reads the claim in one streaming pass and stops at the first problem. This module
gives the same answer for every well-formed JSON document: it walks the parsed document in the
order the keys were written (repeated keys included) and checks each value the way the C++
reader does, with the same messages. For text that is not JSON, both engines say bad_input; only
the C++ message carries a byte offset.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date

from .law import ITEM_EXPENSES, UNITS, Law

MAX_SAFE_INT = 2**53 - 1  # integers that survive a round trip through JavaScript (the WASM build)
MAX_DEPTH = 64  # nested arrays and objects, as in the C++ reader
_EPOCH = date(1970, 1, 1).toordinal()
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_TOP_KEYS = ("jurisdiction", "context", "items")
_CONTEXT_KEYS = ("incident_date", "as_of_date", "police_report", "forensic_exam")
_ITEM_KEYS = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units",
              "unit", "tags")
POLICE_REPORT = ("no", "yes", "unknown")


class EngineInputError(ValueError):
    """The claim was refused: code is bad_input or jurisdiction_mismatch, as in the C++ error document."""

    def __init__(self, message: str, code: str = "bad_input"):
        super().__init__(message)
        self.code = code
        self.message = message

    def document(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}


class InvalidJson(EngineInputError):
    """The text is not a JSON document the engine reads (syntax, encoding, nesting)."""

    def __init__(self, reason: str):
        super().__init__(f"invalid JSON: {reason}")


@dataclass(frozen=True)
class Context:
    incident_date: int  # days since 1970-01-01
    as_of_date: int
    police_report: str  # yes, no, unknown
    forensic_exam: bool


@dataclass(frozen=True)
class Item:
    item_id: str
    date: int  # days since 1970-01-01
    amount_cents: int
    expense: str
    confirmed: bool
    insurance_paid_cents: int
    is_bill: bool
    units: int
    unit: str | None
    tags: frozenset[str]


@dataclass(frozen=True)
class Claim:
    context: Context
    items: list[Item]  # input order
    jurisdiction: str | None


# Strict JSON text -> document

class _Pairs(dict):
    """A JSON object that remembers its key/value pairs in written order, repeats included."""

    __slots__ = ("pairs",)


def _object_hook(pairs):
    obj = _Pairs(pairs)
    obj.pairs = pairs
    return obj


class _BigInt:
    """An integer literal too long to matter: it is outside every range the engine accepts."""

    __slots__ = ("text",)

    def __init__(self, text: str):
        self.text = text


def _parse_int(text: str):
    return int(text) if len(text) <= 24 else _BigInt(text)


def _no_constant(name: str):
    raise InvalidJson(f"{name} is not a JSON value")


def _walk(value, depth: int) -> None:
    # Containers nest at most 64 deep, and no string may hold an unpaired surrogate.
    if isinstance(value, (dict, list)):
        if depth >= MAX_DEPTH:
            raise InvalidJson("nesting too deep")
        if isinstance(value, dict):
            for key, v in (value.pairs if isinstance(value, _Pairs) else value.items()):
                _check_text(key)
                _walk(v, depth + 1)
        else:
            for v in value:
                _walk(v, depth + 1)
    elif isinstance(value, str):
        _check_text(value)
    elif value is None or isinstance(value, (bool, int, float, _BigInt)):
        pass
    else:
        raise InvalidJson(f"{type(value).__name__} is not a JSON value")


def _check_text(s) -> None:
    if not isinstance(s, str):
        raise InvalidJson("object keys must be strings")
    for ch in s:
        if "\ud800" <= ch <= "\udfff":
            raise InvalidJson("unpaired surrogate")


def loads(raw: bytes | str):
    """Parses claim JSON with the C++ reader's limits. The C ABI takes a C string, so text after a
    NUL byte is never seen."""
    if isinstance(raw, (bytes, bytearray, memoryview)):
        raw = bytes(raw).split(b"\0", 1)[0]
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise InvalidJson("invalid UTF-8") from None
    else:
        text = raw.split("\0", 1)[0]
    try:
        doc = json.loads(text, object_pairs_hook=_object_hook, parse_int=_parse_int, parse_constant=_no_constant)
    except InvalidJson:
        raise
    except RecursionError:
        raise InvalidJson("nesting too deep") from None
    except ValueError as e:
        raise InvalidJson(str(e)) from None
    _walk(doc, 0)
    return doc


# Document -> claim

def _bad(path: str, what: str):
    raise EngineInputError(f"{path}: {what}")


def _pairs(obj: dict):
    return obj.pairs if isinstance(obj, _Pairs) else obj.items()


def _is_number(v) -> bool:
    return isinstance(v, (int, float, _BigInt)) and not isinstance(v, bool)


def _date(v, path: str) -> int:
    if isinstance(v, str) and _DATE.fullmatch(v):
        y, m, d = int(v[0:4]), int(v[5:7]), int(v[8:10])
        if y >= 1 and 1 <= m <= 12 and d >= 1:
            try:
                return date(y, m, d).toordinal() - _EPOCH
            except ValueError:
                pass
    _bad(path, "expected a date as YYYY-MM-DD")


def _bool(v, path: str) -> bool:
    if v is None:
        return False
    if not isinstance(v, bool):
        _bad(path, "expected true or false")
    return v


def _count(v, path: str) -> int:
    # An integer in [0, 2^53 - 1]; the checks run in the C++ order.
    if not _is_number(v) or isinstance(v, float):
        _bad(path, "expected an integer")
    if isinstance(v, _BigInt) or not -MAX_SAFE_INT <= v <= MAX_SAFE_INT:
        _bad(path, "integer out of range")
    if v < 0:
        _bad(path, "must not be negative")
    return v


def _enum(v, path: str, allowed: tuple, unknown: str):
    if v is None:
        return None
    if not isinstance(v, str):
        _bad(path, "expected a string")
    if v not in allowed:
        _bad(path, unknown)
    return v


def _context(v) -> Context:
    if not isinstance(v, dict):
        _bad("context", "expected an object")
    seen: set[str] = set()
    fields = {"police_report": "unknown", "forensic_exam": False}
    for key, value in _pairs(v):
        if key not in _CONTEXT_KEYS:
            continue
        path = f"context.{key}"
        if key in seen:
            _bad(path, "appears twice")
        seen.add(key)
        if key in ("incident_date", "as_of_date"):
            fields[key] = _date(value, path)
        elif key == "police_report":
            if value is None:
                fields[key] = "unknown"
            elif isinstance(value, str) and value in POLICE_REPORT:
                fields[key] = value
            else:
                _bad(path, "expected yes, no, or unknown")
        else:
            fields[key] = _bool(value, path)
    for key in ("incident_date", "as_of_date"):
        if key not in seen:
            raise EngineInputError(f"context.{key} is required")
    return Context(**fields)


def _item(raw, i: int, law_tags: frozenset[str]) -> Item:
    where = f"items[{i}]"
    if not isinstance(raw, dict):
        _bad(where, "expected an object")
    seen: set[str] = set()
    f = {"expense": "unknown", "confirmed": False, "insurance_paid_cents": 0, "is_bill": False, "units": 0,
         "unit": None, "tags": frozenset()}
    for key, value in _pairs(raw):
        if key not in _ITEM_KEYS:
            continue
        path = f"{where}.{key}"
        if key in seen:
            _bad(path, "appears twice")
        seen.add(key)
        if key == "item_id":
            if not isinstance(value, str):
                _bad(path, "expected a string")
            if not value:
                _bad(path, "must not be empty")
            f["item_id"] = value
        elif key == "date":
            f["date"] = _date(value, path)
        elif key == "amount_cents":
            f["amount_cents"] = _count(value, path)
        elif key == "expense":
            f["expense"] = _enum(value, path, ITEM_EXPENSES, "not a known expense") or "unknown"
        elif key in ("confirmed", "is_bill"):
            f[key] = _bool(value, path)
        elif key in ("insurance_paid_cents", "units"):
            if value is not None:
                f[key] = _count(value, path)
        elif key == "unit":
            f["unit"] = _enum(value, path, UNITS, "not a known unit")
        else:  # tags
            if value is None:
                continue
            if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
                _bad(path, "expected a list of strings")
            # Tags the law never mentions cannot change an outcome.
            f["tags"] = frozenset(t for t in value if t in law_tags)
    for key in ("item_id", "date", "amount_cents"):
        if key not in seen:
            raise EngineInputError(f"{where}.{key} is required")
    return Item(**f)


def read_claim(doc, law: Law) -> Claim:
    """Validates a parsed engine input against a law; raises EngineInputError like the C++ engine."""
    if not isinstance(doc, dict):
        _bad("input", "expected an object")
    seen: set[str] = set()
    ctx = None
    items: list[Item] = []
    jurisdiction = None
    tags = frozenset(law.tags)
    for key, value in _pairs(doc):
        if key not in _TOP_KEYS:
            continue
        if key in seen:
            _bad(key, "appears twice")
        seen.add(key)
        if key == "jurisdiction":
            if value is not None:
                if not isinstance(value, str):
                    _bad(key, "expected a string")
                jurisdiction = value
        elif key == "context":
            ctx = _context(value)
        elif value is not None:
            if not isinstance(value, list):
                _bad("items", "expected an array")
            items = [_item(raw, i, tags) for i, raw in enumerate(value)]
    if ctx is None:
        raise EngineInputError("context is required")
    first: dict[str, int] = {}
    for i, it in enumerate(items):
        j = first.setdefault(it.item_id, i)
        if j != i:
            raise EngineInputError(f"items[{i}].item_id: duplicate of items[{j}]")
    if jurisdiction is not None and jurisdiction != law.jurisdiction:
        raise EngineInputError(f"input is for {jurisdiction} but the law image is {law.jurisdiction}",
                               "jurisdiction_mismatch")
    return Claim(ctx, items, jurisdiction)


def check_document(doc) -> None:
    """A document handed over already parsed (not text) is held to the same limits as text."""
    _walk(doc, 0)
