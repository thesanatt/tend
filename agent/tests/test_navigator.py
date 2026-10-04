"""The conversation, with the Law and Bank+Packet desks in-process and the API mocked with real captures."""

from __future__ import annotations

import datetime as dt
import json

from conftest import SITE, text_of
from fake_api import CODE, FakeTend

from tend_agent.navigator import FIRST_NOTE
from tend_agent.share import open_sealed

STORY = "my ex boyfriend attacked me at his apartment and I want to know if I can get my therapy paid for"
BILL = "c1398337-ac9d-4216-a449-ab7ac2a9e9b4"
CHECKING = "8ff7e76a-0d1a-4327-b13d-4a8ffa529434"
PAY_LINES = ["bill:231c5c86178943f9:1", "bill:231c5c86178943f9:3"]


def to_payment(chat):
    chat.say("show me the demo claim")
    chat.say("yes")
    return chat.say("pay the bill")


# ---------------------------------------------------------------- first message and cited answers


def test_greeting_gets_the_menu_the_privacy_promise_and_a_card(chat):
    turn = chat.say("hi")
    text = text_of(turn)
    assert turn.intent == "welcome" and "Tend Navigator" in text
    assert "I never ask for your name, what happened, or anything that identifies you" in text
    assert turn.replies[0].card is not None and turn.replies[0].card.kind == "detail"
    assert not text.startswith(FIRST_NOTE)


def test_the_first_reply_of_a_session_always_says_what_is_never_asked(chat):
    first = chat.say("What is the deadline to apply in Michigan?")
    assert text_of(first).startswith(FIRST_NOTE)
    assert not text_of(chat.say("What about Ohio?")).startswith(FIRST_NOTE)


def test_a_cited_answer_comes_from_the_answer_route(chat, fake):
    turn = chat.say("Can the hospital in Michigan bill me for the forensic exam?")
    assert fake.bodies("/api/agent/answer") == [{"question": "Can the hospital in Michigan bill me for the forensic exam?", "st": "MI"}]
    text = text_of(turn)
    assert "MCL 18.355a(2)" in text and '> "A health care provider shall not submit a bill' in text and "#:~:text=" in text
    assert turn.intent == "answer"


def test_no_supporting_rule_means_not_in_the_rules_i_have(chat):
    turn = chat.say("Can I get money for my dog's vet bills in Michigan?")
    text = text_of(turn)
    assert "That's not in the rules I have." in text and "won't guess" in text
    assert "Michigan Crime Victim Compensation" in text and "877-251-7373" in text  # the program, from the verified rules


def test_answer_route_missing_falls_back_to_the_verified_rules(make_chat):
    f = FakeTend(answer_missing=True)
    turn = make_chat(f).say("What is the deadline in Michigan?")
    text = text_of(turn)
    assert "MCL 18.355(2)" in text and "not later than 5 years" in text and "legislature.mi.gov" in text


def test_answer_route_error_falls_back_to_the_verified_rules(make_chat):
    f = FakeTend(fail_always={"/api/agent/answer": 500})
    assert "MCL 18.355(2)" in text_of(make_chat(f).say("What is the deadline in Michigan?"))


def test_rule_ids_given_as_strings_become_quotes(make_chat):
    f = FakeTend(answer_reply={"answer": "Michigan covers counseling.", "answered": True, "citations": ["MI-COV-2", "NOT-A-RULE"]})
    text = text_of(make_chat(f).say("Does Michigan cover counseling?"))
    assert text.startswith(f"{FIRST_NOTE}\n\nMichigan covers counseling.") and "MCL 18.361(2)(b)" in text and "NOT-A-RULE" not in text


def test_question_without_a_state_asks_for_one_and_keeps_only_the_topic(chat):
    turn = chat.say("Do I need a police report?")
    assert "Which state" in text_of(turn)
    assert chat.state["awaiting"] == {"kind": "question", "topics": ["reporting"], "expense": None}
    assert "police report?" not in json.dumps(chat.state)
    turn = chat.say("Michigan")
    assert turn.intent == "answer"


def test_follow_up_question_reuses_the_state(chat, fake):
    chat.say("What is the deadline in Michigan?")
    chat.say("what about counseling?")
    assert fake.bodies("/api/agent/answer")[-1] == {"question": "what about counseling?", "st": "MI"}


def test_story_is_never_passed_on(chat, fake):
    turn = chat.say(STORY)
    assert text_of(turn).startswith("You don't need to tell me what happened") and "Which state" in text_of(turn)
    chat.say("Michigan")
    sent = json.dumps(fake.calls)
    assert "boyfriend" not in sent and "apartment" not in sent and "attacked" not in sent
    assert fake.bodies("/api/agent/answer")[0]["question"].startswith("Does Michigan's crime victim compensation program cover counseling")
    assert "boyfriend" not in json.dumps(chat.state)


def test_story_with_state_answers_from_the_topic_only(chat, fake):
    turn = chat.say("He grabbed me at his house in Michigan, does the state pay for therapy?")
    assert text_of(turn).startswith("You don't need to tell me what happened")
    assert all("grabbed" not in json.dumps(b) for b in fake.bodies("/api/agent/answer"))


# ---------------------------------------------------------------- Checks


def test_story_with_check_details_runs_the_check_on_fields_only(chat, fake):
    turn = chat.say("He drugged me at a party in Ohio on June 14, 2026. Can I still apply? I had an exam")
    assert turn.intent == "check" and text_of(turn).startswith("You don't need to tell me what happened")
    assert "party" not in json.dumps(fake.calls) and "drugged" not in json.dumps(fake.calls)
    assert fake.bodies("/api/agent/check") == [
        {"st": "OH", "police_report": "unknown", "incident_date": "2026-06-14", "forensic_exam": True}
    ]


def test_check_by_text(chat, fake):
    turn = chat.say("check Michigan, June 14 2026, had an exam, not reported")
    text = text_of(turn)
    assert "**You can likely apply in Michigan.** The program decides." in text
    assert "apply by **June 14, 2031**" in text and "MCL 18.355(2)" in text
    assert "forensic exam counts in place of a police report" in text and "MCL 18.355a(10)" in text
    assert f"open Tend on your own device: {SITE}/mi" in text and "say **show me the demo claim**" in text
    cap = next(line for line in text.splitlines() if line.startswith("**Most you can ask for:**"))
    assert "$45,000 in total" in cap and cap.endswith("The program decides.")  # every amount to ask for says so
    assert fake.bodies("/api/agent/check") == [{"st": "MI", "police_report": "no", "incident_date": "2026-06-14", "forensic_exam": True}]
    assert "2026-06-14" not in json.dumps(chat.state)  # the date is not kept


def test_check_without_state_sends_the_form_then_runs(chat, fake):
    turn = chat.say("can I apply? I had an exam")
    assert turn.intent == "check_form" and turn.replies[0].card.kind == "form"
    turn = chat.say("Ohio")
    assert turn.intent == "check" and fake.bodies("/api/agent/check")[0]["forensic_exam"] is True


def test_check_form_card_submission(chat, fake):
    chat.say(selection={"action": "check_form"})
    chat.say(
        selection={"action": "check", "st": "MI", "incident_date": "2026-06-14", "forensic_exam": "not_sure", "police_report": "not_yet"}
    )
    assert fake.bodies("/api/agent/check") == [{"st": "MI", "police_report": "no", "incident_date": "2026-06-14"}]  # not sure: nothing sent


def test_check_form_future_and_unreadable_dates(chat):
    assert "That date is in the future" in text_of(chat.say(selection={"action": "check", "st": "MI", "incident_date": "2027-02-01"}))
    assert "I couldn't read that date" in text_of(chat.say(selection={"action": "check", "st": "MI", "incident_date": "last spring"}))
    assert chat.say(selection={"action": "check", "st": "ZZ"}).intent == "check_form"


# ---------------------------------------------------------------- the demo claim, held line, letter, payment


def test_demo_scan_then_count_with_the_held_line_and_its_letter(chat, fake):
    turn = chat.say("show me the demo claim")
    assert turn.intent == "demo" and turn.replies[0].card.kind == "review"
    text = text_of(turn)
    assert "**Demo: Rowan Hale, Michigan.**" in text and "Hospital bill (itemized): 3 lines, $443.00" in text
    kept = json.dumps(chat.state)
    assert "Hearthstone" not in kept and "forensic exam, deductible" not in kept  # no merchant or bill text kept

    turn = chat.say("yes")
    assert turn.intent == "count" and len(turn.replies) == 2
    summary, letter = turn.replies[0].text, turn.replies[1].text
    assert "**Amount Rowan Hale can ask for: $4,008.00. The program decides.**" in summary
    assert "**Don't pay this line:** the forensic exam, $325.00 of the $443.00 hospital bill." in summary
    assert "MCL 18.355a(2)" in summary
    assert "**Letter to the billing office.**" in letter and "Medical forensic exam, deductible applied, June 14, 2026: $325.00" in letter
    assert '"A health care provider shall not submit a bill' in letter and "(MCL 18.355a(2))" in letter
    assert "[Your name]" in letter and "Rowan" not in letter  # placeholders, never a name
    assert "The rest of the hospital bill is **$118.00**" in letter and turn.replies[1].card.kind == "detail"
    claim_body = fake.bodies("/api/claim")[0]
    assert all(i["confirmed"] is True and "description" not in i for i in claim_body["items"])


def test_payment_happens_only_after_the_typed_code(chat, fake):
    turn = to_payment(chat)
    assert turn.intent == "pay_propose"
    assert fake.bodies("/api/actions/propose") == [
        {
            "kind": "pay_bill",
            "bill_id": BILL,
            "item_ids": PAY_LINES,
            "amount_cents": 11800,
            "from_account_id": CHECKING,
            "payee": "Riverbend General Hospital",
        }
    ]
    assert CODE in text_of(turn) and turn.replies[0].card.kind == "review"
    assert CODE not in json.dumps(chat.state)  # the agent forgets the code; only the person can type it back

    for nudge in ("yes", "approve", "pay it"):
        assert chat.say(nudge).intent == "pay_remind"
    assert fake.bodies("/api/actions/confirm") == []

    turn = chat.say("111111")
    assert "does not match" in text_of(turn) and "pending" in chat.state

    turn = chat.say(CODE)
    assert turn.intent == "pay_confirm"
    assert fake.bodies("/api/actions/confirm")[-1] == {"action_id": "act_00000000000000000001", "confirm_code": CODE}
    text = text_of(turn)
    assert text.startswith("**Done.** Paid $118.00 to Riverbend General Hospital") and "aud_000004" in text
    assert "The forensic exam line, $325.00, stays unpaid" in text and "share with an advocate" in text
    assert "pending" not in chat.state and chat.state["demo"]["paid_cents"] == 11800

    assert chat.say(CODE).intent == "pay_stale" and len(fake.bodies("/api/actions/confirm")) == 2
    assert "already paid" in text_of(chat.say("pay the bill"))


def test_review_card_buttons_lead_to_the_code_box(chat, fake):
    chat.say(selection={"action": "demo"})
    chat.say(selection={"action": "count_costs", "scan_id": chat.state["demo"]["ref"]["scan_id"]})
    chat.say(selection={"action": "pay"})
    action_id = chat.state["pending"]["action_id"]
    turn = chat.say(selection={"action": "pay_approve", "action_id": action_id})
    assert turn.intent == "pay_code_form" and turn.replies[0].card.kind == "form"
    assert fake.bodies("/api/actions/confirm") == []
    turn = chat.say(selection={"action": "pay_confirm", "action_id": action_id, "code": CODE})
    assert turn.intent == "pay_confirm" and "**Done.**" in text_of(turn)


def test_planner_prose_with_the_code_confirms(chat, fake):
    to_payment(chat)
    turn = chat.say(f"The user entered code {CODE} and clicked Pay $118.00")
    assert turn.intent == "pay_confirm" and fake.bodies("/api/actions/confirm")[0]["confirm_code"] == CODE


def test_pay_before_counting_asks_for_the_yes_first(chat, fake):
    chat.say("demo")
    turn = chat.say("pay the bill")
    assert "Count the costs first" in text_of(turn) and fake.bodies("/api/actions/propose") == []


def test_pay_the_demo_bill_does_not_start_over(chat, fake):
    chat.say("demo")
    chat.say("yes")
    turn = chat.say("pay the demo bill")
    assert turn.intent == "pay_propose" and len(fake.bodies("/api/scan")) == 2  # demo + count, no third scan


def test_cancel_moves_nothing(chat, fake):
    to_payment(chat)
    turn = chat.say("cancel")
    assert "No money moved" in text_of(turn) and "pending" not in chat.state
    assert chat.say(CODE).intent == "pay_stale"
    assert fake.bodies("/api/actions/confirm") == []


def test_a_question_during_a_payment_does_not_cancel_or_pay(chat, fake):
    to_payment(chat)
    turn = chat.say("Does the program stop paying after a year in Michigan?")
    assert turn.intent == "answer" and "pending" in chat.state
    assert chat.say(CODE).intent == "pay_confirm"


def test_card_cancel_button_and_dismiss(chat, fake):
    to_payment(chat)
    action_id = chat.state["pending"]["action_id"]
    assert chat.say(selection={"action": "pay_cancel", "action_id": action_id}).intent == "pay_cancel"
    chat.say("pay the bill")
    turn = chat.say(cancelled=True)
    assert text_of(turn) == "Cancelled. No money moved." and fake.bodies("/api/actions/confirm") == []


def test_stale_card_click_is_refused(chat, fake):
    to_payment(chat)
    turn = chat.say(selection={"action": "pay_confirm", "action_id": "act_other", "code": CODE})
    assert turn.intent == "stale" and fake.bodies("/api/actions/confirm") == []


def test_expired_and_locked_codes(make_chat):
    f = FakeTend()
    chat = make_chat(f)
    to_payment(chat)
    for _ in range(4):
        assert "does not match" in text_of(chat.say("000000"))
    assert "locked" in text_of(chat.say("000000")) and "pending" not in chat.state

    chat.say("pay the bill")
    f.actions[chat.state["pending"]["action_id"]]["expires"] = f.now - dt.timedelta(seconds=1)  # the server's clock ran out
    assert "expired" in text_of(chat.say(CODE))


def test_pending_payment_expires_locally(chat, fake):
    to_payment(chat)
    chat.state["pending"]["expires_at"] = "2020-01-01T00:00:00Z"
    turn = chat.say(CODE)
    assert turn.intent == "pay_stale" and "expired" in text_of(turn) and fake.bodies("/api/actions/confirm") == []
    assert "no payment waiting" in text_of(chat.say(CODE))


def test_continue_during_a_payment_only_reminds(chat, fake):
    to_payment(chat)
    assert chat.say("continue").intent == "pay_remind" and fake.bodies("/api/actions/confirm") == []


def test_a_confirm_whose_answer_is_lost_is_never_called_failed(chat, fake):
    to_payment(chat)
    fake.lose_answer.add("/api/actions/confirm")  # the API takes the code and pays, then its answer is lost
    turn = chat.say(CODE)
    assert "can't tell yet whether the payment went through" in text_of(turn) and "no money moved" not in text_of(turn).lower()
    assert chat.state["pending"]["unsure"] is True
    turn = chat.say("check the payment")
    assert turn.intent == "pay_status" and "**Done.** Paid $118.00" in text_of(turn) and "pending" not in chat.state
    assert len(fake.bodies("/api/actions/confirm")) == 1


def test_status_while_the_bank_is_still_working_and_after_a_lost_code(chat, fake):
    to_payment(chat)
    action_id = chat.state["pending"]["action_id"]
    chat.state["pending"]["unsure"] = True
    fake.actions[action_id]["status"] = "executing"
    assert "still going through" in text_of(chat.say("check the payment")) and chat.state["pending"]["unsure"] is True
    fake.actions[action_id]["status"] = "proposed"  # the code never reached the API
    turn = chat.say("did it go through?")
    assert "Nothing has moved yet" in text_of(turn) and chat.state["pending"]["unsure"] is False
    assert chat.say(CODE).intent == "pay_confirm" and chat.state["demo"]["paid_cents"] == 11800


def test_skip_counting(chat, fake):
    chat.say("demo")
    turn = chat.say("not now")
    assert turn.intent == "skip" and fake.bodies("/api/claim") == []


def test_demo_in_another_state_uses_that_states_law(chat, fake):
    chat.say("show me the demo in Texas")
    assert fake.bodies("/api/scan")[0] == {"persona_id": "rowan-tx", "st": "TX"}
    chat.say("demo for Ohio")
    assert fake.bodies("/api/scan")[1] == {"persona_id": "rowan-mi", "st": "OH"}


# ---------------------------------------------------------------- the packet, sealed for an advocate


def test_share_makes_a_link_only_the_advocate_can_open(chat, fake):
    to_payment(chat)
    chat.say(CODE)
    turn = chat.say("share with an advocate")
    assert turn.intent == "share" and turn.replies[0].end_session and turn.replies[0].card.kind == "detail"
    text = text_of(turn)
    link = next(word for word in text.split() if word.startswith(f"{SITE}/share#"))
    share_id, key = link.split("#", 1)[1].split(".")
    stored = fake.shares[share_id]
    # The API got ciphertext and an IV, never the key, and the agent kept neither.
    assert key not in json.dumps(fake.calls) and set(fake.bodies("/api/shares")[0]) == {"ciphertext", "iv", "alg", "expires_hours", "once"}
    assert key not in json.dumps(chat.state) and share_id not in json.dumps(chat.state)
    packet = open_sealed(stored["ciphertext"], stored["iv"], key)
    assert (
        packet["st"] == "MI" and packet["output"]["totals"]["allowed_cents"] == 400800 and packet["output"]["totals"]["held_cents"] == 32500
    )
    assert "Fictional demo claim for Rowan Hale" in packet["notes"] and "$118.00" in packet["notes"]
    assert all(i["item_id"] in {ln["item_id"] for ln in packet["output"]["lines"]} for i in packet["input"]["items"])
    assert any("description" in i for i in packet["input"]["items"])  # the text travels only inside the ciphertext
    assert (
        "**Still needed** (from Michigan's rules)" in text
        and "**Where to file:**" in text
        and "MDHHS-MichiganCrimeVictim@Michigan.gov" in text
    )
    assert (
        "Michigan's own application with safe fields only" in text
        and "**Amount Rowan Hale can ask for: $4,008.00. The program decides.**" in text
    )


def test_share_needs_a_counted_claim(chat, fake):
    assert "no claim to share" in text_of(chat.say("share with an advocate"))
    chat.say("demo")
    assert "Count the demo claim first" in text_of(chat.say("make the link for an advocate"))
    assert fake.bodies("/api/shares") == []


def test_share_button_after_counting(chat, fake):
    chat.say("demo")
    chat.say("yes")
    turn = chat.say(selection={"action": "share"})
    assert turn.intent == "share" and len(fake.shares) == 1


# ---------------------------------------------------------------- trouble


def test_api_down_says_so_and_moves_nothing(make_chat):
    f = FakeTend(down=True)
    turn = make_chat(f).say("What is the deadline to apply in Michigan?")
    assert "I can't reach Tend's server right now" in text_of(turn) and turn.intent == "api_error"


def test_coverage_and_thanks(chat):
    assert "51 jurisdictions" in text_of(chat.say("which states do you cover?"))
    assert chat.say("thanks").intent == "thanks"


def test_while_a_payment_is_unsure_nothing_new_starts_and_nothing_says_no_money_moved(chat, fake):
    # Review fix: after a lost answer the old code allowed a second payment (the Pay button, a new demo, or cancel
    # then pay) and told the person "Cancelled. No money moved." although the first payment had gone through.
    to_payment(chat)
    fake.lose_answer.add("/api/actions/confirm")
    chat.say(CODE)
    assert chat.state["pending"]["unsure"] is True
    scans = len(fake.bodies("/api/scan"))
    for turn in (
        chat.say(selection={"action": "pay"}),
        chat.say("pay the bill"),
        chat.say("show me the demo claim"),
        chat.say(selection={"action": "demo"}),
        chat.say("cancel"),
        chat.say(selection={"action": "pay_cancel"}),
        chat.say(cancelled=True),
    ):
        said = text_of(turn)
        assert "can't tell yet whether the last payment went through" in said and "no money moved" not in said.lower()
    assert chat.state["pending"]["unsure"] is True
    assert len(fake.bodies("/api/actions/propose")) == 1 and len(fake.bodies("/api/scan")) == scans
    turn = chat.say("check the payment")
    assert "**Done.** Paid $118.00" in text_of(turn) and "pending" not in chat.state
    assert sum(a["status"] == "done" for a in fake.actions.values()) == 1


def test_a_deadline_that_counts_from_a_report_only_for_children_says_so(chat, fake):
    # Review fix: MI counts from the report only when police records show the victim was under 18 (MCL 18.355(2)(a)).
    # The Check and the demo claim used to tell everyone "The law counts from your report, so you may have longer."
    check = text_of(chat.say("check Michigan, June 14 2026, had an exam, not reported"))
    chat.say("demo")
    claim = text_of(chat.say("yes"))
    for said in (check, claim):
        assert "counts from your report" not in said
        assert "In one case Michigan's law counts from the police report instead ([MCL 18.355(2)(a)]" in said
        assert "victim was under 18" in said


def test_report_note_for_a_state_whose_main_deadline_counts_from_the_report():
    from tend_agent.knowledge import RuleBook, report_note

    nd = {
        "jurisdiction": "ND",
        "name": "North Dakota",
        "rules": [{"id": "ND-1", "category": "filing_deadline", "params": {"years": 1, "from": "report"}}],
    }
    assert report_note(RuleBook(nd)).endswith("The law counts from the police report, so you may have longer.")
    assert "ask the program" in report_note(None)
