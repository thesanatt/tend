from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

Clock = Callable[[], dt.datetime]

try:
    PROGRAM_TZ: dt.tzinfo = ZoneInfo("America/Detroit")
except ZoneInfoNotFoundError:
    PROGRAM_TZ = dt.UTC


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def iso(t: dt.datetime) -> str:
    # Fixed width so stored timestamps also compare correctly as strings.
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def local_today(now: dt.datetime) -> dt.date:
    return now.astimezone(PROGRAM_TZ).date()


def parse_date(value: object) -> dt.date | None:
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value)
        except ValueError:
            return None
    return None
