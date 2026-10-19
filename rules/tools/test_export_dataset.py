"""rules/tools/export_dataset.py: dataset/ is exactly what the export makes from the verified rules, every
quote and sha256 in it checks out against the saved sources, and the CSV and JSON files say the same thing.

run from the repo root: uv run --with pytest pytest rules/tools/test_export_dataset.py
"""
import csv
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
from datetime import UTC, date, datetime
from pathlib import Path

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
    assert f"of the {sources:,} official sources Tend saved" in readme
    assert f"{ir_decision:,} decision rules, {ir_info:,} information rules, and {ir_skipped:,} set aside" in readme


def test_every_quote_is_verbatim_in_its_saved_source_text(doc):
    # Read and normalized exactly as verify.py does, and matched with its case as written.
    texts = {s["source_id"]: V.norm((ROOT / s["text_path"]).read_text(encoding="utf-8", errors="ignore")) for s in doc["sources"]}
    missing = [r["rule_id"] for r in doc["rules"] if not V.norm(r["quote"]) or V.norm(r["quote"]) not in texts[r["source_id"]]]
    assert missing == []


def test_every_number_in_params_appears_in_the_quote(doc):
    # Stronger than verify.py, which checks only its NUMERIC_PARAMS keys; the README says every whole number holds.
    bad = []
    for r in doc["rules"]:
        found = V.numbers_in(V.norm(r["quote"]))
        for k, v in r["params"].items():
            if isinstance(v, bool) or not isinstance(v, int):
                continue
            if not (V.money_in_quote(v, found) if k == "amount_cents" else v in found):
                bad.append((r["rule_id"], k, v))
    assert bad == []


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
