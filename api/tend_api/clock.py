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


# Each jurisdiction's own time zone, for the engine's as_of_date. Where a state spans several, the
# westernmost one (its date turns last), so a late night anywhere in the state never counts a filing
# deadline a day early. web/lib/stateTime.ts holds the same table; api/tests/test_state_time.py keeps
# the two equal.
STATE_TIME_ZONES: dict[str, str] = {
    "AK": "America/Adak",  # the western Aleutians, on Hawaii-Aleutian time
    "AL": "America/Chicago",
    "AR": "America/Chicago",
    "AZ": "America/Phoenix",  # no daylight time; the Navajo Nation's clock is never behind it
    "CA": "America/Los_Angeles",
    "CO": "America/Denver",
    "CT": "America/New_York",
    "DC": "America/New_York",
    "DE": "America/New_York",
    "FL": "America/Chicago",  # the western panhandle
    "GA": "America/New_York",
    "HI": "Pacific/Honolulu",
    "IA": "America/Chicago",
    "ID": "America/Los_Angeles",  # the northern panhandle
    "IL": "America/Chicago",
    "IN": "America/Chicago",  # the northwest and southwest counties
    "KS": "America/Denver",  # four western counties
    "KY": "America/Chicago",  # western Kentucky
    "LA": "America/Chicago",
    "MA": "America/New_York",
    "MD": "America/New_York",
    "ME": "America/New_York",
    "MI": "America/Menominee",  # the four Central time counties on the Wisconsin border
    "MN": "America/Chicago",
    "MO": "America/Chicago",
    "MS": "America/Chicago",
    "MT": "America/Denver",
    "NC": "America/New_York",
    "ND": "America/Denver",  # the southwest
    "NE": "America/Denver",  # the panhandle
    "NH": "America/New_York",
    "NJ": "America/New_York",
    "NM": "America/Denver",
    "NV": "America/Los_Angeles",
    "NY": "America/New_York",
    "OH": "America/New_York",
    "OK": "America/Chicago",
    "OR": "America/Los_Angeles",  # Malheur County is on Mountain time, east of this
    "PA": "America/New_York",
    "RI": "America/New_York",
    "SC": "America/New_York",
    "SD": "America/Denver",  # the western half
    "TN": "America/Chicago",  # Middle and West Tennessee
    "TX": "America/Denver",  # El Paso and Hudspeth counties
    "UT": "America/Denver",
    "VA": "America/New_York",
    "VT": "America/New_York",
    "WA": "America/Los_Angeles",
    "WI": "America/Chicago",
    "WV": "America/New_York",
    "WY": "America/Denver",
}
# Standard time offsets in hours, used only when the zone database is missing. Standard time is
# never ahead of the local clock, so the fallback can only count a deadline late, never early.
STANDARD_OFFSET_HOURS: dict[str, int] = {
    "America/New_York": -5,
    "America/Chicago": -6,
    "America/Menominee": -6,
    "America/Denver": -7,
    "America/Phoenix": -7,
    "America/Los_Angeles": -8,
    "America/Adak": -10,
    "Pacific/Honolulu": -10,
}


def state_zone(st: str | None) -> dt.tzinfo:
    """The time zone a state's deadlines are counted in; the program's zone for anything else."""
    name = STATE_TIME_ZONES.get((st or "").upper())
    if name is None:
        return PROGRAM_TZ
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return dt.timezone(dt.timedelta(hours=STANDARD_OFFSET_HOURS[name]), name)


def state_today(now: dt.datetime, st: str | None) -> dt.date:
    """Today in the state's own time: the engine's as_of_date (docs/SPEC.md v1.3)."""
    return now.astimezone(state_zone(st)).date()


def parse_date(value: object) -> dt.date | None:
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value)
        except ValueError:
            return None
    return None
