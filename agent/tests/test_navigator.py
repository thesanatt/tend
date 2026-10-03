from __future__ import annotations

import datetime as dt
import json

from conftest import text_of
from fake_api import CODE, LINK_CODE, FakeTend

STORY = "my ex boyfriend attacked me at his apartment and I want to know if I can get my therapy paid for"


def test_greeting_gets_the_menu_and_card(chat):
    turn = chat.say("hi")
    assert "Tend Navigator" in text_of(turn) and "never need to tell me what happened" in text_of(turn)
    assert turn.replies[0].card is not None and not turn.replies[0].end_session


def test_question_falls_back_to_verified_rules_when_the_api_has_no_answer_route(chat, fake):
    turn = chat.say("What is the deadline in Michigan?")
    text = text_of(turn)
    assert "MCL 18.355(2)" in text and "not later than 5 years" in text and "legislature.mi.gov" in text
    assert turn.replies[0].end_session
    assert "/api/agent/answer" not in fake.paths()  # OpenAPI said the route is not there, so no blind call


def test_question_uses_the_answer_route_with_discovered_field_names(make_chat):
    f = FakeTend(answer_fields=("q", "jurisdiction"))
    chat = make_chat(f)
    turn = chat.say("Can the hospital in Michigan bill me for the exam?")
    assert f.bodies("/api/agent/answer") == [{"q": "Can the hospital in Michigan bill me for the exam?", "jurisdiction": "MI"}]
    text = text_of(turn)
    assert text.startswith("Michigan does not let a provider bill you") and "MCL 18.355a(2)" in text and '> "A health care provider' in text


def test_answer_route_saying_unknown_is_shown_as_i_dont_know(make_chat):
    f = FakeTend(
        answer_fields=("question", "st"), answer_reply={"answer": "", "known": False, "citations": [], "program": {"phone": "877-251-7373"}}
    )
    turn = make_chat(f).say("Does Michigan pay for pet care?")
    assert text_of(turn).startswith("I don't know. No verified rule in Michigan answers that.") and "877-251-7373" in text_of(turn)


def test_answer_route_with_nested_reply_and_rule_ids(make_chat):
    f = FakeTend(
        answer_fields=("question", "st"),
        answer_reply={"result": {"text": "Michigan covers counseling.", "rule_ids": ["MI-COV-2", "MI-CAP-3", "NOT-A-RULE"]}},
    )
    turn = make_chat(f).say("Does Michigan cover counseling?")
    text = text_of(turn)
    assert text.startswith("Michigan covers counseling.")
    assert "MCL 18.361(2)(b)" in text and "$125.00 per hourly session" in text  # ids became quotes and links
    assert "NOT-A-RULE" not in text


def test_api_answer_error_falls_back_to_rules(make_chat):
    f = FakeTend(answer_fields=("question", "st"))
    f.route_orig = f.route

    def broken(method, path, body, request):
        if path == "/api/agent/answer":
            return 500, {"detail": "model unavailable"}
        return f.route_orig(method, path, body, request)

    f.route = broken  # type: ignore[method-assign]
    turn = make_chat(f).say("What is the deadline in Michigan?")
    assert "MCL 18.355(2)" in text_of(turn)


def test_question_without_a_state_asks_for_one_and_keeps_only_the_topic(chat):
    turn = chat.say("Do I need a police report?")
    assert "Which state" in text_of(turn)
    assert chat.state["awaiting"] == {"kind": "question", "topics": ["reporting"], "expense": None}
    assert "police report?" not in json.dumps(chat.state)  # the words themselves are not kept
    turn = chat.say("Michigan")
    assert "police report" in text_of(turn) and "MCL 18.355a(10)" in text_of(turn)


def test_follow_up_question_reuses_the_state(chat):
    chat.say("What is the deadline in Michigan?")
    turn = chat.say("what about counseling?")
    assert "**counseling**" in text_of(turn) and "$125 a session" in text_of(turn)


def test_story_is_never_passed_on(make_chat):
    f = FakeTend(answer_fields=("question", "st"))
    chat = make_chat(f)
    turn = chat.say(STORY)
    assert text_of(turn).startswith("You don't need to tell me what happened")
    assert "Which state" in text_of(turn)
    turn = chat.say("Michigan")
    sent = json.dumps(f.calls)
    assert "boyfriend" not in sent and "apartment" not in sent and "attacked" not in sent
    assert f.bodies("/api/agent/answer")[0]["question"].startswith("Does Michigan's crime victim compensation program cover counseling")
    assert "boyfriend" not in json.dumps(chat.state)


def test_story_with_state_answers_from_the_topic_only(make_chat):
    f = FakeTend(answer_fields=("question", "st"))
    turn = make_chat(f).say("He grabbed me at his house in Michigan, does the state pay for therapy?")
    assert text_of(turn).startswith("You don't need to tell me what happened")
    assert all("grabbed" not in json.dumps(b) for b in f.bodies("/api/agent/answer"))


def test_story_with_check_details_runs_the_check_on_fields_only(chat, fake):
    turn = chat.say("He drugged me at a party in Ohio on June 14, 2026. Can I still apply? I had an exam")
    assert turn.intent == "check" and text_of(turn).startswith("You don't need to tell me what happened")
    assert "party" not in json.dumps(fake.calls) and "drugged" not in json.dumps(fake.calls)
    call = next(c for c in fake.calls if c["path"] == "/api/agent/checklist/OH")
    assert call["params"] == {"police_report": "unknown", "incident_date": "2026-06-14", "forensic_exam": "true"}


def test_check_by_text_uses_the_checklist_when_there_is_no_check_route(chat, fake):
    turn = chat.say("check MI 2026-06-14 exam yes report no")
    text = text_of(turn)
    assert text.startswith("**You can likely apply in Michigan.**")
    assert "apply by **June 14, 2031**" in text and turn.replies[0].end_session
    call = next(c for c in fake.calls if c["path"] == "/api/agent/checklist/MI")
    assert call["params"] == {"police_report": "no", "incident_date": "2026-06-14", "forensic_exam": "true"}
    assert "2026-06-14" not in json.dumps(chat.state)  # the date is not kept


def test_check_route_is_used_when_present(make_chat):
    f = FakeTend(check_fields=("jurisdiction", "date", "exam", "report"))
    make_chat(f).say("run a check for Michigan, June 14 2026, had an exam")
    assert f.bodies("/api/agent/check") == [{"jurisdiction": "MI", "date": "2026-06-14", "exam": True, "report": "unknown"}]


def test_check_without_state_sends_the_form_then_runs(chat, fake):
    turn = chat.say("can I apply? I had an exam")
    assert turn.intent == "check_form" and turn.replies[0].card is not None
    turn = chat.say("Ohio")
    assert turn.intent == "check" and "Ohio" in text_of(turn)
    call = next(c for c in fake.calls if c["path"] == "/api/agent/checklist/OH")
    assert call["params"]["forensic_exam"] == "true"


def test_check_form_card_submission(chat, fake):
    chat.say(selection={"action": "check_form"})
    turn = chat.say(
        selection={"action": "check", "st": "MI", "incident_date": "2026-06-14", "forensic_exam": "not_sure", "police_report": "not_yet"}
    )
    assert "Michigan" in text_of(turn)
    call = next(c for c in fake.calls if c["path"] == "/api/agent/checklist/MI")
    assert call["params"] == {"police_report": "no", "incident_date": "2026-06-14"}  # not sure is sent as nothing


def test_check_form_future_and_unreadable_dates(chat):
    assert text_of(chat.say(selection={"action": "check", "st": "MI", "incident_date": "2027-02-01"})).startswith(
        "That date is in the future"
    )
    assert text_of(chat.say(selection={"action": "check", "st": "MI", "incident_date": "last spring"})).startswith(
        "I couldn't read that date"
    )
    assert chat.say(selection={"action": "check", "st": "ZZ"}).intent == "check_form"


def test_demo_payment_happens_only_after_the_typed_code(chat, fake):
    turn = chat.say("show me the demo claim")
    assert turn.intent == "demo" and "Fictional" in text_of(turn) and turn.replies[0].card is not None
    assert "Clearwater" not in json.dumps(chat.state)  # merchant text is not kept

    turn = chat.say("yes")
    assert turn.intent == "count"
    assert "**Amount Rowan Hale can ask for: $2,760.00. The program decides.**" in text_of(turn)
    assert "**Don't pay this line:** forensic exam, $325.00" in text_of(turn)
    claim_body = fake.bodies("/api/claim")[0]
    assert all(i["confirmed"] is True and "description" not in i for i in claim_body["items"])

    turn = chat.say("pay the bill")
    assert turn.intent == "pay_propose"
    assert fake.bodies("/api/actions/propose") == [
        {
            "kind": "pay_bill",
            "bill_id": "c1398337-ac9d-4216-a449-ab7ac2a9e9b4",
            "item_ids": ["bill:231c5c86178943f9:1", "bill:231c5c86178943f9:3"],
            "amount_cents": 11800,
            "from_account_id": "8ff7e76a-0d1a-4327-b13d-4a8ffa529434",
            "payee": "Riverbend General Hospital",
        }
    ]
    assert CODE in text_of(turn) and turn.replies[0].card is not None
    assert CODE not in json.dumps(chat.state)  # the agent forgets the code; only the person can type it back

    for nudge in ("yes", "approve", "pay it"):
        assert chat.say(nudge).intent == "pay_remind"
    assert fake.bodies("/api/actions/confirm") == []  # nothing confirmed without the code

    turn = chat.say("111111")
    assert "does not match" in text_of(turn) and "pending" in chat.state

    turn = chat.say(CODE)
    assert turn.intent == "pay_confirm"
    assert fake.bodies("/api/actions/confirm")[-1] == {"action_id": "act_00000000000000000001", "confirm_code": CODE}
    text = text_of(turn)
    assert text.startswith("**Done.** Paid $118.00") and "aud_000004" in text and "$325.00, stays unpaid" in text
    assert "pending" not in chat.state

    turn = chat.say(CODE)
    assert turn.intent == "pay_stale" and len(fake.bodies("/api/actions/confirm")) == 2
    assert "already paid" in text_of(chat.say("pay the bill"))


def test_review_card_buttons_lead_to_the_code_box(chat, fake):
    chat.say(selection={"action": "demo"})
    chat.say(selection={"action": "count_costs", "scan_id": chat.state["demo"]["scan_id"]})
    chat.say("pay the bill")
    action_id = chat.state["pending"]["action_id"]
    turn = chat.say(selection={"action": "pay_approve", "action_id": action_id})
    assert turn.intent == "pay_code_form" and turn.replies[0].card is not None
    assert fake.bodies("/api/actions/confirm") == []
    turn = chat.say(selection={"action": "pay_confirm", "action_id": action_id, "code": CODE})
    assert turn.intent == "pay_confirm" and text_of(turn).startswith("**Done.**")


def test_planner_prose_with_the_code_confirms(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    turn = chat.say(f"The user entered code {CODE} and clicked Pay $118.00")
    assert turn.intent == "pay_confirm" and fake.bodies("/api/actions/confirm")[0]["confirm_code"] == CODE


def test_cancel_moves_nothing(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    turn = chat.say("cancel")
    assert "No money moved" in text_of(turn) and "pending" not in chat.state
    assert chat.say(CODE).intent == "pay_stale"
    assert fake.bodies("/api/actions/confirm") == []


def test_a_question_during_a_payment_does_not_cancel_or_pay(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    turn = chat.say("Does the program stop paying after a year in Michigan?")
    assert turn.intent == "answer" and "pending" in chat.state
    assert chat.say(CODE).intent == "pay_confirm"


def test_card_cancel_button_and_dismiss(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    action_id = chat.state["pending"]["action_id"]
    assert chat.say(selection={"action": "pay_cancel", "action_id": action_id}).intent == "pay_cancel"
    chat.say("pay the bill")
    turn = chat.say(cancelled=True)
    assert text_of(turn) == "Cancelled. No money moved." and fake.bodies("/api/actions/confirm") == []


def test_stale_card_click_is_refused(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    turn = chat.say(selection={"action": "pay_confirm", "action_id": "act_other", "code": CODE})
    assert turn.intent == "stale" and fake.bodies("/api/actions/confirm") == []


def test_expired_and_locked_codes(make_chat):
    f = FakeTend()
    chat = make_chat(f)
    chat.say("demo")
    chat.say("pay the bill")
    for _ in range(4):
        assert "does not match" in text_of(chat.say("000000"))
    assert "locked" in text_of(chat.say("000000")) and "pending" not in chat.state

    chat.say("pay the bill")
    f.now = f.now - dt.timedelta(minutes=30)  # the server's clock says this code has run out
    f.actions[chat.state["pending"]["action_id"]]["expires"] = f.now
    assert "expired" in text_of(chat.say(CODE))


def test_pending_payment_expires_locally(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    chat.state["pending"]["expires_at"] = "2020-01-01T00:00:00Z"
    turn = chat.say(CODE)
    assert turn.intent == "pay_stale" and "expired" in text_of(turn) and fake.bodies("/api/actions/confirm") == []
    assert "no payment waiting" in text_of(chat.say(CODE))


def test_continue_during_a_payment_only_reminds(chat, fake):
    chat.say("demo")
    chat.say("pay the bill")
    assert chat.say("continue").intent == "pay_remind" and fake.bodies("/api/actions/confirm") == []


def test_skip_counting(chat, fake):
    chat.say("demo")
    turn = chat.say("not now")
    assert turn.intent == "skip" and fake.bodies("/api/claim") == []


def test_demo_in_another_state_uses_that_states_law(chat, fake):
    chat.say("show me the demo in Texas")
    assert fake.bodies("/api/scan")[0] == {"persona_id": "rowan-tx", "st": "TX"}
    chat.say("demo for Ohio")
    assert fake.bodies("/api/scan")[1] == {"persona_id": "rowan-mi", "st": "OH"}


def test_linked_claim_walkthrough(chat, fake):
    turn = chat.say(f"link {LINK_CODE.lower()}")
    text = text_of(turn)
    assert text.startswith("**Amount you can ask for: $2,760.00. The program decides.**")
    assert "http://tend.test/api/share/abc/packet.pdf" in text and "Don't pay this line" in text
    assert "tok-1" not in json.dumps(chat.state)  # the session token is not kept
    assert "not valid" in text_of(chat.say("link AAAA-BBBB"))


def test_api_down_says_so_and_moves_nothing(make_chat):
    f = FakeTend(down=True)
    turn = make_chat(f).say("What is the deadline in Michigan?")
    assert text_of(turn).startswith("I can't reach Tend's server right now") and turn.intent == "api_error"


def test_coverage_and_thanks(chat):
    assert "51 jurisdictions" in text_of(chat.say("which states do you cover?"))
    assert chat.say("thanks").intent == "thanks"
