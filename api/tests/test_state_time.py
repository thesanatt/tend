"""as_of_date is today in the state's own time (docs/SPEC.md v1.3), never the program's Detroit time.

A state with several zones uses its westernmost, whose date turns last, so a late night anywhere in
the state never counts a filing deadline a day early.
"""

from __future__ import annotations

import datetime as dt
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest
from helpers import REPO, client_for, fake_ref, make_services

from tend_api import clock as clock_module
from tend_api.agent import DISCOVERY_NOTE
from tend_api.clock import STANDARD_OFFSET_HOURS, STATE_TIME_ZONES, local_today, state_today

# Every zone a state's land is in (IANA zone.tab, plus the towns that keep a neighbor's time).
ALL_ZONES = {
    "AK": ["America/Anchorage", "America/Juneau", "America/Sitka", "America/Metlakatla", "America/Yakutat", "America/Nome", "America/Adak"],
    "AZ": ["America/Phoenix", "America/Denver"],
    "FL": ["America/New_York", "America/Chicago"],
    "ID": ["America/Boise", "America/Los_Angeles"],
    "IN": [
        "America/Indiana/Indianapolis",
        "America/Indiana/Vincennes",
        "America/Indiana/Winamac",
        "America/Indiana/Marengo",
        "America/Indiana/Petersburg",
        "America/Indiana/Vevay",
        "America/Indiana/Tell_City",
        "America/Indiana/Knox",
        "America/Chicago",
    ],
    "KS": ["America/Chicago", "America/Denver"],
    "KY": ["America/Kentucky/Louisville", "America/Kentucky/Monticello", "America/Chicago"],
    "MI": ["America/Detroit", "America/Menominee"],
    "ND": [
        "America/Chicago",
        "America/North_Dakota/Center",
        "America/North_Dakota/New_Salem",
        "America/North_Dakota/Beulah",
        "America/Denver",
    ],
    "NE": ["America/Chicago", "America/Denver"],
    "NV": ["America/Los_Angeles", "America/Denver"],
    "OR": ["America/Los_Angeles", "America/Boise"],
    "SD": ["America/Chicago", "America/Denver"],
    "TN": ["America/New_York", "America/Chicago"],
    "TX": ["America/Chicago", "America/Denver"],
}
LATE_NIGHT = dt.datetime(2026, 10, 4, 5, 30, tzinfo=dt.UTC)  # 1:30 AM in Detroit, 7:30 PM the day before in Honolulu


def test_every_jurisdiction_has_a_zone():
    corpus = sorted(p.stem for p in (REPO / "rules" / "verified").glob("*.json"))
    assert len(STATE_TIME_ZONES) == 51 and sorted(STATE_TIME_ZONES) == (corpus or sorted(STATE_TIME_ZONES))
    for name in STATE_TIME_ZONES.values():
        zone = ZoneInfo(name)
        january = dt.datetime(2026, 1, 15, 12, tzinfo=dt.UTC).astimezone(zone)
        assert january.utcoffset() == dt.timedelta(hours=STANDARD_OFFSET_HOURS[name]), name


@pytest.mark.parametrize("st", sorted(ALL_ZONES))
def test_the_chosen_zone_is_never_ahead_of_any_part_of_the_state(st):
    chosen = ZoneInfo(STATE_TIME_ZONES[st])
    others = [ZoneInfo(z) for z in ALL_ZONES[st]]
    assert STATE_TIME_ZONES[st] in ALL_ZONES[st]
    t = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    while t.year == 2026:  # every hour of a year, both sides of every clock change
        mine = t.astimezone(chosen).date()
        assert all(mine <= t.astimezone(z).date() for z in others), (st, t)
        t += dt.timedelta(hours=1)


def test_a_late_night_check_counts_in_the_states_own_time():
    assert local_today(LATE_NIGHT) == dt.date(2026, 10, 4)  # the program's Detroit date, used before
    expected = {
        "HI": "2026-10-03",
        "AK": "2026-10-03",
        "CA": "2026-10-03",
        "AZ": "2026-10-03",
        "TX": "2026-10-03",
        "NY": "2026-10-04",
        "MI": "2026-10-04",
        "IL": "2026-10-04",
    }
    assert {st: state_today(LATE_NIGHT, st).isoformat() for st in expected} == expected
    # 12:30 AM in Detroit is still 11:30 PM in Michigan's Central time counties: the day before.
    assert state_today(dt.datetime(2026, 10, 4, 4, 30, tzinfo=dt.UTC), "mi") == dt.date(2026, 10, 3)
    # Anything that is not one of the 51 keeps the program's zone.
    assert state_today(LATE_NIGHT, None) == state_today(LATE_NIGHT, "ZZ") == local_today(LATE_NIGHT)


def test_without_the_zone_database_standard_time_is_used(monkeypatch):
    def missing(name):
        raise ZoneInfoNotFoundError(name)

    monkeypatch.setattr(clock_module, "ZoneInfo", missing)
    # In daylight time, standard time is an hour behind: the date can only come out late, never early.
    t = dt.datetime(2026, 7, 1, 5, 30, tzinfo=dt.UTC)  # 12:30 AM CDT, 11:30 PM CST
    assert state_today(t, "IL") == dt.date(2026, 6, 30)
    assert state_today(LATE_NIGHT, "HI") == dt.date(2026, 10, 3)
    for st, name in STATE_TIME_ZONES.items():
        real = ZoneInfo(name)  # this module's ZoneInfo is the real one
        for hour in range(0, 24 * 366, 7):
            moment = dt.datetime(2026, 1, 1, tzinfo=dt.UTC) + dt.timedelta(hours=hour)
            assert state_today(moment, st) <= moment.astimezone(real).date(), (st, moment)


def _web_table(name: str) -> dict[str, str]:
    source = REPO / "web" / "lib" / "stateTime.ts"
    if not source.is_file():
        pytest.skip("no web/ checkout")
    text = source.read_text(encoding="utf-8")
    block = re.search(rf"export const {name}: Record<string, (?:string|number)> = \{{(.*?)\n\}};", text, re.S)
    assert block, name
    return dict(re.findall(r'^\s*"?([A-Za-z_/]+)"?: "?([-A-Za-z_/0-9]+)"?,', block.group(1), re.M))


def test_the_web_uses_the_same_zones():
    assert _web_table("STATE_TIME_ZONES") == STATE_TIME_ZONES
    offsets = _web_table("STANDARD_OFFSET_HOURS")
    assert {k: int(v) for k, v in offsets.items()} == STANDARD_OFFSET_HOURS


@pytest.mark.parametrize("st", sorted(ALL_ZONES))
def test_the_webs_eastern_zone_is_never_behind_any_part_of_the_state(st):
    # The web keeps the device's date when it lies between the state's westernmost and easternmost
    # dates, so a survivor just after midnight in Detroit, Houston, or Anchorage can enter today.
    east_table = _web_table("STATE_EAST_TIME_ZONES")
    assert sorted(east_table) == sorted(ALL_ZONES)
    east = ZoneInfo(east_table[st])
    assert east_table[st] in ALL_ZONES[st]
    others = [ZoneInfo(z) for z in ALL_ZONES[st]]
    t = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
    while t.year == 2026:
        mine = t.astimezone(east).date()
        assert all(mine >= t.astimezone(z).date() for z in others), (st, t)
        t += dt.timedelta(hours=1)


def test_the_agent_check_asks_the_engine_with_the_states_date(settings, clock):
    seen = []

    def capture(law, payload):
        seen.append(payload["context"]["as_of_date"])
        return fake_ref.evaluate(law, payload)

    clock.now = dt.datetime(2026, 10, 4, 4, 30, tzinfo=dt.UTC)  # 12:30 AM in Detroit
    client = client_for(make_services(settings, clock, reference_evaluate=capture))
    assert client.post("/api/agent/check", json={"st": "MI", "incident_date": "2026-06-14"}).status_code == 200
    assert client.post("/api/agent/check", json={"st": "WI", "incident_date": "2026-06-14"}).status_code == 200
    assert seen and set(seen) == {"2026-10-03"}  # the program's Detroit date would be 2026-10-04


@pytest.mark.parametrize("status", ["ok", "late"])
def test_a_deadline_that_may_count_from_discovery_says_so(settings, clock, status):
    def flagged(law, payload):  # the engines flag a deadline counted from discovery (engine/FORMAT.md section 4)
        out = fake_ref.evaluate(law, payload)
        out["checks"]["deadline"]["flags"] = ["deadline_from_discovery"]
        return out

    client = client_for(make_services(settings, clock, reference_evaluate=flagged))
    incident = "2020-01-01" if status == "late" else "2026-06-14"
    deadline = client.post("/api/agent/check", json={"st": "MI", "incident_date": incident}).json()["deadline"]
    assert deadline["status"] == status and deadline["flags"] == ["deadline_from_discovery"]
    assert deadline["text"].endswith(DISCOVERY_NOTE)
    assert "—" not in deadline["text"] and "!" not in deadline["text"]
