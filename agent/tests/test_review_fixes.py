"""Regression tests for the issues found in review."""

from __future__ import annotations

import json

import pytest
from conftest import text_of
from fake_api import load

from tend_agent.check import deadline_section, total_section
from tend_agent.demo import render_claim
from tend_agent.knowledge import RuleBook, answer_from_rules
from tend_agent.parse import story_kind

# ---------------------------------------------------------------- story guard


@pytest.mark.parametrize(
    "text, kind",
    [
        ("he raped me", "act"),  # short, but it is still what happened
        ("Ohio. someone drugged me", "act"),
        ("I was assaulted, what now", "act"),
        ("check Michigan, it happened on June 14 2026, had an exam", None),  # only the date
        ("check Michigan, it happened on 2026-06-14, had an exam, not reported", None),
        ("it happened at a party last weekend and I am not sure what to do now", "context"),
        ("Can my boyfriend get counseling covered in Ohio too?", "context"),
        ("Can my partner apply?", None),
        ("What if they were drunk?", None),
        ("Does Michigan cover counseling for sexual assault survivors?", None),
    ],
)
def test_story_kind(text, kind):
    assert story_kind(text) == kind


def test_short_story_with_a_state_never_reaches_the_answer_route(chat, fake):
    turn = chat.say("Ohio, he raped me")
    sent = json.dumps(fake.calls)
    assert "raped" not in sent
    out = text_of(turn)
    assert out.startswith("You don't need to tell me what happened") and "800-656-4673" in out


def test_question_about_a_partner_is_guarded_without_a_lecture(chat, fake):
    turn = chat.say("Can my boyfriend get counseling covered in Michigan too?")
    assert "boyfriend" not in json.dumps(fake.calls)
    assert "You don't need to tell me" not in text_of(turn)


def test_date_in_it_happened_on_is_not_a_story(chat, fake):
    turn = chat.say("check Michigan, it happened on June 14 2026, had an exam")
    assert turn.intent == "check"
    assert not text_of(turn).startswith("You don't need to tell me")
    assert fake.bodies("/api/agent/check")[0]["incident_date"] == "2026-06-14"


# ---------------------------------------------------------------- pay with nothing to pay


def test_pay_the_bill_without_a_demo_says_there_is_no_bill(chat, fake):
    turn = chat.say("pay the bill")
    assert turn.intent == "pay_none" and "no bill to pay" in text_of(turn)
    assert "/api/actions/propose" not in fake.paths()


# ---------------------------------------------------------------- claim retry after a server error


def test_count_works_again_after_the_claim_call_fails(chat, fake):
    chat.say("demo")
    fake.fail_always["/api/claim"] = 503  # the client retries a read once, so fail both tries
    turn = chat.say("yes")
    assert turn.intent == "api_error" and "no money moved" in text_of(turn)
    del fake.fail_always["/api/claim"]
    turn = chat.say("yes")
    assert turn.intent == "count" and "can ask for: $4,008.00" in text_of(turn)


# ---------------------------------------------------------------- deadline wording


def test_check_with_a_date_but_no_exact_deadline_does_not_ask_for_the_date_again(chat, fake):
    cites = load("check_MI.json")["deadline"]["citations"]
    fake.check_patch = {"deadline": {"status": "unknown", "deadline_date": None, "citations": cites}}
    out = text_of(chat.say("check Michigan, 2026-06-14, had an exam"))
    assert "Tell me the date" not in out and "could not work out the exact day" in out


def test_check_with_no_deadline_rule_says_so(chat, fake):
    fake.check_patch = {"deadline": {"status": "unknown", "deadline_date": None, "citations": []}}
    out = text_of(chat.say("check Michigan, 2026-06-14"))
    assert "could not find a verified filing deadline for Michigan" in out


def test_deadline_without_a_date_still_asks_for_it():
    out = deadline_section({"status": "unknown", "citations": [{"rule_id": "X-1", "pinpoint": "Sec. 1"}]}, None)
    assert "Tell me the date" in out


def test_late_deadline_in_the_demo_claim_is_not_apply_by():
    claim = load("claim_rowan_mi.json")
    claim["checks"]["deadline"] = {"status": "late", "deadline_date": "2021-06-14", "rule_ids": ["MI-FILE-1"]}
    book = RuleBook(load("MI.json"))
    demo = {"police_report": "unknown", "payable_cents": 0}
    out = render_claim(claim, book, demo, "Rowan Hale")
    assert "Apply by June 14, 2021" not in out and "The usual deadline was June 14, 2021" in out


# ---------------------------------------------------------------- police report wording in the demo


def test_demo_reporting_line_matches_what_was_said_about_the_report():
    claim = load("claim_rowan_mi.json")
    book = RuleBook(load("MI.json"))
    exam = render_claim(claim, book, {"police_report": "unknown"}, "Rowan Hale")
    reported = render_claim(claim, book, {"police_report": "yes"}, "Rowan Hale")
    assert "forensic exam counts in place of a police report" in exam
    assert "forensic exam counts" not in reported and "police report meets that rule" in reported


def test_demo_state_keeps_the_report_answer_not_the_text(chat):
    chat.say("demo")
    assert chat.state["demo"]["ref"]["police_report"] == "unknown"


# ---------------------------------------------------------------- total caps


def _book(*caps):
    rules = [
        {"id": rid, "category": "total_cap", "params": params, "pinpoint": f"Sec. {rid}", "summary": "cap", "quote": "q"}
        for rid, params in caps
    ]
    return RuleBook({"jurisdiction": "ZZ", "name": "Testland", "rules": rules, "sources": []})


def test_total_cap_uses_the_smallest_cap_that_applies_to_everyone():
    # Like Arkansas: $10,000, or $25,000 for catastrophic injury. The engine also uses the smallest.
    out = total_section(_book(("AR-CAP-2", {"amount_cents": 2500000}), ("AR-CAP-1", {"amount_cents": 1000000})))
    assert "$10,000 in total" in out and "$25,000" not in out


def test_total_cap_limited_to_cases_lists_each_case():
    # Like Illinois: the cap depends on the crime date.
    book = _book(
        ("IL-CAP-1", {"amount_cents": 4500000, "applies_to": "crimes committed on or after August 7, 2022"}),
        ("IL-CAP-2", {"amount_cents": 2700000, "applies_to": "crimes committed before August 7, 2022"}),
    )
    out = total_section(book)
    assert "depends on the case" in out
    assert "$45,000 for crimes committed on or after August 7, 2022" in out and "$27,000 for crimes committed before" in out
    answer = answer_from_rules(book.doc, "what is the most I can get?").text
    assert "depends on the case" in answer and "$27,000" in answer
