from __future__ import annotations

import datetime as dt

import pytest

from tend_agent.parse import (
    exam_value,
    find_confirm_code,
    find_date,
    find_exam,
    find_expense,
    find_link_code,
    find_report,
    find_topics,
    is_greeting,
    looks_like_story,
    report_value,
    says_no,
    says_yes,
    selection_from_text,
    wants_cancel,
    wants_check,
    wants_demo,
    wants_pay,
)
from tend_agent.states import STATES, find_state, find_states

TODAY = dt.date(2026, 10, 3)


def test_all_51_jurisdictions():
    assert len(STATES) == 51 and "DC" in STATES


@pytest.mark.parametrize(
    "text, st",
    [
        ("What is the deadline in Michigan?", "MI"),
        ("check OH 2026-06-14", "OH"),
        ("Does West Virginia cover rides?", "WV"),
        ("Does Virginia cover rides?", "VA"),
        ("I live in Washington DC", "DC"),
        ("What about Washington, D.C.?", "DC"),
        ("Is Washington different?", "WA"),
        ("Arkansas counseling cap", "AR"),
        ("Kansas counseling cap", "KS"),
        ("new york city rules", "NY"),
        ("mi", "MI"),
        ("check id", "ID"),
        ("in OR, is there a minimum?", "OR"),
        ("OK, what about Ohio?", "OH"),
        ("District of Columbia deadline", "DC"),
    ],
)
def test_find_state(text, st):
    assert find_state(text) == st


@pytest.mark.parametrize(
    "text",
    ["Do I need an ID?", "ok", "hi", "Can my MD sign the form?", "I had a CT scan", "VA benefits", "I am in LA right now", "me"],
)
def test_everyday_words_are_not_states(text):
    assert find_state(text) is None


def test_find_states_in_order_without_double_counting():
    assert find_states("Compare West Virginia and Ohio") == ["WV", "OH"]
    assert find_states("ALL CAPS MI OH") == []  # shouting: names only


@pytest.mark.parametrize(
    "text, expected",
    [
        ("2026-06-14", dt.date(2026, 6, 14)),
        ("it was 6/14/2026", dt.date(2026, 6, 14)),
        ("6/14/26", dt.date(2026, 6, 14)),
        ("June 14, 2026", dt.date(2026, 6, 14)),
        ("on jun 14 2026", dt.date(2026, 6, 14)),
        ("14 June 2026", dt.date(2026, 6, 14)),
        ("the 14th of June 2026", dt.date(2026, 6, 14)),
        ("June 14", dt.date(2026, 6, 14)),
        ("December 1", dt.date(2025, 12, 1)),  # no year: the most recent one
    ],
)
def test_find_date(text, expected):
    found = find_date(text, TODAY)
    assert found is not None and found.date == expected and not found.future


def test_future_and_invalid_dates():
    assert find_date("2027-01-01", TODAY).future
    assert find_date("2026-02-30", TODAY) is None
    assert find_date("no date here", TODAY) is None
    assert find_date("I may have", TODAY) is None


@pytest.mark.parametrize(
    "text, exam",
    [
        ("I had a forensic exam", "yes"),
        ("got a SANE exam at the hospital", "yes"),
        ("exam: yes", "yes"),
        ("exam no, police report yes", "no"),
        ("I didn't have an exam", "no"),
        ("no exam", "no"),
        ("not sure about the exam", "not_sure"),
        ("Who pays for the exam?", None),
        ("Does Ohio cover counseling?", None),
    ],
)
def test_find_exam(text, exam):
    assert find_exam(text) == exam


@pytest.mark.parametrize(
    "text, report",
    [
        ("I reported it", "yes"),
        ("police report yes", "yes"),
        ("exam no, police report yes", "yes"),
        ("I didn't report to the police", "no"),
        ("haven't reported", "no"),
        ("not yet reported", "no"),
        ("not sure if a report was made", "unknown"),
        ("Do I need a police report?", None),
    ],
)
def test_find_report(text, report):
    assert find_report(text) == report


def test_card_values():
    assert exam_value("yes") is True and exam_value("no") is False and exam_value("not_sure") is None and exam_value(None) is None
    assert report_value("not_yet") == "no" and report_value("yes") == "yes" and report_value(None) == "unknown"


@pytest.mark.parametrize(
    "text", ["482913", "482 913", "482-913", "code 482913", "the code is 482913", "confirm 482913", "Confirm code: 482913"]
)
def test_confirm_code_found(text):
    assert find_confirm_code(text) == "482913"


@pytest.mark.parametrize("text", ["Call 877-251-7373", "2026-06-14", "pay $118.00", "zip 48109 then 2", "1234567", "The user entered code"])
def test_confirm_code_not_found(text):
    assert find_confirm_code(text) is None


def test_link_code():
    assert find_link_code("link w7mz-ephm") == "W7MZ-EPHM"
    assert find_link_code("Link code: W7MZ EPHM") == "W7MZ-EPHM"
    assert find_link_code("link IOIO-1111") is None  # those letters and digits are never used


@pytest.mark.parametrize(
    "fn, text, expected",
    [
        (wants_pay, "pay the bill", True),
        (wants_pay, "yes, pay it", True),
        (wants_pay, "Does Ohio pay for counseling?", False),
        (wants_pay, "What does Michigan pay?", False),
        (wants_demo, "show me the demo claim", True),
        (wants_demo, "walk me through an example claim", True),
        (wants_check, "check MI", True),
        (wants_check, "run a check for Ohio", True),
        (wants_check, "What does the checklist say?", False),
        (is_greeting, "hi", True),
        (is_greeting, "hello, what is the deadline in Ohio and do I need a report?", False),
        (says_yes, "Yes, count them", True),
        (says_yes, "The user approved the payment", True),
        (says_no, "not now", True),
        (says_no, "no thanks", True),
        (wants_cancel, "cancel", True),
        (wants_cancel, "The user rejected the card", True),
    ],
)
def test_intents(fn, text, expected):
    assert fn(text) is expected


def test_topics_and_expenses():
    assert find_topics("What is the deadline in Ohio?")[0] == "deadline"
    assert find_topics("Do I need a police report?")[0] == "reporting"
    assert find_topics("What is not covered?")[0] == "excluded"
    assert find_expense("Does it pay for therapy?") == "counseling"
    assert find_expense("Uber rides to the clinic") == "transportation"
    assert find_expense("my phone was broken") == "property_replacement"


@pytest.mark.parametrize(
    "text, story",
    [
        ("my ex boyfriend attacked me at his apartment and I want to know if I can get therapy paid for", True),
        ("He grabbed me and took my phone, does the state pay for a new phone?", True),
        ("Does Michigan cover counseling for sexual assault survivors?", False),
        ("he was", False),  # short messages are not treated as a story
    ],
)
def test_story_guard(text, story):
    assert looks_like_story(text) is story


def test_selection_from_text():
    assert selection_from_text('{"action": "check", "st": "MI"}') == {"action": "check", "st": "MI"}
    assert selection_from_text("[1, 2]") is None and selection_from_text("{not json}") is None and selection_from_text("hi") is None
