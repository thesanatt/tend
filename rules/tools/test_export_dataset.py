"""rules/tools/export_dataset.py: dataset/ is exactly what the export makes from the verified rules, every
quote and sha256 in it checks out against the saved sources, and the CSV and JSON files say the same thing.

run from the repo root: uv run --with pytest pytest rules/tools/test_export_dataset.py
"""
import csv
import hashlib
import importlib.util
import io
import json
import re
import shutil
import subprocess
import sys
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.parse import urlsplit

import pytest

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parents[1]


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


X = load("export_dataset")
V = load("verify")
VERIFIED = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((ROOT / "rules" / "verified").glob("*.json"))]
IR = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted((ROOT / "rules" / "ir").glob("*.json"))}


@pytest.fixture(scope="module")
def files() -> dict:
    return X.build()


@pytest.fixture(scope="module")
def doc(files) -> dict:
    return json.loads(files[X.JSON_FILE])


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_csv(data: bytes) -> list:
    return list(csv.reader(io.StringIO(data.decode("utf-8"), newline="")))


def same(json_value, csv_value: str) -> bool:
    if json_value is None:
        return csv_value == ""
    if isinstance(json_value, bool):
        return csv_value == ("true" if json_value else "false")
    if isinstance(json_value, int):
        return csv_value == str(json_value)
    if isinstance(json_value, (dict, list)):
        return json.loads(csv_value) == json_value
    return csv_value == json_value


def test_counts_match_the_verified_files(files, doc):
    rules = sum(len(d["rules"]) for d in VERIFIED)
    sources = sum(len(d["sources"]) for d in VERIFIED)
    print(f"\n{len(VERIFIED)} jurisdictions, {sources} sources, {rules} rules")
    counts = doc["metadata"]["counts"]
    assert (counts["jurisdictions"], counts["sources"], counts["rules"]) == (len(VERIFIED), sources, rules)
    assert (len(doc["jurisdictions"]), len(doc["sources"]), len(doc["rules"])) == (len(VERIFIED), sources, rules)
    assert [r["rule_id"] for r in doc["rules"]] == [r["id"] for d in VERIFIED for r in d["rules"]]
    assert [s["source_id"] for s in doc["sources"]] == [s["id"] for d in VERIFIED for s in d["sources"]]
    assert [j["code"] for j in doc["jurisdictions"]] == [d["jurisdiction"] for d in VERIFIED]
    assert len({r["rule_id"] for r in doc["rules"]}) == rules
    ir_info = sum(r["kind"] == "info" for ir in IR.values() for r in ir["rules"])
    ir_decision = sum(r["kind"] != "info" for ir in IR.values() for r in ir["rules"])
    ir_skipped = sum(len(ir["skipped"]) for ir in IR.values())
    assert counts["rules_by_engine_use"] == {"decision": ir_decision, "information": ir_info, "set_aside": ir_skipped}
    readme = files["README.md"].decode("ascii")
    assert f"{rules:,} rules for {len(VERIFIED)} jurisdictions" in readme
    assert f"of the {sources:,} sources Tend saved" in readme
    # Some sources are copies from sites that republish state law, so nothing calls them all official.
    assert "official" not in readme.lower() and "official" not in doc["metadata"]["description"]
    assert f"{ir_decision:,} decision rules, {ir_info:,} information rules, and {ir_skipped:,} set aside" in readme


def test_every_quote_is_verbatim_in_its_saved_source_text(doc):
    # Read and normalized exactly as verify.py does, and matched with its case as written.
    texts = {s["source_id"]: V.norm((ROOT / s["text_path"]).read_text(encoding="utf-8", errors="ignore")) for s in doc["sources"]}
    missing = [r["rule_id"] for r in doc["rules"] if not V.norm(r["quote"]) or V.norm(r["quote"]) not in texts[r["source_id"]]]
    assert missing == []


def test_every_quote_is_in_a_fresh_extraction_of_its_raw_file(doc):
    # Opt in: uv run --with pytest --with beautifulsoup4 pytest rules/tools/test_export_dataset.py
    # The recorded sha256 covers the raw file, not text_path. Nothing is dropped from a page here.
    bs4 = pytest.importorskip("bs4")
    if not shutil.which("pdftotext"):
        pytest.skip("pdftotext is not installed")
    texts = {}
    for s in doc["sources"]:
        raw = ROOT / s["raw_path"]
        assert sha256(raw.read_bytes()) == s["sha256"], s["source_id"]
        if s["format"] == "pdf":
            text = subprocess.run(["pdftotext", "-enc", "UTF-8", str(raw), "-"], capture_output=True, text=True, timeout=120, check=True).stdout
        else:
            # BeautifulSoup, as fetch_source.py uses it: the standard library's HTMLParser alone splits text and misses quotes.
            text = bs4.BeautifulSoup(raw.read_bytes(), "html.parser").get_text(" ", strip=True)
        texts[s["source_id"]] = V.norm(text)
    assert [r["rule_id"] for r in doc["rules"] if V.norm(r["quote"]) not in texts[r["source_id"]]] == []


def test_fetch_source_gives_the_saved_text_of_every_html_page_but_the_form_pages(doc):
    # Opt in, as above. What the README says fetch_source.py makes of each saved page, checked with its own functions.
    bs4 = pytest.importorskip("bs4")
    # Current Python releases read <title> as plain text, and WA-S4's saved title shows it was read that way.
    if bs4.BeautifulSoup("<title><i>x</i></title>", "html.parser").title.string != "<i>x</i>":
        pytest.skip("this Python's HTML parser reads <title> as markup, unlike the one the saved text came from")
    F = load("fetch_source")
    differs, refused = [], []
    for s in doc["sources"]:
        if s["format"] == "html":
            raw = (ROOT / s["raw_path"]).read_bytes()
            if V.norm(F.html_to_text(raw)) != V.norm((ROOT / s["text_path"]).read_text(encoding="utf-8")):
                differs.append(s["source_id"])
            if F.looks_blocked(raw, "text/html"):
                refused.append(s["source_id"])
    assert sorted(differs) == sorted(X.FORM_TEXT)
    assert sorted(refused) == sorted(X.FORM_TEXT + X.SHORT_PAGES)
    by_id = {s["source_id"]: s for s in doc["sources"]}
    for sid in X.FORM_TEXT:
        # fetch_source.html_to_text's tags less "form": that gives the saved text.
        soup = bs4.BeautifulSoup((ROOT / by_id[sid]["raw_path"]).read_bytes(), "html.parser")
        for tag in soup(["script", "style", "noscript", "svg", "nav", "header", "footer"]):
            tag.decompose()
        assert V.norm(soup.get_text(" ", strip=True)) == V.norm((ROOT / by_id[sid]["text_path"]).read_text(encoding="utf-8")), sid


def test_every_number_in_params_appears_in_the_quote(files, doc):
    # Stronger than verify.py, which checks only its NUMERIC_PARAMS keys; the README says every integer value holds.
    assert set(X.VERIFY_NUMBER_KEYS) == V.NUMERIC_PARAMS
    bad = []
    for r in doc["rules"]:
        found = V.numbers_in(V.norm(r["quote"]))
        for k, v in r["params"].items():
            if isinstance(v, bool) or not isinstance(v, int):
                continue
            if not (V.money_in_quote(v, found) if k == "amount_cents" else v in found):
                bad.append((r["rule_id"], k, v))
    assert bad == []
    unchecked = sorted({k for r in doc["rules"] for k, v in r["params"].items() if type(v) is int} - V.NUMERIC_PARAMS)
    assert f"does not check ({X.series(f'`{k}`' for k in unchecked)})." in files["README.md"].decode("ascii")


def test_every_sha256_matches_the_saved_files(doc):
    raw = [s["source_id"] for s in doc["sources"] if sha256((ROOT / s["raw_path"]).read_bytes()) != s["sha256"]]
    text = [s["source_id"] for s in doc["sources"] if sha256((ROOT / s["text_path"]).read_bytes()) != s["text_sha256"]]
    assert raw == [] and text == []
    by_id = {s["source_id"]: s for s in doc["sources"]}
    for r in doc["rules"]:
        s = by_id[r["source_id"]]
        assert (r["source_sha256"], r["source_url"], r["source_title"], r["source_kind"], r["retrieved_at"]) == (s["sha256"], s["url"], s["title"], s["kind"], s["retrieved_at"]), r["rule_id"]
    for j in doc["jurisdictions"]:
        assert j["verified_sha256"] == sha256((ROOT / "rules" / "verified" / f"{j['code']}.json").read_bytes())
        assert j["ir_sha256"] == sha256((ROOT / "rules" / "ir" / f"{j['code']}.json").read_bytes())
        assert IR[j["code"]]["source_sha256"] == j["verified_sha256"]


def test_the_redacted_pages_are_counted_where_the_sha256_is_described(files, doc):
    # Their sha256 was recorded again after the redaction, so "recorded when it was saved" needs the exception.
    noted = [s["source_id"] for s in doc["sources"] if s["note"] and "redacted" in s["note"]]
    assert doc["metadata"]["counts"]["sources_redacted"] == len(noted)
    assert f"For the {len(noted)} pages whose `note` says so, it was recorded again" in files["README.md"].decode("ascii")


def test_copies_from_sites_that_republish_state_law_are_counted_and_described(files, doc):
    # Counted again from each source's address, without the export's helpers.
    hosts = Counter(urlsplit(s["url"]).hostname for s in doc["sources"])
    copies = [s for s in doc["sources"] if urlsplit(s["url"]).hostname in X.REPUBLISHERS]
    ids = {s["source_id"] for s in copies}
    quoting = sum(r["source_id"] in ids for r in doc["rules"])
    by_site = {k: hosts[k] for k in X.REPUBLISHERS if hosts[k]}
    counts = doc["metadata"]["counts"]
    print(f"\ncopies from republishers: {by_site}, quoted by {quoting} rules")
    assert counts["sources_from_republishers"] == by_site
    assert counts["rules_quoting_republishers"] == quoting
    readme = files["README.md"].decode("ascii")
    assert f"- {len(copies):,} sources are copies on sites that republish state law" in readme
    assert f"The {quoting:,} rules that quote these copies match the copies" in readme
    # What the README says each copy says about how current it is, read from every copy.
    years = set()
    for s in copies:
        text = (ROOT / s["text_path"]).read_text(encoding="utf-8")
        host = urlsplit(s["url"]).hostname
        assert X.CURRENCY_NOTES[host] in text, s["source_id"]
        if host == "law.justia.com":
            years.add(re.search(r"Universal Citation: .{0,80}?\((\d{4})\)", text, re.DOTALL)[1])
    print(f"Justia copies show the code of: {sorted(years)}")
    assert doc["metadata"]["current_as_of"]["justia_code_years"] == sorted(years)
    assert f"Each saved Justia page shows its state's {X.series(sorted(years), 'or')} code" in readme


def test_rules_carry_the_verified_fields_unchanged(doc):
    rules = {r["rule_id"]: r for r in doc["rules"]}
    for d in VERIFIED:
        for v in d["rules"]:
            r = rules[v["id"]]
            assert (r["category"], r["params"], r["summary"], r["quote"], r["pinpoint"], r["source_id"]) == (v["category"], v["params"], v["summary"], v["quote"], v["pinpoint"], v["source_id"])
            assert r["fragment_url"] == v.get("fragment_url")
            assert r["expense"] == (v.get("expense") or v["params"].get("expense"))
            assert (r["jurisdiction"], r["jurisdiction_name"]) == (d["jurisdiction"], d["name"])
    for j, d in zip(doc["jurisdictions"], VERIFIED):
        assert (j["program"], j["coverage"], j["confidence"], j["researcher_notes"]) == (d["program"], d["coverage"], d["confidence"], d["researcher_notes"])


def test_fragment_links_exist_only_for_html_sources(doc):
    fmt = {s["source_id"]: s["format"] for s in doc["sources"]}
    assert all(bool(r["fragment_url"]) == (fmt[r["source_id"]] == "html") for r in doc["rules"])


def test_engine_use_is_what_normalize_wrote(doc):
    rules = {r["rule_id"]: r for r in doc["rules"]}
    for st, ir in IR.items():
        for x in ir["rules"]:
            assert (rules[x["id"]]["engine_use"], rules[x["id"]]["set_aside_reason"]) == ("information" if x["kind"] == "info" else "decision", None)
        for x in ir["skipped"]:
            assert (rules[x["id"]]["engine_use"], rules[x["id"]]["set_aside_reason"]) == ("set_aside", x["reason"])
        # The README's "information changes no amount" and its RI/WY exam note rest on these.
        assert not [x for x in ir["rules"] if x["kind"] == "info" and x.get("category") in ("collateral_source", "exam_payment")]
        holds = any(x["kind"] == "exam_no_bill" for x in ir["rules"])
        assert holds == any(r["jurisdiction"] == st and r["category"] == "exam_no_bill" and r["engine_use"] == "decision" for r in doc["rules"])


def test_the_exam_note_names_every_exam_no_bill_rule_of_its_jurisdictions(files, doc):
    # The claim a reader checks first: a state with an exam_no_bill rule set aside must not read as having none.
    note = next(p for p in files["README.md"].decode("ascii").split("\n\n") if p.startswith("One kind of decision rule can end up as information."))
    holds = {r["jurisdiction"] for r in doc["rules"] if r["category"] == "exam_no_bill" and r["engine_use"] == "decision"}
    payment = [r for r in doc["rules"] if r["category"] == "exam_payment" and r["engine_use"] == "decision" and r["jurisdiction"] not in holds]
    names = {j["code"]: j["name"] for j in doc["jurisdictions"]}
    print(f"\nexam lines not held in: {sorted({r['jurisdiction'] for r in payment})}")
    for st in {r["jurisdiction"] for r in payment}:
        no_bill = [r for r in doc["rules"] if r["jurisdiction"] == st and r["category"] == "exam_no_bill"]
        assert all(r["rule_id"] in note for r in no_bill), st
        assert (f"{names[st]} has no `exam_no_bill` rule in this release." in note) == (not no_bill), st
    assert all(r["rule_id"] in note for r in payment)


def test_a_duplicate_cap_set_aside_is_never_more_generous_than_the_one_kept(files, doc):
    rules = {r["rule_id"]: r for r in doc["rules"]}
    split = Counter()
    for r in doc["rules"]:
        why = r["set_aside_reason"] or ""
        if why.startswith("less generous duplicate of "):
            kept = rules[why.split()[-1]]
            assert (kept["engine_use"], kept["category"], kept["expense"]) == ("decision", r["category"], r["expense"]), r["rule_id"]
            mine, theirs = int(r["params"]["amount_cents"]), int(kept["params"]["amount_cents"])
            assert mine <= theirs, r["rule_id"]
            split["lower" if mine < theirs else "equal"] += 1
    print(f"\nduplicate caps set aside: {dict(split)}")
    readme = files["README.md"].decode("ascii")
    assert f"{split['lower']} are lower than the cap kept and {split['equal']} {'is' if split['equal'] == 1 else 'are'} equal" in readme


def test_csv_and_json_agree(files, doc):
    flat = [X.flat_jurisdiction(j) for j in doc["jurisdictions"]]
    for name, columns, rows in (
        (X.RULES_CSV, X.RULE_COLUMNS, doc["rules"]),
        (X.SOURCES_CSV, X.SOURCE_COLUMNS, doc["sources"]),
        (X.JURISDICTIONS_CSV, X.JURISDICTION_COLUMNS, flat),
    ):
        table = read_csv(files[name])
        assert table[0] == columns, name
        assert len(table) == len(rows) + 1, name
        for row, line in zip(rows, table[1:]):
            assert len(line) == len(columns)
            for c, value in zip(columns, line):
                assert same(row[c], value), (name, c, value[:80])
    # The flat jurisdiction columns read the program and coverage objects as written.
    for j, row in zip(doc["jurisdictions"], flat):
        assert row["program_name"] == j["program"]["program_name"]
        assert row["application_form_field_count"] == j["program"]["application_form"]["field_count"]
        assert (row["coverage_found"], row["coverage_not_found"], row["coverage_notes"]) == (j["coverage"]["found"], j["coverage"]["not_found"], j["coverage"]["notes"])
    assert set(X.RULE_COLUMNS) == set(doc["rules"][0]) and set(X.SOURCE_COLUMNS) == set(doc["sources"][0])


def test_the_data_dictionary_types_match_the_cells(files):
    readme = files["README.md"].decode("ascii")
    checks = {
        "integer": lambda v: v.isdigit(),
        "boolean": lambda v: v in ("true", "false"),
        "hex": lambda v: re.fullmatch(r"[0-9a-f]{64}", v),
        "URL": lambda v: v.startswith(("https://", "http://")),
        "timestamp": lambda v: re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", v),
        "JSON object": lambda v: isinstance(json.loads(v), dict),
        "JSON list": lambda v: isinstance(json.loads(v), list),
    }
    for name, heading, columns in (
        (X.RULES_CSV, "### Rules (", X.RULE_COLUMNS),
        (X.SOURCES_CSV, "### Sources (", X.SOURCE_COLUMNS),
        (X.JURISDICTIONS_CSV, "### Jurisdictions (", X.JURISDICTION_COLUMNS),
    ):
        # The first table under the heading: | `column` | type | meaning |
        section = readme.split(heading, 1)[1].split("\n#", 1)[0]
        types = dict(re.findall(r"^\| `(\w+)` \| ([^|]+?) \| ", section, re.MULTILINE))
        assert list(types) == columns, name
        table = read_csv(files[name])[1:]
        for i, c in enumerate(columns):
            cells, kind = [row[i] for row in table], types[c]
            assert "empty" in kind or "" not in cells, (name, c)
            cells = [v for v in cells if v]
            for prefix, ok in checks.items():
                if kind.startswith(prefix):
                    assert all(ok(v) for v in cells), (name, c)


def test_csv_files_are_utf8_with_lf_line_ends(files):
    for name in (X.RULES_CSV, X.SOURCES_CSV, X.JURISDICTIONS_CSV):
        data = files[name]
        assert not data.startswith(b"\xef\xbb\xbf") and b"\r" not in data and data.endswith(b"\n")
        data.decode("utf-8")


def test_dataset_and_downloads_are_current(files):
    for folder in X.OUT_DIRS:
        for name, data in files.items():
            assert (folder / name).read_bytes() == data, f"{folder / name} is stale: run python3 rules/tools/export_dataset.py"
    sums = dict(line.split("  ")[::-1] for line in files["SHA256SUMS"].decode("ascii").splitlines())
    assert sorted(sums) == sorted(set(files) - {"SHA256SUMS"})
    assert all(sha256(files[name]) == digest for name, digest in sums.items())
    done = subprocess.run([sys.executable, str(TOOLS / "export_dataset.py"), "--check"], capture_output=True, text=True, cwd=ROOT, check=False)
    assert done.returncode == 0, done.stdout + done.stderr


def test_check_fails_on_a_stale_folder_and_passes_after_writing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(X, "OUT_DIRS", [tmp_path / "dataset", tmp_path / "downloads"])
    assert X.main(["--check"]) == 1
    assert X.main([]) == 0
    assert X.main(["--check"]) == 0
    capsys.readouterr()
    csv_file = tmp_path / "downloads" / X.RULES_CSV
    csv_file.write_bytes(csv_file.read_bytes().replace(b"decision", b"decisi0n", 1))
    assert X.main(["--check"]) == 1
    assert capsys.readouterr().out.splitlines()[0] == f"stale: {csv_file}"
    assert X.main(["--bogus"]) == 2


def test_the_export_is_deterministic(files, doc):
    assert X.build() == files
    # No clock: neither today's date nor the current hour appears unless a source was saved then.
    saved = {s["retrieved_at"][:10] for s in doc["sources"]}
    stamp = date.today().isoformat()
    if stamp not in saved:
        assert stamp not in json.dumps(doc["metadata"]) and stamp not in files["README.md"].decode("ascii")
    hour = datetime.now(UTC).strftime("%Y-%m-%dT%H")
    assert hour not in json.dumps(doc["metadata"]) or hour in {s["retrieved_at"][:13] for s in doc["sources"]}


def test_readme_is_ascii_and_keeps_the_placeholders_marked(files):
    readme = files["README.md"].decode("ascii")
    assert "Tend is not legal advice" in readme and "The program decides." in readme
    for section in ("## How to cite", "## License", "## Contact"):
        assert f"{section}\n\n> **TODO (Sanat)" in readme
    assert "DOI" in readme and "10." not in readme.split("## How to cite")[1]
    for name in (X.JSON_FILE, X.RULES_CSV, X.SOURCES_CSV, X.JURISDICTIONS_CSV):
        assert f"| {len(files[name]):,} |" in readme
    assert "solo" not in readme.lower()
