from __future__ import annotations

import pytest
from fake_api import load

from tend_agent.check import render_check
from tend_agent.fmt import cite_block, cite_link, long_date, money, money_short, short_quote
from tend_agent.knowledge import RuleBook, answer_from_rules, cap_phrase

MI = load("MI.json")


def test_money_is_integer_cents_only():
    assert money(0) == "$0.00" and money(11800) == "$118.00" and money(4500000) == "$45,000.00" and money(-5) == "-$0.05"
    assert money_short(4500000) == "$45,000" and money_short(1250) == "$12.50"
    with pytest.raises(TypeError):
        money(1.5)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        money(True)  # type: ignore[arg-type]


def test_long_date():
    assert long_date("2031-06-14") == "June 14, 2031"


def test_quotes_stay_verbatim_up_to_the_cut():
    q = "word " * 100
    cut = short_quote(q, 40)
    assert cut.endswith(" ...") and q.startswith(cut[:-4].strip())
    assert short_quote("short quote") == "short quote"


def test_cite_block_has_summary_quote_and_link():
    c = {
        "rule_id": "MI-EXAM-1",
        "pinpoint": "MCL 18.355a(2)",
        "summary": "No exam bill.",
        "quote": "shall not submit a bill",
        "fragment_url": "https://x.test/#:~:text=a",
    }
    text = cite_block(c)
    assert text.splitlines()[0] == "No exam bill. ([MCL 18.355a(2)](https://x.test/#:~:text=a))"
    assert text.splitlines()[1] == '> "shall not submit a bill"'
    assert cite_link({"pinpoint": "X", "source_url": "javascript:alert(1)"}) == "X"  # only http(s) links


def test_deadline_answer_quotes_the_statute():
    a = answer_from_rules(MI, "What is the deadline to apply?")
    assert a.known
    assert "MCL 18.355(2)" in a.text and "not later than 5 years" in a.text and "legislature.mi.gov" in a.text


def test_expense_answer_lists_caps():
    a = answer_from_rules(MI, "Does Michigan pay for therapy?")
    assert a.known and "**counseling**" in a.text
    assert "up to $80 a session" in a.text and "up to $125 a session" in a.text


def test_excluded_expense_is_not_covered():
    a = answer_from_rules(MI, "Will they pay for my phone?")
    assert a.known and "not covered" in a.text and "MI-EXCL-1" not in a.text and "cell phone" in a.text


def test_exam_answer():
    a = answer_from_rules(MI, "Can the hospital bill me for the rape kit?")
    assert a.known and "MCL 18.355a(2)" in a.text and "shall not submit a bill" in a.text


def test_not_in_the_rules_when_no_rule_supports_it():
    a = answer_from_rules(MI, "How long does a decision take?")  # no processing_time rule in this file
    assert not a.known and a.text.startswith("That's not in the rules I have.") and "877-251-7373" in a.text
    b = answer_from_rules({**MI, "rules": []}, "Does it pay for dental work?")
    assert not b.known and "dental care" in b.text and "won't guess" in b.text
    c = answer_from_rules(MI, "What color is the sky?")
    assert not c.known and c.text.startswith("That's not in the rules I have.")


def test_main_question_is_never_swapped_for_another():
    # "How long" is about processing time, which this file lacks; "apply" also appears but must not be answered instead.
    a = answer_from_rules(MI, "How long until I hear back after I apply?")
    assert not a.known and "how long a decision takes" in a.text


def test_covered_list_and_limits():
    a = answer_from_rules(MI, "What costs are covered?")
    assert "- Counseling, up to $125 a session, limits vary" in a.text
    assert "Eyeglasses" in a.text  # an "other" expense shows what the rule names
    m = answer_from_rules(MI, "What is the maximum?")
    assert "**$45,000**" in m.text and "MCL 18.361(1)" in m.text


def test_rules_for_someone_else_say_so():
    rule = {
        "id": "X-CAP",
        "category": "expense_cap",
        "params": {"expense": "counseling", "amount_cents": 500000, "per": "claim", "applies_to": "household family members"},
    }
    assert cap_phrase(rule) == "up to $5,000 (for household family members)"
    book = RuleBook(
        {
            "jurisdiction": "ZZ",
            "name": "Zed",
            "rules": [rule, {"id": "X-COV", "category": "covered_expense", "params": {"expense": "counseling"}}],
        }
    )
    assert book.covered_list()[0][3] == "up to $5,000 (for household family members)"


def test_render_check_when_the_exam_answer_is_not_sure():
    data = load("check_MI_unsure.json")
    text = render_check(data, RuleBook(MI), st="MI", name="Michigan", incident_date="2026-06-14", exam=None, report="no")
    assert text.startswith("**You can likely apply in Michigan.** The program decides.")
    assert "you qualify" not in text.lower()
    assert "apply by **June 14, 2031**" in text
    assert "if you had a forensic exam, it counts in place of a police report" in text
    assert "Counseling (up to $125 a session, limits vary)" in text
    assert "**Most you can ask for:** $45,000" in text
    assert "877-251-7373" in text and "Rules can have exceptions" in text


def test_render_check_report_needed_without_exam():
    data = load("check_MI_noexam.json")
    text = render_check(data, RuleBook(MI), st="MI", name="Michigan", incident_date="2026-06-14", exam=False, report="no")
    assert "**Police report:** Michigan asks for one. These can count instead: a forensic exam." in text
    assert "MCL 18.360(c)" in text  # the rule that asks for the report


def test_render_check_late_deadline():
    data = load("check_MI.json")
    data["deadline"] = {**data["deadline"], "status": "late", "deadline_date": "2021-06-14"}
    text = render_check(data, RuleBook(MI), st="MI", name="Michigan", incident_date="2016-06-14", exam=True, report="no")
    assert "the usual deadline was **June 14, 2021**" in text and "You can likely apply" not in text


def test_no_dashes_in_agent_copy():
    import pathlib

    for path in pathlib.Path(__file__).parents[1].joinpath("tend_agent").glob("*.py"):
        text = path.read_text()
        assert "—" not in text and "–" not in text, path.name
