"""rules/tools/verify.py refuses what it should: a quote that is not in the saved source, a number that is
not in the quote, a source file that changed after it was saved. Each test builds one small made-up
jurisdiction in a temporary folder, so nothing under rules/ is read or written.

run from the repo root: uv run --with pytest pytest rules/tools/test_verify.py
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verify_under_test", TOOLS / "verify.py")
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)

PAGE = (
    "<html><head><title>Made-up statute</title></head><body>"
    "<p>A claim must be filed within three years of the crime.</p>"
    "<p>The maximum award is $25,000. Counseling is paid at $12.50 for each quarter hour, under section 18.68.</p>"
    "<p>A provider SHALL NOT bill the victim for the examination.</p>"
    "</body></html>"
)
TEXT = (
    "A claim must be filed within three years of the crime. "
    "The maximum award is $25,000. Counseling is paid at $12.50 for each quarter hour, under section 18.68. "
    "A provider SHALL NOT bill the victim for the examination."
)
DEADLINE = {
    "id": "ZZ-DEADLINE-1",
    "category": "filing_deadline",
    "params": {"years": 3},
    "summary": "File within 3 years of the crime.",
    "quote": "A claim must be filed within three years of the crime.",
    "source_id": "ZZ-S1",
    "pinpoint": "Made-up Code 1.1",
}


@pytest.fixture
def tree(tmp_path, monkeypatch):
    """A repo root with one saved source, and a function that writes ZZ.json with the given rules."""
    monkeypatch.setattr(V, "ROOT", tmp_path)
    src = tmp_path / "rules" / "sources" / "ZZ"
    src.mkdir(parents=True)
    (src / "ZZ-S1.html").write_text(PAGE, encoding="utf-8")
    (src / "ZZ-S1.txt").write_text(TEXT, encoding="utf-8")
    (tmp_path / "rules" / "jurisdictions").mkdir()

    def write(*rules, **top):
        data = {
            "jurisdiction": "ZZ",
            "name": "Made-up State",
            "program": {},
            "sources": [
                {
                    "id": "ZZ-S1",
                    "url": "https://example.test/statute",
                    "raw_path": "rules/sources/ZZ/ZZ-S1.html",
                    "text_path": "rules/sources/ZZ/ZZ-S1.txt",
                    "sha256": hashlib.sha256(PAGE.encode()).hexdigest(),
                }
            ],
            "rules": list(rules),
            "coverage": {},
            "confidence": "high",
        }
        data.update(top)
        (tmp_path / "rules" / "jurisdictions" / "ZZ.json").write_text(json.dumps(data), encoding="utf-8")
        return tmp_path

    return write


def rule(**over):
    return {**DEADLINE, **over}


def errors_for(tree, *rules, **top):
    tree(*rules, **top)
    errors, _warnings, _data = V.check("ZZ")
    return errors


def test_a_rule_whose_quote_and_numbers_are_in_the_source_passes(tree):
    tree(DEADLINE)
    errors, warnings, data = V.check("ZZ")
    assert errors == [] and warnings == []
    assert data["rules"][0]["fragment_url"].startswith("https://example.test/statute#:~:text=")


def test_a_quote_with_one_word_changed_is_refused(tree):
    errors = errors_for(tree, rule(quote="A claim must be filed within three years of the offense."))
    assert len(errors) == 1 and "not a verbatim substring" in errors[0]


def test_a_quote_stitched_from_two_sentences_is_refused(tree):
    errors = errors_for(tree, rule(quote="A claim must be filed within three years. The maximum award is $25,000."))
    assert len(errors) == 1 and "not a verbatim substring" in errors[0]


def test_curly_quotes_dashes_and_line_breaks_in_a_quote_do_not_matter(tree):
    root = tree(rule(quote="A claim must be filed\nwithin three years   of the crime."))
    assert V.check("ZZ")[0] == []
    (root / "rules" / "sources" / "ZZ" / "ZZ-S1.txt").write_text(TEXT.replace("three years", "three" + chr(160) + "years"), encoding="utf-8")
    assert V.check("ZZ")[0] == []


def test_a_quote_that_matches_only_when_case_is_ignored_passes_with_a_warning(tree):
    tree(rule(id="ZZ-EXAM-1", category="exam_no_bill", params={}, summary="A provider may not bill the victim for the exam.", quote="A provider shall not bill the victim for the examination."))
    errors, warnings, _ = V.check("ZZ")
    assert errors == []
    assert warnings == ["ZZ-EXAM-1: quote matches only case-insensitively"]


def test_a_source_file_changed_after_it_was_saved_is_refused(tree):
    root = tree(DEADLINE)
    (root / "rules" / "sources" / "ZZ" / "ZZ-S1.html").write_text(PAGE.replace("three", "five"), encoding="utf-8")
    assert V.check("ZZ")[0] == ["ZZ-S1: sha256 does not match rules/sources/ZZ/ZZ-S1.html"]


def test_a_missing_snapshot_file_is_refused(tree):
    root = tree(DEADLINE)
    (root / "rules" / "sources" / "ZZ" / "ZZ-S1.txt").unlink()
    errors = V.check("ZZ")[0]
    assert any("snapshot files missing" in e for e in errors)
    assert any("source ZZ-S1 not found or not saved" in e for e in errors)


def test_a_number_in_params_that_the_quote_does_not_say_is_refused(tree):
    assert errors_for(tree, rule(params={"years": 5}, summary="File within 3 years.")) == ["ZZ-DEADLINE-1: params.years=5 does not appear in the quote"]


def test_a_number_in_the_summary_that_the_quote_does_not_say_is_refused(tree):
    assert errors_for(tree, rule(summary="File within 3 years, or 5 for a minor.")) == ["ZZ-DEADLINE-1: summary number 5 is not in the quote"]


def test_an_amount_is_read_as_dollars(tree):
    cap = rule(id="ZZ-CAP-1", category="total_cap", params={"amount_cents": 2500000}, summary="The most the program pays is $25,000.", quote="The maximum award is $25,000.")
    assert errors_for(tree, cap) == []
    assert errors_for(tree, {**cap, "params": {"amount_cents": 250000}}) == ["ZZ-CAP-1: params.amount_cents=250000 does not appear in the quote"]


def test_an_amount_with_cents_needs_the_cents_in_the_quote(tree):
    quote = "Counseling is paid at $12.50 for each quarter hour, under section 18.68."
    rate = rule(id="ZZ-CAP-2", category="expense_cap", expense="counseling", params={"amount_cents": 1250}, summary="Counseling is paid at $12.50 a quarter hour.", quote=quote)
    assert errors_for(tree, rate) == []
    # $12.99 is not in a quote that says $12.50, though both start with 12.
    assert errors_for(tree, {**rate, "params": {"amount_cents": 1299}}) == ["ZZ-CAP-2: params.amount_cents=1299 does not appear in the quote"]
    assert errors_for(tree, {**rate, "params": {"amount_cents": 1200}}) == ["ZZ-CAP-2: params.amount_cents=1200 does not appear in the quote"]


def test_a_decimal_in_the_quote_is_not_its_whole_part(tree):
    quote = "Counseling is paid at $12.50 for each quarter hour, under section 18.68."
    # 18 years is not what "section 18.68" says, and a summary's "12" is not the quote's "12.50".
    wrong = rule(id="ZZ-CAP-3", category="expense_cap", expense="counseling", params={"years": 18}, summary="Counseling is paid for 12 sessions.", quote=quote)
    assert errors_for(tree, wrong) == [
        "ZZ-CAP-3: params.years=18 does not appear in the quote",
        "ZZ-CAP-3: summary number 12 is not in the quote",
    ]


def test_numbers_are_read_from_digits_and_from_words():
    assert V.numbers_in("within 180 days, up to $25,000.00 or 66.5 percent") == {180, 25000, 66.5}
    assert V.numbers_in("thirty days") == {30}
    assert V.numbers_in("one hundred eighty days") == {180}
    assert V.numbers_in("twenty-five thousand dollars") == {25000}
    assert V.numbers_in("two thousand five hundred dollars and forty-five days") == {2500, 45}
    assert V.numbers_in("no number here") == set()
    assert V.numbers_in("section 18.68.040") == {18.68, 40}


def test_money_matches_whole_dollars_and_exact_cents():
    assert V.money_in_quote(2500000, V.numbers_in("$25,000"))
    assert V.money_in_quote(2500000, V.numbers_in("twenty-five thousand dollars"))
    assert V.money_in_quote(1250, V.numbers_in("$12.50"))
    assert V.money_in_quote(1200, V.numbers_in("$12.00"))
    assert not V.money_in_quote(1299, V.numbers_in("$12"))
    assert not V.money_in_quote(1200, V.numbers_in("$12.50"))


def test_a_rule_missing_its_basics_is_refused(tree):
    errors = errors_for(
        tree,
        DEADLINE,
        rule(),  # the same id again
        rule(id="ZZ-X-1", category="made_up"),
        rule(id="ZZ-X-2", expense="yachts"),
        rule(id="ZZ-X-3", pinpoint=""),
        rule(id="ZZ-X-4", quote="  "),
        rule(id="ZZ-X-5", source_id="ZZ-S9"),
    )
    assert errors == [
        "duplicate rule id ZZ-DEADLINE-1",
        "ZZ-X-1: unknown category made_up",
        "ZZ-X-2: unknown expense yachts",
        "ZZ-X-3: missing pinpoint citation",
        "ZZ-X-4: empty quote",
        "ZZ-X-5: source ZZ-S9 not found or not saved",
    ]


def test_a_file_missing_a_top_level_key_or_named_for_another_state_is_refused(tree):
    tree(DEADLINE, jurisdiction="YY")
    assert V.check("ZZ")[0] == ["jurisdiction is YY, file is ZZ"]
    root = tree(DEADLINE)
    path = root / "rules" / "jurisdictions" / "ZZ.json"
    data = json.loads(path.read_text())
    del data["coverage"]
    path.write_text(json.dumps(data))
    assert V.check("ZZ")[0] == ["missing top-level key: coverage"]
    path.write_text("{not json")
    assert V.check("ZZ")[0][0].startswith("invalid JSON")
    assert "missing" in V.check("QQ")[0][0]


def run_main(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["verify.py", *argv])
    with pytest.raises(SystemExit) as stop:
        V.main()
    return stop.value.code


def test_only_a_passing_file_is_written_to_verified(tree, monkeypatch, capsys):
    root = tree(DEADLINE)
    assert run_main(monkeypatch, "zz") == 0
    assert "ZZ PASS (1 rules, 1 sources)" in capsys.readouterr().out
    out = root / "rules" / "verified" / "ZZ.json"
    written = json.loads(out.read_text())
    assert written["rules"][0]["quote"] == DEADLINE["quote"]
    assert "fragment_url" in written["rules"][0]

    # A later failing run leaves the last passing file as it was and exits non-zero.
    before = out.read_bytes()
    tree(rule(params={"years": 5}))
    assert run_main(monkeypatch, "all") == 1
    assert "ZZ FAIL ZZ-DEADLINE-1: params.years=5 does not appear in the quote" in capsys.readouterr().out
    assert out.read_bytes() == before
