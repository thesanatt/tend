from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

# "$1,171.75", "325.00", "(12.50)", "-12.50", "$443". Cents must be exactly two digits when present.
_MONEY = re.compile(r"^(?P<open>\()?\s*(?P<neg>-)?\s*\$?\s*(?P<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<frac>\d{2}))?\s*(?P<close>\))?$")
MONEY_TOKEN = re.compile(r"\(?-?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?|\(?-?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)\)?")


def parse_cents(text: str) -> int:
    m = _MONEY.match(text.strip())
    if not m or bool(m.group("open")) != bool(m.group("close")):
        raise ValueError(f"not a money amount: {text!r}")
    cents = int(m.group("whole").replace(",", "")) * 100 + int(m.group("frac") or 0)
    return -cents if (m.group("neg") or m.group("open")) else cents


def format_cents(cents: int) -> str:
    if isinstance(cents, bool) or not isinstance(cents, int):
        raise TypeError("amounts are integer cents")
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


MONEY_MAPS = {"by_expense"}


def assert_integer_cents(obj: Any, path: str = "$") -> None:
    """Every *_cents value (and every value under a *_cents mapping) must be an int, never a float or bool."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            here = f"{path}.{key}"
            if isinstance(key, str) and (key.endswith("_cents") or key in MONEY_MAPS):
                _check_cents_value(value, here)
            assert_integer_cents(value, here)
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            assert_integer_cents(value, f"{path}[{i}]")


def _check_cents_value(value: Any, path: str) -> None:
    if value is None:
        return
    if isinstance(value, dict):
        for key, inner in value.items():
            _check_cents_value(inner, f"{path}.{key}")
        return
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{path} must be integer cents, got {value!r}")


def matches_cents(value: Any, cents: int) -> bool:
    """Exact comparison of a bank's bare number against integer cents, read as cents or as dollars."""
    if isinstance(value, bool) or value is None:
        return False
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return False
    return amount == cents or amount * 100 == cents


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
