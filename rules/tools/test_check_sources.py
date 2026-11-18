"""rules/tools/check_sources.py puts a source in the right group: same bytes, new markup around the same
sentence, a quoted sentence with one word changed, a url that does not answer. The pages are the files in
fixtures/check_sources/, a made-up statute; each test saves one as a source of a made-up jurisdiction in a
temporary folder and answers the request from another file. No request leaves the machine, and nothing
under rules/ is read or written.

run from the repo root: uv run --no-project --with pytest --with beautifulsoup4 pytest rules/tools/test_check_sources.py
"""
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import urllib.error
from email.message import Message
from pathlib import Path

import pytest

pytest.importorskip("bs4")

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))  # check_sources.py imports fetch_source and verify from its own folder
spec = importlib.util.spec_from_file_location("check_sources_under_test", TOOLS / "check_sources.py")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)

FIXTURES = TOOLS / "fixtures" / "check_sources"
SAVED = (FIXTURES / "saved.html").read_bytes()
MARKUP_CHANGED = (FIXTURES / "markup_changed.html").read_bytes()
WORD_CHANGED = (FIXTURES / "word_changed.html").read_bytes()
CHALLENGE = (FIXTURES / "challenge.html").read_bytes()
HTML = "text/html; charset=utf-8"
URL = "https://statutes.example.test/code/1.1"

DEADLINE = {
    "id": "ZZ-DEADLINE-1",
    "category": "filing_deadline",
    "params": {"years": 3},
    "summary": "File within 3 years of the crime.",
    "quote": "A claim must be filed within three years of the crime.",
    "source_id": "ZZ-S1",
    "pinpoint": "Made-up Code 1.1(2)",
}
CAP = {
    "id": "ZZ-CAP-1",
    "category": "total_cap",
    "params": {"amount_cents": 2500000},
    "summary": "The most the program pays is $25,000.",
    "quote": "The maximum award is $25,000 for each claim.",
    "source_id": "ZZ-S1",
    "pinpoint": "Made-up Code 1.1(3)",
}


class Web:
    """Stands in for the network: a url answers with (bytes, content type), or raises the error it was
    given. A list is one answer for each request in turn, and the last one from then on."""

    def __init__(self, answers: dict):
        self.answers = {url: list(a) if isinstance(a, list) else [a] for url, a in answers.items()}
        self.asked = []

    def __call__(self, url):
        self.asked.append(url)
        left = self.answers[url]
        answer = left.pop(0) if len(left) > 1 else left[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


def http_error(code: int, reason: str) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(URL, code, reason, Message(), io.BytesIO(b""))


@pytest.fixture
def root(tmp_path, monkeypatch):
    """An empty repo root, and a separate folder that stands in for the system's temporary folder."""
    repo, scratch = tmp_path / "repo", tmp_path / "scratch"
    repo.mkdir()
    scratch.mkdir()
    monkeypatch.setattr(C, "ROOT", repo)
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    # main() refuses to start without certifi and pdftotext, which a test that fetches nothing does not need.
    monkeypatch.setattr(C, "not_ready", lambda: "")
    return repo


def save(root, sid, raw, url=URL, drop=None, ext="html", text=None):
    """Save a source under root as fetch_source.py does, and return its entry for the jurisdiction file."""
    folder = root / "rules" / "sources" / "ZZ"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{sid}.{ext}").write_bytes(raw)
    if text is None:
        text = C.F.html_to_text(raw, drop or C.F.DROP_TAGS)
    (folder / f"{sid}.txt").write_text(text, encoding="utf-8")
    return {
        "id": sid,
        "title": "Made-up Code 1.1",
        "url": url,
        "kind": "statute",
        "retrieved_at": "2026-10-03T00:00:00Z",
        "raw_path": f"rules/sources/ZZ/{sid}.{ext}",
        "text_path": f"rules/sources/ZZ/{sid}.txt",
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def write(root, sources, rules):
    folder = root / "rules" / "jurisdictions"
    folder.mkdir(parents=True, exist_ok=True)
    data = {"jurisdiction": "ZZ", "name": "Made-up State", "program": {}, "sources": sources, "rules": rules, "coverage": {}, "confidence": "high"}
    (folder / "ZZ.json").write_text(json.dumps(data), encoding="utf-8")


def one_source(root, rules=(DEADLINE, CAP), **how):
    write(root, [save(root, "ZZ-S1", SAVED, **how)], list(rules))


def check(answer, **kw):
    """Run the check on ZZ with every request answered the same way, and no waiting."""
    web = Web({URL: answer})
    return C.run(["ZZ"], get=web, wait=lambda seconds: None, **kw), web


def files_under(folder):
    return {str(p.relative_to(folder)): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}


def test_the_saved_page_is_long_enough_to_be_a_page():
    # Under 600 characters fetch_source.py calls a page blocked, and every test below would mean less.
    assert len(C.F.html_to_text(SAVED)) > 600
    assert C.F.text_looks_blocked(C.F.html_to_text(CHALLENGE))


def test_a_page_with_the_same_bytes_is_unchanged(root):
    one_source(root)
    report, _ = check((SAVED, HTML))
    assert report["unchanged"] == ["ZZ-S1"]
    assert report["missing_quotes"] == [] and report["not_fetched"] == [] and report["changed_quotes_present"] == []
    assert report["counts"]["sources_unchanged"] == 1 and report["counts"]["rules_on_unchanged_sources"] == 2


def test_new_markup_around_the_same_sentences_is_information_only(root):
    one_source(root)
    report, _ = check((MARKUP_CHANGED, HTML))
    assert report["missing_quotes"] == [] and report["not_fetched"] == [] and report["unchanged"] == []
    (row,) = report["changed_quotes_present"]
    assert row["source_id"] == "ZZ-S1" and row["url"] == URL and row["rules"] == 2
    assert row["fetched_sha256"] == hashlib.sha256(MARKUP_CHANGED).hexdigest() != row["saved_sha256"]
    # The fixture's new markup adds a link to the header and the footer, which are not part of the text.
    assert row["text_same"] and row["saved_chars"] == row["fetched_chars"]
    assert report["counts"]["rules_found_on_changed_sources"] == 2 and report["counts"]["rules_missing"] == 0


def test_one_changed_word_in_a_quoted_sentence_is_a_finding(root):
    one_source(root)
    report, _ = check((WORD_CHANGED, HTML))
    (finding,) = report["missing_quotes"]
    assert finding["rule_id"] == "ZZ-DEADLINE-1"
    assert finding["source_id"] == "ZZ-S1" and finding["url"] == URL and finding["jurisdiction"] == "ZZ"
    assert finding["quote"] == DEADLINE["quote"] and finding["pinpoint"] == DEADLINE["pinpoint"]
    # The page's sentence as it reads now, found from the words of the quote that are still there.
    assert finding["nearby_text_now"].startswith("A claim must be filed within two years of the crime.")
    # The other rule's sentence did not change, so it is not reported.
    assert finding["source_rules"] == 2 and finding["source_rules_missing"] == 1
    assert report["counts"]["rules_missing"] == 1 and report["counts"]["rules_still_found_on_those_sources"] == 1
    assert report["changed_quotes_present"] == [] and report["unchanged"] == []


def test_a_url_that_does_not_answer_is_tried_again_and_then_reported(root):
    one_source(root)
    waits = []
    web = Web({URL: urllib.error.URLError("[Errno 8] nodename nor servname provided, or not known")})
    report = C.run(["ZZ"], get=web, pause=1, retries=2, wait=waits.append)
    assert web.asked == [URL, URL, URL] and waits == [3, 6]
    (row,) = report["not_fetched"]
    assert row["source_id"] == "ZZ-S1" and row["url"] == URL and row["status"] is None
    assert "nodename nor servname provided" in row["error"]
    assert report["missing_quotes"] == [] and report["counts"]["rules_not_checked"] == 2


def test_a_timeout_is_reported_as_one(root):
    one_source(root)
    report, web = check(TimeoutError("The read operation timed out"), retries=1)
    assert len(web.asked) == 2
    assert report["not_fetched"][0]["error"] == "TimeoutError: The read operation timed out"


def test_a_404_is_reported_with_its_status_and_not_asked_for_again(root):
    one_source(root)
    report, web = check(http_error(404, "Not Found"))
    assert web.asked == [URL]
    (row,) = report["not_fetched"]
    assert row["status"] == 404 and row["error"] == "HTTP 404 Not Found"


def test_a_503_is_asked_for_again(root):
    one_source(root)
    report, web = check([http_error(503, "Service Unavailable"), (MARKUP_CHANGED, HTML)])
    assert web.asked == [URL, URL]
    assert report["not_fetched"] == [] and len(report["changed_quotes_present"]) == 1

    report, web = check(http_error(503, "Service Unavailable"), retries=2)
    assert len(web.asked) == 3
    assert report["not_fetched"][0]["status"] == 503


def test_a_challenge_page_is_not_read_as_the_source(root):
    one_source(root)
    report, _ = check((CHALLENGE, HTML))
    # Without this the two quotes would be reported missing from a page that is not the statute.
    assert report["missing_quotes"] == []
    (row,) = report["not_fetched"]
    assert row["status"] is None and row["error"].startswith("blocked or empty")

    report, _ = check((b"", HTML))
    assert report["missing_quotes"] == [] and report["not_fetched"][0]["error"].startswith("blocked or empty")


def test_a_quote_that_differs_only_in_case_or_spacing_is_still_there(root):
    # verify.py passes a case-only match with a warning, and folds line breaks and non-breaking spaces.
    one_source(root, rules=[{**DEADLINE, "quote": "a claim must be filed\nwithin three years   of the crime."}])
    report, _ = check((MARKUP_CHANGED, HTML))
    assert report["missing_quotes"] == [] and len(report["changed_quotes_present"]) == 1


def test_a_page_whose_text_sits_in_a_form_is_read_with_the_form(root):
    # Eight saved sources are like this (export_dataset.py's FORM_TEXT): fetch_source.py's usual reading
    # drops <form> and would leave almost nothing of them.
    def in_form(raw, state):
        opening = b'<form id="aspnetForm"><input type="hidden" name="__VIEWSTATE" value="' + state + b'">'
        return raw.replace(b"<main>", opening).replace(b"</main>", b"</form>")

    saved = in_form(SAVED, b"dDwtMTA4")
    assert C.F.text_looks_blocked(C.F.html_to_text(saved))
    write(root, [save(root, "ZZ-S1", saved, drop=C.KEEP_FORM)], [DEADLINE, CAP])

    report, _ = check((in_form(SAVED, b"dDwtOTk5"), HTML))
    assert report["not_fetched"] == [] and report["missing_quotes"] == []
    assert len(report["changed_quotes_present"]) == 1

    report, _ = check((in_form(WORD_CHANGED, b"dDwtOTk5"), HTML))
    assert [m["rule_id"] for m in report["missing_quotes"]] == ["ZZ-DEADLINE-1"]


def test_a_pdf_is_read_with_pdftotext_and_a_page_that_became_one_is_noted(root, monkeypatch):
    one_source(root)
    read = []

    def pdf_to_text(path):
        read.append((path.name, path.read_bytes()))
        return C.F.html_to_text(WORD_CHANGED)

    monkeypatch.setattr(C.F, "pdf_to_text", pdf_to_text)
    report, _ = check((b"%PDF-1.7 made up", "application/pdf"))
    assert read == [("ZZ-S1.pdf", b"%PDF-1.7 made up")]
    (finding,) = report["missing_quotes"]
    assert finding["rule_id"] == "ZZ-DEADLINE-1"
    assert finding["note"] == "the saved copy is an HTML page and the url now gives a PDF"

    # An answer that says it is a PDF and is not one is fetch_source.py's "blocked", as is a PDF with no text.
    report, _ = check((CHALLENGE, "application/pdf"))
    assert report["missing_quotes"] == [] and "says it is a PDF and is not one" in report["not_fetched"][0]["error"]
    monkeypatch.setattr(C.F, "pdf_to_text", lambda path: " \n")
    report, _ = check((b"%PDF-1.7 a scan", "application/pdf"))
    assert report["missing_quotes"] == [] and report["not_fetched"][0]["error"] == "pdftotext read no text from the PDF"


def test_an_answer_that_cannot_be_read_is_a_row_and_does_not_end_the_run(root, monkeypatch):
    one_source(root)

    def pdf_to_text(path):
        raise RuntimeError("pdftotext timed out")

    monkeypatch.setattr(C.F, "pdf_to_text", pdf_to_text)
    report, _ = check((b"%PDF-1.7 made up", "application/pdf"))
    assert report["not_fetched"][0]["error"] == "could not read the answer: RuntimeError: pdftotext timed out"


def test_requests_to_one_host_wait_for_each_other_and_a_source_no_rule_cites_is_still_fetched(root):
    first = save(root, "ZZ-S1", SAVED, "https://statutes.example.test/code/1.1")
    second = save(root, "ZZ-S2", SAVED, "https://statutes.example.test/code/1.2")
    third = save(root, "ZZ-S10", SAVED, "https://board.example.test/apply")
    write(root, [first, second, third], [DEADLINE, CAP])
    waits = []
    web = Web({first["url"]: (WORD_CHANGED, HTML), second["url"]: (MARKUP_CHANGED, HTML), third["url"]: (SAVED, HTML)})
    report = C.run(["ZZ"], get=web, pause=7, wait=waits.append)
    # Three requests, two hosts: the one pause is before the second request to the host asked twice.
    assert sorted(web.asked) == sorted([first["url"], second["url"], third["url"]])
    assert web.asked.index(first["url"]) < web.asked.index(second["url"])
    assert waits == [7]
    assert [m["rule_id"] for m in report["missing_quotes"]] == ["ZZ-DEADLINE-1"]
    assert [(r["source_id"], r["rules"]) for r in report["changed_quotes_present"]] == [("ZZ-S2", 0)]
    assert report["unchanged"] == ["ZZ-S10"]
    assert report["counts"]["sources"] == 3 and report["counts"]["rules"] == 2


def test_the_text_near_a_missing_quote():
    page = "Section 1. A claim must be filed within two years of the crime. The board may extend the time."
    assert C.nearby_text("A claim must be filed within three years of the crime.", page).startswith("A claim must be filed within two years")
    # The run of words that is still there can come late in the quote.
    assert C.nearby_text("An application shall be filed within two years of the crime.", page).startswith("1. A claim must be filed within two years of the crime.")
    assert C.nearby_text("A claim must be filed within three years of the crime.", "Page not found.") == ""
    assert C.nearby_text("Nothing.", page) == ""
    # It starts and ends on a whole word.
    long_page = "The introduction says nothing of use here. " + page + " A provider shall not bill the victim for the examination, and sends the bill to the board."
    near = C.nearby_text("Every application shall be filed within two years of the crime.", long_page)
    assert near == "Section 1. A claim must be filed within two years of the crime. The board may extend the time. A"


def run_main(root, answer, *argv):
    out = root.parent / "report"
    code = C.main([*argv, "--out", str(out), "--pause", "0"], get=Web({URL: answer}))
    return code, out


def test_only_a_missing_quote_makes_the_exit_code_non_zero(root, capsys):
    one_source(root)
    assert run_main(root, (SAVED, HTML), "zz")[0] == 0
    assert run_main(root, (MARKUP_CHANGED, HTML), "ZZ")[0] == 0
    assert run_main(root, urllib.error.URLError("timed out"), "ZZ", "--retries", "0")[0] == 0
    assert run_main(root, http_error(403, "Forbidden"), "ZZ")[0] == 0
    capsys.readouterr()
    assert run_main(root, (WORD_CHANGED, HTML), "all")[0] == 1
    printed = capsys.readouterr()
    assert "## Quotes no longer found (1)" in printed.out and "ZZ-S1 missing_quotes" in printed.err


def test_the_report_is_written_and_nothing_under_rules_is_touched(root):
    one_source(root)
    before = files_under(root)
    code, out = run_main(root, (WORD_CHANGED, HTML), "ZZ")
    assert code == 1
    assert files_under(root) == before
    # The fetched page and its text were in the temporary folder, and are gone with it.
    assert list((root.parent / "scratch").iterdir()) == []

    assert sorted(p.name for p in out.iterdir()) == ["report.json", "summary.md"]
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["jurisdictions"] == ["ZZ"]
    assert report["counts"] == {
        "sources": 1,
        "rules": 2,
        "sources_with_missing_quotes": 1,
        "rules_missing": 1,
        "rules_still_found_on_those_sources": 1,
        "sources_not_fetched": 0,
        "rules_not_checked": 0,
        "sources_changed_quotes_present": 0,
        "sources_changed_quotes_present_same_text": 0,
        "rules_found_on_changed_sources": 0,
        "sources_unchanged": 0,
        "rules_on_unchanged_sources": 0,
    }
    summary = (out / "summary.md").read_text(encoding="utf-8")
    assert "### ZZ-S1: 1 of 2 quotes missing" in summary and f"<{URL}>" in summary
    assert '- **ZZ-DEADLINE-1** (Made-up Code 1.1(2)): "A claim must be filed within three years of the crime."' in summary
    assert 'Text there now: "A claim must be filed within two years of the crime.' in summary


def test_the_summary_names_each_group(root):
    one_source(root)
    report, _ = check(http_error(403, "Forbidden"))
    text = C.summary(report)
    assert "## Quotes no longer found (0)\n\nNone." in text
    assert f"| ZZ-S1 | 2 | HTTP 403 Forbidden | <{URL}> |" in text
    report, _ = check((MARKUP_CHANGED, HTML))
    text = C.summary(report)
    assert "## Not fetched (0)\n\nNone." in text and "## Bytes changed, every quote still there (1)" in text
    assert "1 of these read the same as the saved text, word for word, and 0 do not." in text
    assert f"| ZZ-S1 | 2 | same as saved | <{URL}> |" in text
    # Words changed on the page, none of them in a quoted sentence.
    write(root, [save(root, "ZZ-S1", SAVED)], [CAP])
    report, _ = check((WORD_CHANGED, HTML))
    assert report["missing_quotes"] == [] and report["counts"]["sources_changed_quotes_present_same_text"] == 0
    assert f"| ZZ-S1 | 1 | changed, {len(C.V.norm(C.F.html_to_text(SAVED))):,} to {len(C.V.norm(C.F.html_to_text(WORD_CHANGED))):,} chars | <{URL}> |" in C.summary(report)


def test_a_run_that_cannot_start_exits_2(root, monkeypatch, capsys):
    one_source(root)
    assert C.main(["QQ"], get=Web({})) == 2
    assert "QQ.json missing" in capsys.readouterr().err
    monkeypatch.setattr(C, "not_ready", lambda: "pdftotext is not installed")
    assert C.main(["ZZ"], get=Web({})) == 2
    assert "pdftotext is not installed" in capsys.readouterr().err
