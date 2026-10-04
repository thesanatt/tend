"""ASI:One delivers a card click as text: the agent's @address, then the selection as JSON."""

from tend_agent.parse import selection_from_text

ADDR = "@agent1qdrzjgcqsm9n7l4jx5lgjrg5syxz9qqf02xqpt6ux4mvkc8flrlw2vqezts"


def test_click_after_the_address_is_a_selection():
    got = selection_from_text(f'{ADDR} {{"action":"count_costs","scan_id":"scan_1","approved":true}}')
    assert got == {"action": "count_costs", "scan_id": "scan_1", "approved": True}


def test_form_submit_keeps_its_fields():
    got = selection_from_text(f'{ADDR} {{"code":"506200","action":"pay_confirm","action_id":"act_1","approved":true}}')
    assert got["action"] == "pay_confirm" and got["code"] == "506200"


def test_no_on_a_review_card_maps_to_its_reject_action():
    assert selection_from_text(f'{ADDR} {{"action":"count_costs","approved":false}}')["action"] == "skip_costs"
    assert selection_from_text(f'{ADDR} {{"action":"pay_approve","action_id":"a","approved":false}}')["action"] == "pay_cancel"


def test_plain_text_is_not_a_selection():
    assert selection_from_text(f"{ADDR} Show me the demo claim") is None
    assert selection_from_text("what does Michigan cover?") is None
