"""Fetch each saved source again and say whether the rules' quotes are still on the page. Report only.

usage: uv run --no-project --with beautifulsoup4 --with certifi python rules/tools/check_sources.py ST [ST ...] [--out DIR]   (or: all)

For every source in rules/jurisdictions/ST.json it sends fetch_source.py's own plain GET for the url,
keeps the answer in a temporary folder, and writes nothing under rules/. A source lands in one group:

- not fetched: the request failed (the HTTP status or the error is given), or the answer is what
  fetch_source.py calls blocked or empty. This tool has no Chrome fallback, so a site that needs a
  browser lands here every time.
- unchanged: the bytes have the sha256 the jurisdiction file records. verify.py already checks the
  quotes against that saved copy, so they are not read again.
- changed, every quote still there: the bytes differ, and each rule citing the source still has its
  quote in the new text. Information only: agency pages change their markup often.
- a quote is no longer found: the findings. Each has the rule id, the source id, the url, the quote,
  and the text now near it when a run of the quote's words is still on the page.

The new text is extracted as fetch_source.py does it (BeautifulSoup, or pdftotext for a PDF) and the
quote is looked for as verify.py does it (norm() on both, verbatim, or with case ignored, which
verify.py passes with a warning). It cannot tell whether a page that still has the quote means the
same thing, or whether a missing quote is a change in the law: a person reads the page. Nothing here
edits a rule. A rule changes only by saving the source again with fetch_source.py and passing verify.py.

One request at a time per host, PAUSE seconds apart, a 30 second timeout (fetch_source.py's), and
RETRIES more tries after a timeout, a dropped connection, or a 429 or 5xx answer. The User-Agent is
fetch_source.py's browser string, so a site answers as it did for the saved copy; it names nobody.

It writes report.json and summary.md to --out (a new temporary folder when not given) and prints
the summary. Exit 0 when no quote is missing, 1 when one is, 2 when it could not run.
"""
import argparse
import hashlib
import http.client
import json
import re
import shutil
import sys
import tempfile
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import fetch_source as F
import verify as V

ROOT = Path(__file__).resolve().parents[2]
PAUSE = 2.0  # seconds between two requests to one host
RETRIES = 2
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
HOSTS_AT_ONCE = 4
# How many of the quote's words in a row must still be on the page to show the text there now.
RUN_WORDS = 6
KEEP_FORM = tuple(t for t in F.DROP_TAGS if t != "form")


@dataclass
class Fetched:
    raw: bytes = b""
    ctype: str = ""
    status: int | None = None
    error: str = ""


def fetch(url: str, get=F.plain_fetch, retries: int = RETRIES, pause: float = PAUSE, wait=time.sleep) -> Fetched:
    """One GET, tried again after a timeout, a dropped connection, or a 429 or 5xx answer."""
    last = Fetched(error="not tried")
    for attempt in range(retries + 1):
        if attempt:
            wait(pause * 3 * attempt)
        try:
            raw, ctype = get(url)
            return Fetched(raw, ctype)
        except urllib.error.HTTPError as e:
            last = Fetched(status=e.code, error=f"HTTP {e.code} {e.reason}".strip())
            if e.code not in RETRY_STATUS:
                break
        except (OSError, http.client.HTTPException, ValueError) as e:
            # URLError, a timeout and a TLS failure are all OSError; a short read is an HTTPException.
            last = Fetched(error=f"{type(e).__name__}: {getattr(e, 'reason', None) or e}")
    return last


def saved_reading(source: dict) -> tuple[tuple, bool]:
    """How a source's saved text was read from its saved page: the tags fetch_source.py drops, or the
    same with <form> kept when only that gives the saved text (export_dataset.py's FORM_TEXT pages).
    And whether fetch_source.py would refuse the saved page itself (its SHORT_PAGES), in which case
    a short answer says nothing about a new copy."""
    if source["raw_path"].endswith(".pdf"):
        return F.DROP_TAGS, False
    raw = (ROOT / source["raw_path"]).read_bytes()
    want = V.norm((ROOT / source["text_path"]).read_text(encoding="utf-8", errors="ignore"))
    drop, text = F.DROP_TAGS, F.html_to_text(raw)
    if V.norm(text) != want:
        with_form = F.html_to_text(raw, KEEP_FORM)
        if V.norm(with_form) == want:
            drop, text = KEEP_FORM, with_form
    return drop, F.text_looks_blocked(text)


def nearby_text(q: str, page: str) -> str:
    """Where the page still has RUN_WORDS of the quote's words in a row, the text there now, about as
    long as the quote. Empty when it has no such run. q and page are both through norm()."""
    words = q.split()
    n = min(RUN_WORDS, len(words) - 1)
    if n < 1:
        return ""
    for i in range(len(words) - n + 1):
        at = page.find(" ".join(words[i : i + n]))
        if at >= 0:
            # Back up by the length of the quote's words before the run, then to a whole word.
            start = max(0, at - len(" ".join(words[:i])) - (1 if i else 0))
            if start and page[start - 1] != " ":
                space = page.find(" ", start, at)
                start = space + 1 if space >= 0 else at
            end = start + len(q) + 40
            if end < len(page):
                end = max(page.rfind(" ", at, end), at + 1)
            return page[start:end].strip()
    return ""


def check_source(st: str, source: dict, rules: list, got: Fetched, tmp: Path) -> dict:
    """One source's row for the report: its group, and what that group needs."""
    sid = source["id"]
    row = {"jurisdiction": st, "source_id": sid, "url": source["url"], "kind": source.get("kind", ""), "rules": len(rules)}
    if got.error:
        return row | {"group": "not_fetched", "status": got.status, "error": got.error}
    sha = hashlib.sha256(got.raw).hexdigest()
    if sha == source.get("sha256"):
        return row | {"group": "unchanged"}

    # As fetch_source.py decides: a PDF by its content type or its first bytes.
    is_pdf = "pdf" in got.ctype.lower() or got.raw.startswith(b"%PDF")
    raw_path = tmp / f"{sid}.{'pdf' if is_pdf else 'html'}"
    text_path = tmp / f"{sid}.txt"
    try:
        raw_path.write_bytes(got.raw)
        if is_pdf:
            if not got.raw.startswith(b"%PDF"):
                return row | {"group": "not_fetched", "status": None, "error": "blocked or empty: the answer says it is a PDF and is not one"}
            text = F.pdf_to_text(raw_path)
            if not text.strip():
                return row | {"group": "not_fetched", "status": None, "error": "pdftotext read no text from the PDF"}
        else:
            drop, saved_refused = saved_reading(source)
            text = F.html_to_text(got.raw, drop)
            if not got.raw.strip() or (not saved_refused and F.text_looks_blocked(text)):
                return row | {"group": "not_fetched", "status": None, "error": f"blocked or empty: {len(text)} characters of text"}
        # Through a file and back, as the saved text goes from fetch_source.py to verify.py.
        text_path.write_text(text, encoding="utf-8")
        page = V.norm(text_path.read_text(encoding="utf-8", errors="ignore"))
        saved = V.norm((ROOT / source["text_path"]).read_text(encoding="utf-8", errors="ignore"))
    except Exception as e:
        # One answer that cannot be read (pdftotext timing out, markup the parser refuses) is a row
        # in the report and does not end the run.
        return row | {"group": "not_fetched", "status": None, "error": f"could not read the answer: {type(e).__name__}: {e}"}
    finally:
        raw_path.unlink(missing_ok=True)
        text_path.unlink(missing_ok=True)

    saved_pdf = source["raw_path"].endswith(".pdf")
    row |= {
        "saved_sha256": source.get("sha256"),
        "fetched_sha256": sha,
        # Whether the words changed, or only the markup around them.
        "text_same": page == saved,
        "saved_chars": len(saved),
        "fetched_chars": len(page),
    }
    if saved_pdf != is_pdf:
        row["note"] = f"the saved copy is {'a PDF' if saved_pdf else 'an HTML page'} and the url now gives {'a PDF' if is_pdf else 'an HTML page'}"
    missing = []
    for r in rules:
        q = V.norm(r.get("quote", ""))
        # An empty quote is verify.py's to refuse.
        if q and not V.quote_found(q, page):
            missing.append({"rule_id": r.get("id", "?"), "pinpoint": r.get("pinpoint", ""), "quote": r.get("quote", ""), "nearby_text_now": nearby_text(q, page)})
    if missing:
        return row | {"group": "missing_quotes", "missing": missing}
    return row | {"group": "changed_quotes_present"}


def load(states: list[str]) -> list[tuple[str, dict, list]]:
    """(jurisdiction, source, the rules citing it) for every source of the given jurisdictions."""
    items = []
    for st in states:
        path = ROOT / "rules" / "jurisdictions" / f"{st}.json"
        if not path.is_file():
            raise SystemExit(f"{path} missing")
        data = json.loads(path.read_text(encoding="utf-8"))
        for s in data["sources"]:
            items.append((st, s, [r for r in data["rules"] if r.get("source_id") == s["id"]]))
    return items


def _order(row: dict) -> tuple:
    return (row["jurisdiction"], [int(n) for n in re.findall(r"\d+", row["source_id"])], row["source_id"])


def run(states: list[str], get=F.plain_fetch, pause: float = PAUSE, retries: int = RETRIES, wait=time.sleep, log=None) -> dict:
    """Fetch and check every source of the given jurisdictions, and return the report."""
    started = datetime.now(timezone.utc)
    items = load(states)
    by_host: dict[str, list] = {}
    for item in items:
        by_host.setdefault(urlsplit(item[1]["url"]).netloc.lower(), []).append(item)

    with tempfile.TemporaryDirectory(prefix="source-check-") as tmp:

        def one_host(host_items: list) -> list[dict]:
            rows = []
            for i, (st, source, rules) in enumerate(host_items):
                if i:
                    wait(pause)
                row = check_source(st, source, rules, fetch(source["url"], get, retries, pause, wait), Path(tmp))
                if log:
                    log(f"{row['source_id']} {row['group']}{' ' + row['error'] if row.get('error') else ''}")
                rows.append(row)
            return rows

        with ThreadPoolExecutor(max_workers=HOSTS_AT_ONCE) as pool:
            rows = sorted((row for host_rows in pool.map(one_host, by_host.values()) for row in host_rows), key=_order)

    groups = {g: [r for r in rows if r["group"] == g] for g in ("not_fetched", "unchanged", "changed_quotes_present", "missing_quotes")}
    for r in rows:
        del r["group"]
    findings = [
        {"jurisdiction": r["jurisdiction"], "source_id": r["source_id"], "url": r["url"], **m, "source_rules": r["rules"], "source_rules_missing": len(r["missing"])}
        | ({"note": r["note"]} if r.get("note") else {})
        for r in groups["missing_quotes"]
        for m in r["missing"]
    ]
    return {
        "tool": "rules/tools/check_sources.py",
        "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "jurisdictions": states,
        "counts": {
            "sources": len(rows),
            "rules": sum(r["rules"] for r in rows),
            "sources_with_missing_quotes": len(groups["missing_quotes"]),
            "rules_missing": len(findings),
            "rules_still_found_on_those_sources": sum(r["rules"] for r in groups["missing_quotes"]) - len(findings),
            "sources_not_fetched": len(groups["not_fetched"]),
            "rules_not_checked": sum(r["rules"] for r in groups["not_fetched"]),
            "sources_changed_quotes_present": len(groups["changed_quotes_present"]),
            "sources_changed_quotes_present_same_text": sum(r["text_same"] for r in groups["changed_quotes_present"]),
            "rules_found_on_changed_sources": sum(r["rules"] for r in groups["changed_quotes_present"]),
            "sources_unchanged": len(groups["unchanged"]),
            "rules_on_unchanged_sources": sum(r["rules"] for r in groups["unchanged"]),
        },
        "missing_quotes": findings,
        "not_fetched": groups["not_fetched"],
        "changed_quotes_present": groups["changed_quotes_present"],
        "unchanged": [r["source_id"] for r in groups["unchanged"]],
    }


def _cell(s: str) -> str:
    return V.norm(str(s)).replace("|", "\\|")


def summary(report: dict) -> str:
    """The report as a short Markdown page."""
    c = report["counts"]
    out = [
        "# Source check",
        "",
        f"`check_sources.py {' '.join(report['jurisdictions'])}`, started {report['started_at']}: {c['sources']} sources, cited by {c['rules']} rules.",
        "",
        "| Group | Sources | Rules citing them |",
        "|---|---|---|",
        f"| A quote is no longer found | {c['sources_with_missing_quotes']} | {c['rules_missing']} missing, {c['rules_still_found_on_those_sources']} still there |",
        f"| Not fetched | {c['sources_not_fetched']} | {c['rules_not_checked']}, not checked |",
        f"| Bytes changed, every quote still there | {c['sources_changed_quotes_present']} | {c['rules_found_on_changed_sources']}, found again |",
        f"| Same bytes as the saved copy | {c['sources_unchanged']} | {c['rules_on_unchanged_sources']}, not read again |",
        "",
        "A missing quote is not yet a change in the law, and a quote that is still there may sit in a page",
        "that now means something else. A person reads the page either way.",
        "",
        f"## Quotes no longer found ({c['rules_missing']})",
        "",
    ]
    if not report["missing_quotes"]:
        out += ["None.", ""]
    seen = None
    for m in report["missing_quotes"]:
        if m["source_id"] != seen:
            seen = m["source_id"]
            out += [f"### {m['source_id']}: {m['source_rules_missing']} of {m['source_rules']} quotes missing", "", f"<{m['url']}>", ""]
            if m.get("note"):
                out += [f"Note: {m['note']}.", ""]
            if m["source_rules_missing"] == m["source_rules"] and m["source_rules"] > 1:
                out += ["Every quote from this source is missing. Look at the url first: the page may have moved or may need a browser.", ""]
        out.append(f"- **{m['rule_id']}** ({V.norm(m['pinpoint'])}): \"{V.norm(m['quote'])}\"")
        out.append(f"  - Text there now: \"{m['nearby_text_now']}\"" if m["nearby_text_now"] else f"  - No {RUN_WORDS} words in a row of the quote are on the page now.")
    if report["missing_quotes"]:
        out.append("")
    out += [f"## Not fetched ({c['sources_not_fetched']})", ""]
    if report["not_fetched"]:
        out += ["| Source | Rules | Status or error | URL |", "|---|---|---|---|"]
        out += [f"| {r['source_id']} | {r['rules']} | {_cell(r['error'])} | <{r['url']}> |" for r in report["not_fetched"]]
    else:
        out.append("None.")
    same = c["sources_changed_quotes_present_same_text"]
    out += [
        "",
        f"## Bytes changed, every quote still there ({c['sources_changed_quotes_present']})",
        "",
        f"Information only. {same} of these read the same as the saved text, word for word, and {c['sources_changed_quotes_present'] - same} do not.",
    ]
    if report["changed_quotes_present"]:
        out += ["", "| Source | Rules | Text now | URL |", "|---|---|---|---|"]
        out += [
            f"| {r['source_id']} | {r['rules']} | "
            + ("same as saved" if r["text_same"] else f"changed, {r['saved_chars']:,} to {r['fetched_chars']:,} chars")
            + (f" ({_cell(r['note'])})" if r.get("note") else "")
            + f" | <{r['url']}> |"
            for r in report["changed_quotes_present"]
        ]
    return "\n".join(out) + "\n"


def not_ready() -> str:
    """Why a run cannot start, or "" when it can."""
    try:
        import bs4  # noqa: F401
        import certifi  # noqa: F401
    except ImportError as e:
        return f"{e}. Run it as: uv run --no-project --with beautifulsoup4 --with certifi python rules/tools/check_sources.py ..."
    if not shutil.which("pdftotext"):
        return "pdftotext is not installed (it comes with poppler), and the PDF sources need it"
    return ""


def main(argv: list[str] | None = None, get=F.plain_fetch) -> int:
    ap = argparse.ArgumentParser(description="Fetch each saved source again and report quotes that are no longer on the page.")
    ap.add_argument("states", nargs="+", metavar="ST", help="jurisdiction codes, or: all")
    ap.add_argument("--out", type=Path, help="folder for report.json and summary.md (default: a new temporary folder)")
    ap.add_argument("--pause", type=float, default=PAUSE, help=f"seconds between two requests to one host (default {PAUSE})")
    ap.add_argument("--retries", type=int, default=RETRIES, help=f"more tries after a failed request (default {RETRIES})")
    args = ap.parse_args(argv)
    states = [s.upper() for s in args.states]
    if states == ["ALL"]:
        states = sorted(p.stem for p in (ROOT / "rules" / "jurisdictions").glob("*.json"))
    if why := not_ready():
        print(why, file=sys.stderr)
        return 2
    try:
        report = run(states, get=get, pause=args.pause, retries=args.retries, log=lambda line: print(line, file=sys.stderr, flush=True))
    except SystemExit as e:
        print(e, file=sys.stderr)
        return 2
    out = args.out or Path(tempfile.mkdtemp(prefix="source-check-report-"))
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    text = summary(report)
    (out / "summary.md").write_text(text, encoding="utf-8")
    print(text)
    print(f"report: {out / 'report.json'}", file=sys.stderr)
    return 1 if report["missing_quotes"] else 0


if __name__ == "__main__":
    sys.exit(main())
