"""Export the verified rules as a versioned dataset: one JSON file, three CSV files, a README, SHA256SUMS.

usage: python3 rules/tools/export_dataset.py [--check]

Reads rules/verified/*.json, rules/ir/*.json, and the saved source text, and writes dataset/ at the repo
root plus a byte-for-byte copy in web/public/downloads/, which the site's /data page serves. Nothing comes
from a clock, so the same inputs always give the same bytes. --check writes nothing and exits 1 when
either folder is out of date. The README's category and expense lists are read from rules/SCHEMA.md.
"""
import csv
import hashlib
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
VERSION = "1.0"
NAME = "Tend verified rules"
SITE = "https://youreowed.tech"
REPO = "https://github.com/thesanatt/tend"
OUT_DIRS = [ROOT / "dataset", ROOT / "web" / "public" / "downloads"]
JSON_FILE = f"tend-rules-v{VERSION}.json"
RULES_CSV = f"tend-rules-v{VERSION}.csv"
SOURCES_CSV = f"tend-sources-v{VERSION}.csv"
JURISDICTIONS_CSV = f"tend-jurisdictions-v{VERSION}.csv"

RULE_COLUMNS = ["rule_id", "jurisdiction", "jurisdiction_name", "category", "expense", "params", "summary", "quote", "pinpoint", "source_id", "source_title", "source_kind", "source_url", "fragment_url", "retrieved_at", "source_sha256", "engine_use", "set_aside_reason"]
SOURCE_COLUMNS = ["source_id", "jurisdiction", "title", "kind", "format", "url", "retrieved_at", "sha256", "text_sha256", "raw_path", "text_path", "note", "rules"]
PROGRAM_KEYS = ["program_name", "agency", "website", "apply_url", "application_pdf_url", "phone", "phone_source_id", "statute_citation"]
FORM_KEYS = ["source_id", "fillable", "field_count"]
COUNT_KEYS = ["rules", "sources", "decision_rules", "information_rules", "set_aside_rules"]
JURISDICTION_COLUMNS = ["code", "name", *PROGRAM_KEYS, *(f"application_form_{k}" for k in FORM_KEYS), "confidence", "coverage_found", "coverage_not_found", "coverage_notes", "researcher_notes", *COUNT_KEYS, "verified_sha256", "ir_sha256"]
ENGINE_USES = ("decision", "information", "set_aside")
# Params keys rules/SCHEMA.md gives a fixed list of values for.
LISTED_PARAMS = ("insurance_billing", "per", "from", "alternatives", "method", "document")
# The params keys whose numbers verify.py looks for in the quote (its NUMERIC_PARAMS).
VERIFY_NUMBER_KEYS = ("amount_cents", "years", "months", "weeks", "days", "within_days", "count_limit", "days_lost")
# Sites that republish state law. A copy saved from one is not the state's own publication.
REPUBLISHERS = {"law.justia.com": "Justia", "www.law.cornell.edu": "Cornell's Legal Information Institute"}
# What every saved copy from that site says about how current it is. The README repeats it, so the
# export stops if a copy stops saying it.
CURRENCY_NOTES = {"law.justia.com": "may not be the most recent version", "www.law.cornell.edu": "State regulations are updated quarterly"}
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load() -> list:
    states = []
    for path in sorted((ROOT / "rules" / "verified").glob("*.json")):
        ir_path = ROOT / "rules" / "ir" / path.name
        if not ir_path.is_file():
            sys.exit(f"{ir_path.relative_to(ROOT)} is missing: run python3 rules/tools/normalize.py {path.stem}")
        raw, ir_raw = path.read_bytes(), ir_path.read_bytes()
        states.append((json.loads(raw), sha256(raw), json.loads(ir_raw), sha256(ir_raw)))
    if not states:
        sys.exit("no files in rules/verified")
    return states


def engine_use(data: dict, ir: dict) -> dict:
    """rule id -> (engine_use, set_aside_reason), read from what normalize.py wrote."""
    use = {r["id"]: ("information" if r["kind"] == "info" else "decision", None) for r in ir["rules"]}
    for s in ir["skipped"]:
        use[s["id"]] = ("set_aside", s["reason"])
    ids = [r["id"] for r in data["rules"]]
    if len(use) != len(ir["rules"]) + len(ir["skipped"]) or sorted(use) != sorted(ids):
        sys.exit(f"rules/ir/{data['jurisdiction']}.json does not list each verified rule exactly once: run python3 rules/tools/normalize.py")
    return use


def collect(states: list) -> tuple:
    jurisdictions, sources, rules = [], [], []
    for data, verified_sha, ir, ir_sha in states:
        st = data["jurisdiction"]
        # The IR names the verified file it was made from; an older one would give the wrong engine_use.
        if ir.get("source_sha256") != verified_sha:
            sys.exit(f"rules/ir/{st}.json was made from an older rules/verified/{st}.json: run python3 rules/tools/normalize.py {st}")
        unknown = set(data["program"]) - set(PROGRAM_KEYS) - {"application_form"}
        if unknown:
            sys.exit(f"{st}: program has fields this export does not know: {sorted(unknown)}")
        use = engine_use(data, ir)
        cited = Counter(r["source_id"] for r in data["rules"])
        by_id = {}
        for s in data["sources"]:
            row = {
                "source_id": s["id"],
                "jurisdiction": st,
                "title": s["title"],
                "kind": s["kind"],
                "format": "pdf" if s["raw_path"].endswith(".pdf") else "html",  # as verify.py decides
                "url": s["url"],
                "retrieved_at": s["retrieved_at"],
                "sha256": s["sha256"],
                "text_sha256": sha256((ROOT / s["text_path"]).read_bytes()),
                "raw_path": s["raw_path"],
                "text_path": s["text_path"],
                "note": s.get("note"),
                "rules": cited[s["id"]],
            }
            sources.append(row)
            by_id[s["id"]] = row
        for r in data["rules"]:
            src = by_id[r["source_id"]]
            how, why = use[r["id"]]
            rules.append({
                "rule_id": r["id"],
                "jurisdiction": st,
                "jurisdiction_name": data["name"],
                "category": r["category"],
                # verify.py and normalize.py read the expense the same way: the rule's own, else params.expense.
                "expense": r.get("expense") or (r.get("params") or {}).get("expense"),
                "params": r.get("params") or {},
                "summary": r["summary"],
                "quote": r["quote"],
                "pinpoint": r["pinpoint"],
                "source_id": r["source_id"],
                "source_title": src["title"],
                "source_kind": src["kind"],
                "source_url": src["url"],
                "fragment_url": r.get("fragment_url"),
                "retrieved_at": src["retrieved_at"],
                "source_sha256": src["sha256"],
                "engine_use": how,
                "set_aside_reason": why,
            })
        uses = Counter(how for how, _ in use.values())
        jurisdictions.append({
            "code": st,
            "name": data["name"],
            "program": data["program"],
            "confidence": data["confidence"],
            "coverage": data["coverage"],
            "researcher_notes": data.get("researcher_notes"),
            "rules": len(data["rules"]),
            "sources": len(data["sources"]),
            "decision_rules": uses["decision"],
            "information_rules": uses["information"],
            "set_aside_rules": uses["set_aside"],
            "verified_sha256": verified_sha,
            "ir_sha256": ir_sha,
        })
    return jurisdictions, sources, rules


def site(source: dict) -> str:
    return urlsplit(source["url"]).hostname or ""


def redacted(source: dict) -> bool:
    return "redacted" in (source["note"] or "")


def metadata(jurisdictions: list, sources: list, rules: list) -> dict:
    retrieved = sorted(s["retrieved_at"] for s in sources)
    copies = {s["source_id"] for s in sources if site(s) in REPUBLISHERS}
    return {
        "name": NAME,
        "version": VERSION,
        "description": "The verified rules in Tend's law library, for the crime victim compensation programs of the 50 states and DC. Each rule has a plain-language summary and a verbatim quote from a saved source, with its pinpoint citation, address, and sha256.",
        "homepage": SITE,
        "repository": REPO,
        "generated_by": "rules/tools/export_dataset.py, from rules/verified and rules/ir",
        "current_as_of": {"first_retrieved_at": retrieved[0], "last_retrieved_at": retrieved[-1]},
        "counts": {
            "jurisdictions": len(jurisdictions),
            "sources": len(sources),
            "rules": len(rules),
            "rules_by_engine_use": {u: sum(r["engine_use"] == u for r in rules) for u in ENGINE_USES},
            "rules_by_category": dict(sorted(Counter(r["category"] for r in rules).items())),
            "sources_by_kind": dict(sorted(Counter(s["kind"] for s in sources).items())),
            "rules_with_fragment_url": sum(bool(r["fragment_url"]) for r in rules),
            "sources_quoted": sum(s["rules"] > 0 for s in sources),
            "sources_from_republishers": {k: v for k in REPUBLISHERS if (v := sum(site(s) == k for s in sources))},
            "rules_quoting_republishers": sum(r["source_id"] in copies for r in rules),
            "sources_redacted": sum(redacted(s) for s in sources),
        },
        "license": "TODO: not chosen yet",
        "not_legal_advice": "Tend is not legal advice. It shows what each program's own rules say, with the quote. The program decides.",
    }


def flat_jurisdiction(j: dict) -> dict:
    p, form, cov = j["program"], j["program"].get("application_form") or {}, j["coverage"]
    return {
        "code": j["code"],
        "name": j["name"],
        **{k: p.get(k) for k in PROGRAM_KEYS},
        **{f"application_form_{k}": form.get(k) for k in FORM_KEYS},
        "confidence": j["confidence"],
        "coverage_found": cov.get("found"),
        "coverage_not_found": cov.get("not_found"),
        "coverage_notes": cov.get("notes"),
        "researcher_notes": j["researcher_notes"],
        **{k: j[k] for k in COUNT_KEYS},
        "verified_sha256": j["verified_sha256"],
        "ir_sha256": j["ir_sha256"],
    }


def cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    return str(v)


def to_csv(columns: list, rows: list) -> bytes:
    buf = io.StringIO()
    out = csv.writer(buf, lineterminator="\n")
    out.writerow(columns)
    for row in rows:
        out.writerow([cell(row[c]) for c in columns])
    return buf.getvalue().encode("utf-8")


# --- README ----------------------------------------------------------------------------------------

def schema() -> tuple:
    """rules/SCHEMA.md's category table, expense list, and the fixed value lists for LISTED_PARAMS."""
    text = (ROOT / "rules" / "SCHEMA.md").read_text(encoding="utf-8")
    cats = {m[0]: (m[1].strip(), m[2].strip()) for m in re.findall(r"^\| `([a-z_]+)` \| (.+?) \| (.+?) \|$", text, re.MULTILINE)}
    block = re.search(r"## Expense types.*?\n\n(.+?)\n\n", text, re.DOTALL)
    expenses = re.findall(r"`([a-z_]+)`", block[1]) if block else []
    listed = {}
    for key in LISTED_PARAMS:
        m = re.search(rf"`{key}`(?::\s*|\s*\((?:list:\s*)?)([a-z_0-9]+(?:,\s*[a-z_0-9]+)+)", text)
        if m:
            listed[key] = [v.strip() for v in m[1].split(",")]
    keys = set(re.findall(r"`([a-z_]+)`", " ".join(params for _, params in cats.values())))
    if len(cats) < 19 or len(expenses) < 18 or len(listed) < len(LISTED_PARAMS):
        sys.exit("could not read the category table, expense list, or value lists in rules/SCHEMA.md")
    return cats, expenses, listed, keys


def n(x: int) -> str:
    return f"{x:,}"


def day(iso: str) -> str:
    y, m, d = iso[:10].split("-")
    return f"{MONTHS[int(m) - 1]} {int(d)}, {y}"


def saved_between(first: str, last: str) -> str:
    if first[:10] == last[:10]:
        return f"{day(first)}, between {first[11:16]} and {last[11:16]} UTC"
    return f"between {day(first)} {first[11:16]} UTC and {day(last)} {last[11:16]} UTC"


def table(head: list, rows: list) -> list:
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    return out + ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]


def series(items: list, last: str = "and") -> str:
    items = list(items)
    return f" {last} ".join(items) if len(items) < 3 else ", ".join(items[:-1]) + f", {last} {items[-1]}"


def kinds(sources: list) -> str:
    """'103 statutes', '17 regulations', and so on."""
    words = {"agency_pdf": "agency PDF", "agency_page": "agency page", "application_form": "application form"}
    return series(f"{m} {words.get(k, k)}{'' if m == 1 else 's'}" for k, m in sorted(Counter(s["kind"] for s in sources).items()))


def republished(sources: list, rules: list) -> list:
    """The README's limitation on sources saved from REPUBLISHERS, read from the saved copies."""
    by_site = {k: [s for s in sources if site(s) == k] for k in REPUBLISHERS}
    by_site = {k: v for k, v in by_site.items() if v}
    if not by_site:
        return []
    years = set()
    for k, copies in by_site.items():
        for s in copies:
            text = (ROOT / s["text_path"]).read_text(encoding="utf-8", errors="ignore")
            if CURRENCY_NOTES[k] not in text:
                sys.exit(f"{s['source_id']} no longer says {CURRENCY_NOTES[k]!r}: review the README's note on {REPUBLISHERS[k]}")
            if k == "law.justia.com":
                # Justia's own citation line names the year of the code the page shows.
                m = re.search(r"Universal Citation: .{0,80}?\((\d{4})\)", text, re.DOTALL)
                if not m:
                    sys.exit(f"{s['source_id']}: no code year on the Justia copy: review the README's note on Justia")
                years.add(m[1])
    ids = {s["source_id"] for copies in by_site.values() for s in copies}
    said = []
    if "law.justia.com" in by_site:
        said.append(f"Each saved Justia page shows its state's {series(sorted(years), 'or')} code and says it may not be the most recent version.")
    if "www.law.cornell.edu" in by_site:
        said.append("Each saved Cornell page says state regulations are updated there quarterly.")
    return [
        f"- {n(len(ids))} sources are copies on sites that republish state law, not the state's own publication: "
        + series(f"{kinds(copies)} from {REPUBLISHERS[k]} ({k.removeprefix('www.')})" for k, copies in by_site.items())
        + ".",
        *(f"  {line}" for line in said),
        f"  The {n(sum(r['source_id'] in ids for r in rules))} rules that quote these copies match the copies, so check the state's own code before relying on one.",
    ]


def not_held(rule: dict) -> str:
    """Why an exam_no_bill rule holds no exam line, as the README says it."""
    who = rule["params"].get("applies_to")
    if rule["engine_use"] == "set_aside" and isinstance(who, str):
        return f"set aside because it covers only {who}"
    if rule["engine_use"] == "set_aside":
        return f"set aside ({rule['set_aside_reason']})"
    return "kept as information"


def kind_of(v) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, list):
        return "list of text"
    return "null" if v is None else "text"


def formula_like(tables: dict) -> list:
    """Cells a spreadsheet may read as a formula: (file, row id, column)."""
    hits = []
    for name, (columns, rows, id_col) in tables.items():
        for row in rows:
            for c in columns:
                if cell(row[c])[:1] in ("=", "+", "-", "@"):
                    hits.append((name, row[id_col], c))
    return hits


def readme(meta: dict, jurisdictions: list, sources: list, rules: list, sizes: dict, tables: dict) -> str:
    cats, expenses, listed, schema_keys = schema()
    c = meta["counts"]
    uses = c["rules_by_engine_use"]
    codes = {j["code"] for j in jurisdictions}
    where = " (the 50 states and DC)" if len(codes) == 51 and "DC" in codes else ""
    first, last = meta["current_as_of"]["first_retrieved_at"], meta["current_as_of"]["last_retrieved_at"]
    fewest = min(jurisdictions, key=lambda j: (j["rules"], j["code"]))
    most = max(jurisdictions, key=lambda j: (j["rules"], j["code"]))
    conf = Counter(j["confidence"] for j in jurisdictions)
    unknown = sorted(set(c["rules_by_category"]) - set(cats)) + sorted({r["expense"] for r in rules if r["expense"]} - set(expenses))
    if unknown:
        sys.exit(f"categories or expense types missing from rules/SCHEMA.md: {unknown}")
    by_kind = Counter(r["source_kind"] for r in rules)
    cat_states = {k: len({r["jurisdiction"] for r in rules if r["category"] == k}) for k in cats}
    by_expense = Counter(r["expense"] for r in rules if r["expense"])
    amount = {r["rule_id"]: r["params"].get("amount_cents") for r in rules}
    reasons, dupes = Counter(), Counter()
    for r in rules:
        why = r["set_aside_reason"]
        if why and why.startswith("less generous duplicate of "):
            reasons["A duplicate of another cap, no more generous"] += 1
            # normalize.py keeps the first of the most generous caps, so a cap equal to it is set aside too.
            mine, kept = int(amount[r["rule_id"]]), int(amount[why.rsplit(" ", 1)[1]])
            dupes["lower" if mine < kept else "equal" if mine == kept else "higher"] += 1
        elif why and why.startswith("applies_to"):
            reasons["`params.applies_to` does not name the survivor"] += 1
        elif why:
            reasons[f"`{why}`"] += 1
    if dupes["higher"]:
        sys.exit("a cap set aside as a duplicate is more generous than the cap kept: check rules/ir")
    notes = Counter(s["note"] for s in sources if s["note"])
    no_form = [j["code"] for j in jurisdictions if not (j["program"].get("application_form") or {}).get("source_id")]
    paired = sorted(v for j in jurisdictions for v in j["coverage"]["found"] if ":" in v)
    paired_in = sorted({j["code"] for j in jurisdictions if any(":" in v for v in j["coverage"]["found"])})
    integer_keys = {k for r in rules for k, v in r["params"].items() if isinstance(v, int) and not isinstance(v, bool)}
    pkeys, ptypes, pvalues = Counter(), {}, {}
    for r in rules:
        for k, v in r["params"].items():
            pkeys[k] += 1
            ptypes.setdefault(k, set()).add(kind_of(v))
            if k in listed:
                for x in v if isinstance(v, list) else [v]:
                    pvalues.setdefault(k, Counter())[str(x)] += 1
    odd = formula_like(tables)
    unquoted = [s for s in sources if s["rules"] == 0]
    program_sources = {(j["program"].get("application_form") or {}).get("source_id") for j in jurisdictions} | {j["program"].get("phone_source_id") for j in jurisdictions}
    # Who pays for the exam is proof for a held exam line, and a line is held only where an exam_no_bill
    # rule is among the IR's rules (not its skipped list); without one the engine lists exam_payment
    # rules as information.
    holds = {r["jurisdiction"] for r in rules if r["category"] == "exam_no_bill" and r["engine_use"] == "decision"}
    unheld = [r for r in rules if r["category"] == "exam_payment" and r["engine_use"] == "decision" and r["jurisdiction"] not in holds]
    unheld_states = sorted({r["jurisdiction"] for r in unheld})
    names = {j["code"]: j["name"] for j in jurisdictions}
    # Each one says what exam_no_bill rules it has, if any, and why none holds the line.
    why_unheld = []
    for st in unheld_states:
        found = [r for r in rules if r["jurisdiction"] == st and r["category"] == "exam_no_bill"]
        if not found:
            why_unheld.append(f"{names[st]} has no `exam_no_bill` rule in this release.")
        elif len(found) == 1:
            why_unheld.append(f"{names[st]}'s only `exam_no_bill` rule, {found[0]['rule_id']}, is {not_held(found[0])}.")
        else:
            why_unheld.append(f"{names[st]} has {len(found)} `exam_no_bill` rules, and none is a decision rule: " + "; ".join(f"{r['rule_id']} is {not_held(r)}" for r in found) + ".")

    L = [
        f"# {NAME}, version {VERSION}",
        "",
        "Tend's law library as data: the rules of the crime victim compensation programs in the 50 states and",
        f"DC that Tend ({SITE}) found and verified. Each rule pairs a plain-language summary with a verbatim",
        "quote from a source that Tend saved (a statute, a regulation, or a program's own page, PDF, or",
        "application form), the pinpoint citation, the source's address, and the sha256 of the saved copy.",
        "",
        "Tend is a prototype built by Sanat Gupta at MHacks 2026 to help sexual assault survivors claim crime",
        f"victim compensation. This dataset is made from `rules/verified` and `rules/ir` in {REPO} by",
        "`rules/tools/export_dataset.py`.",
        "",
        "Tend is not legal advice. It shows what each program's own rules say, with the quote. The program",
        "decides.",
        "",
        f"## What is in version {VERSION}",
        "",
        f"- {n(c['rules'])} rules for {c['jurisdictions']} jurisdictions{where}, quoted from {n(c['sources_quoted'])} of the {n(c['sources'])} sources Tend saved. The other {n(len(unquoted))} were saved and fingerprinted too, but no rule quotes them.",
        f"- Current as of the dates the sources were saved: {saved_between(first, last)}."
        + (f" {n(sum(c['sources_from_republishers'].values()))} of them are copies from sites that republish state law, which may lag behind it (see Limitations)." if c["sources_from_republishers"] else ""),
        f"- {n(uses['decision'])} decision rules, {n(uses['information'])} information rules, and {n(uses['set_aside'])} set aside (see engine_use below).",
        f"- {n(c['rules_with_fragment_url'])} rules quote an HTML source and have a link that opens the page at the quote.",
        f"- Rules per jurisdiction: from {fewest['rules']} ({fewest['name']}) to {most['rules']} ({most['name']}). The number shows how much Tend found and quoted, not how generous a state's law is.",
        f"- Confidence, as recorded for each jurisdiction: {', '.join(f'{conf[k]} {k}' for k in ('high', 'medium', 'low'))}.",
        "",
        *table(["Source kind", "Sources", "Rules quoting them"], [(k, n(v), n(by_kind[k])) for k, v in c["sources_by_kind"].items()]),
        "",
        "## Files",
        "",
        *table(
            ["File", "What it holds", "Bytes"],
            [
                (f"`{JSON_FILE}`", "Everything in one file: `metadata`, `jurisdictions`, `sources`, and `rules`", n(sizes[JSON_FILE])),
                (f"`{RULES_CSV}`", f"One row per rule ({n(len(rules))} rows)", n(sizes[RULES_CSV])),
                (f"`{SOURCES_CSV}`", f"One row per saved source ({n(len(sources))} rows)", n(sizes[SOURCES_CSV])),
                (f"`{JURISDICTIONS_CSV}`", f"One row per jurisdiction ({n(len(jurisdictions))} rows): the program, coverage notes, and counts", n(sizes[JURISDICTIONS_CSV])),
                ("`README.md`", "This file", ""),
                ("`SHA256SUMS`", "The sha256 of every other file", ""),
            ],
        ),
        "",
        "Check a download with `shasum -a 256 -c SHA256SUMS` (macOS) or `sha256sum -c SHA256SUMS` (Linux),",
        "run in the folder that holds the files.",
        "",
        "The CSV files are UTF-8 without a byte order mark, comma separated, with one header row and LF line",
        "ends. A field is quoted only when it has to be (RFC 4180 quoting); quotes keep their line breaks, so",
        "some quoted fields span lines, which any CSV reader handles. An empty cell means no value (`null` in",
        "the JSON). Booleans are `true` and `false`. Cells that hold an object or a list (`params`,",
        "`coverage_found`, `coverage_not_found`) hold it as JSON.",
        "",
        "In Excel, open a CSV with Data > From Text/CSV and choose UTF-8; opened directly, characters such as",
        "the section sign can show up garbled. Values are written exactly as they are in the rules.",
        *(
            [
                f"{'One cell starts' if len(odd) == 1 else f'{len(odd)} cells start'} with `-`, `=`, `+`, or `@` ("
                + ", ".join(f"the `{col}` of {rid}" for _, rid, col in odd)
                + "), which a spreadsheet may try to read as a formula; import the columns as text to see every",
                "value as written.",
            ]
            if odd
            else []
        ),
        "",
        "## Data dictionary",
        "",
        f"### Rules (`{RULES_CSV}`, and `rules` in the JSON)",
        "",
        "In the JSON, `params` is an object and an empty cell is `null`; otherwise the columns are the same.",
        "",
        *table(
            ["Column", "Type", "Meaning"],
            [
                ("`rule_id`", "text", "The rule's id, unique in the dataset. It starts with the jurisdiction code, for example `MI-EXAM-1`."),
                ("`jurisdiction`", "text", "Two-letter code of the state, or `DC`."),
                ("`jurisdiction_name`", "text", "The jurisdiction's name."),
                ("`category`", "text", "What the rule is about. One of the categories in the table below."),
                ("`expense`", "text or empty", "The expense type the rule is about, one of the expense types below: the rule's own `expense` field, or `params.expense` when that is the only one (`verify.py` and `normalize.py` read it the same way). Empty when the rule is not about one expense type."),
                ("`params`", "JSON object", "The rule's details as the researcher recorded them. See Params below. Money is in cents: `4500000` is $45,000."),
                ("`summary`", "text", "Tend's plain-language reading of the quote. Not a quote, and not the law's words."),
                ("`quote`", "text", "The words of the source, exactly as stored in the rule, line breaks included. See Methodology for how it was checked."),
                ("`pinpoint`", "text", "Where in the source the quote is: a section, subsection, or page, for example `MCL 18.355a(2)`."),
                ("`source_id`", "text", "The source the quote is from. Matches `source_id` in the sources file."),
                ("`source_title`", "text", "The source's title."),
                ("`source_kind`", "text", "`statute`, `regulation`, `agency_page`, `agency_pdf`, or `application_form`."),
                ("`source_url`", "URL", "Where the source was saved from. Some are copies on sites that republish state law; see Limitations."),
                ("`fragment_url`", "URL or empty", "`source_url` with a text fragment (`#:~:text=`) that opens the page at the quote, in browsers that support text fragments. Only for HTML sources; empty for PDFs."),
                ("`retrieved_at`", "timestamp", "When the source was saved, in UTC (ISO 8601)."),
                ("`source_sha256`", "hex", "The sha256 of the saved source file, 64 hex characters."),
                ("`engine_use`", "text", "What Tend's law engine does with the rule: `decision`, `information`, or `set_aside`. See below."),
                ("`set_aside_reason`", "text or empty", "Why `normalize.py` set the rule aside. Empty unless `engine_use` is `set_aside`."),
            ],
        ),
        "",
        "#### Categories",
        "",
        "Meanings and params as `rules/SCHEMA.md` defines them.",
        "",
        *table(
            ["`category`", "Meaning", "Params (rules/SCHEMA.md)", "Rules", "Jurisdictions"],
            [(f"`{k}`", meaning, params, n(c["rules_by_category"].get(k, 0)), cat_states[k]) for k, (meaning, params) in cats.items()],
        ),
        "",
        "#### Expense types",
        "",
        *table(["`expense`", "Rules"], [(f"`{e}`", n(by_expense[e])) for e in expenses]),
        "",
        f"{n(sum(1 for r in rules if not r['expense']))} rules name no expense type.",
        "",
        "#### Params",
        "",
        "`params` holds what `rules/SCHEMA.md` asks for in each category (the table above). Researchers also",
        "added keys the schema does not define where it had no field; their meaning is in the rule's quote.",
        "`normalize.py` reads three of them: `applies_to` (a rule that applies to someone other than the",
        "survivor is set aside), `scope` (a reporting rule or cap with a scope becomes information), and",
        "`within_hours` (turned into days, rounded up).",
        f"`verify.py` checks that the numbers in {series(f'`{k}`' for k in VERIFY_NUMBER_KEYS)} appear in the quote.",
        f"In this release every integer value in `params` does, including the keys `verify.py` does not check ({series(f'`{k}`' for k in sorted(integer_keys - set(VERIFY_NUMBER_KEYS)))}).",
        "Numbers written inside text values, such as section numbers in a `note` or `extension`, are not checked.",
        "",
        *table(
            ["Key", "Rules", "Types", "In rules/SCHEMA.md"],
            [(f"`{k}`", n(v), ", ".join(sorted(ptypes[k])), "yes" if k in schema_keys else "no") for k, v in sorted(pkeys.items(), key=lambda kv: (-kv[1], kv[0]))],
        ),
        "",
        "Values found for the keys `rules/SCHEMA.md` gives a fixed list for. Values in the last column are",
        "not in the schema's list.",
        "",
        *table(
            ["Key", "Schema values (rules in this release)", "Other values (rules)"],
            [
                (
                    f"`{k}`",
                    ", ".join(f"{v} ({pvalues.get(k, Counter())[v]})" for v in listed[k]),
                    ", ".join(f"{v} ({m})" for v, m in sorted(pvalues.get(k, Counter()).items()) if v not in listed[k]) or "none",
                )
                for k in LISTED_PARAMS
            ],
        ),
        "",
        "#### engine_use",
        "",
        "`rules/tools/normalize.py` turns each verified file into the law IR the engine runs (`rules/ir/ST.json`).",
        "The IR either carries a rule, as a decision or as information, or lists it under `skipped` with a reason.",
        "",
        *table(
            ["Value", "Rules", "Meaning"],
            [
                ("`decision`", n(uses["decision"]), "Compiled into the law the engine runs: exam billing and who pays for the exam, total caps, caps on one expense, covered and excluded expenses, filing deadlines, police reporting, minimum loss, and paying after insurance (`collateral_source`). Such a rule can decide a line's status or amount or a check's result, or be cited as proof for one. Where several rules of one kind apply, `docs/SPEC.md` says how they combine; for example, the smallest total cap and the longest deadline are used."),
                ("`information`", n(uses["information"]), "Shown with its quote. It changes no amount and no status."),
                ("`set_aside`", n(uses["set_aside"]), "Not used. `set_aside_reason` says why."),
            ],
        ),
        "",
        "How `normalize.py` decides:",
        "",
        "- Information: every rule in `conduct_reduction`, `emergency_award`, `eligible_crime`, `residency`,",
        "  `submission`, `required_document`, `processing_time`, `address_confidentiality`, and",
        "  `record_confidentiality`. Also a rule the engine cannot apply as written: a covered expense with no",
        "  expense type; an exclusion whose item matches none of the engine's tags (phone, purse, jewelry, cash,",
        "  vehicle, pain and suffering), or that names neither an expense nor an item; a deadline with no length,",
        "  or one counted from something other than the crime, the incident, its discovery, the injury, the",
        "  offense, or the police report (an 18th birthday, for example); a minimum loss with no amount and no",
        "  number of days, unless its quote says there is no minimum; a reporting rule or a cap on one expense",
        "  whose `params` has a `scope`; and two caps whose own quote describes something other than the program's limit on the",
        "  survivor's cost (NV-CAP-WAGE-3, an approval a Compensation Officer may give alone, and TX-EXAM-3, an",
        "  emergency payment made apart from the award).",
        "- Set aside: a rule whose `params.applies_to` does not name the survivor (it names family members or",
        "  secondary victims, or a narrower case such as travel to court or crimes from certain dates); a cap",
        "  with no amount, no expense type, or a unit `normalize.py` cannot read; and a cap that duplicates",
        "  another cap on the same expense and unit and is no more generous. The most generous cap is kept, the",
        f"  first of them when two are equal; of those set aside, {dupes['lower']} are lower than the cap kept and {dupes['equal']} {'is' if dupes['equal'] == 1 else 'are'} equal",
        "  to it. Their `set_aside_reason` says \"less generous duplicate of\" either way.",
        "- Decision: every other rule.",
        "",
        "`normalize.py` can also narrow how a decision rule applies. AK-COUNSEL-1, for example, keeps its $200",
        "a session rate but not its 24-session initial award. `rules/ir` has the engine's exact reading of",
        "every rule.",
        "",
        *(
            [
                "One kind of decision rule can end up as information. Who pays for the exam (`exam_payment`) is cited",
                "as proof for a held exam line, and the engine holds an exam line only where the jurisdiction has an",
                "`exam_no_bill` rule with `engine_use` decision.",
                *why_unheld,
                f"So the engine lists {'its' if len(unheld_states) == 1 else 'their'} {len(unheld)} `exam_payment` {'rule' if len(unheld) == 1 else 'rules'} ({', '.join(r['rule_id'] for r in unheld)}) as information.",
                "",
            ]
            if unheld
            else []
        ),
        *table(["Reasons for set_aside", "Rules"], [(k, n(v)) for k, v in sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))]),
        "",
        f"### Sources (`{SOURCES_CSV}`, and `sources` in the JSON)",
        "",
        *table(
            ["Column", "Type", "Meaning"],
            [
                ("`source_id`", "text", "The source's id, unique in the dataset, for example `MI-S4`."),
                ("`jurisdiction`", "text", "Two-letter code of the state, or `DC`."),
                ("`title`", "text", "The source's title."),
                ("`kind`", "text", "`statute`, `regulation`, `agency_page`, `agency_pdf`, or `application_form`."),
                ("`format`", "text", "`html` or `pdf`: the saved file's type, read from its extension the way `verify.py` reads it."),
                ("`url`", "URL", "Where the source was saved from. Some are copies on sites that republish state law; see Limitations."),
                ("`retrieved_at`", "timestamp", "When it was saved, in UTC (ISO 8601)."),
                (
                    "`sha256`",
                    "hex",
                    "The sha256 of the saved file, recorded when it was saved."
                    + (f" For the {n(c['sources_redacted'])} pages whose `note` says so, it was recorded again after API keys embedded in the page were redacted." if c["sources_redacted"] else "")
                    + " `verify.py` checks it on every run.",
                ),
                ("`text_sha256`", "hex", "The sha256 of the text extracted from the saved file, which quotes are matched against. Computed by the export; not recorded when the source was saved."),
                ("`raw_path`", "path", f"The saved file in the repository ({REPO})."),
                ("`text_path`", "path", "The extracted text in the repository."),
                ("`note`", "text or empty", "A note about the saved copy."),
                ("`rules`", "integer", f"How many rules quote this source. It is 0 for {n(len(unquoted))} sources, which were saved but are quoted by no rule; {len([s for s in unquoted if s['source_id'] in program_sources])} of those are where a program's phone number or application form comes from."),
            ],
        ),
        "",
        f"### Jurisdictions (`{JURISDICTIONS_CSV}`, and `jurisdictions` in the JSON)",
        "",
        "In the JSON, the `program_name` to `statute_citation` columns and the `application_form_` columns are",
        "the `program` object (with `application_form` inside it), and the `coverage_` columns are the",
        "`coverage` object, all as written in `rules/verified/ST.json`.",
        "",
        *table(
            ["Column", "Type", "Meaning"],
            [
                ("`code`", "text", "Two-letter code of the state, or `DC`."),
                ("`name`", "text", "The jurisdiction's name."),
                ("`program_name`", "text", "The compensation program's name."),
                ("`agency`", "text", "The agency that runs it."),
                ("`website`", "URL", "The program's website."),
                ("`apply_url`", "URL", "Where the program says how to apply."),
                ("`application_pdf_url`", "URL or empty", "The application form, when there is one to download."),
                ("`phone`", "text", "The program's phone number."),
                ("`phone_source_id`", "text", "The source the phone number was taken from."),
                ("`statute_citation`", "text", "The statute that sets up the program."),
                (
                    "`application_form_source_id`",
                    "text or empty" if no_form else "text",
                    "The saved copy of the application form."
                    + (f" Empty for {series(no_form)}, which {'has' if len(no_form) == 1 else 'have'} none saved." if no_form else ""),
                ),
                ("`application_form_fillable`", "boolean", "Whether that PDF has fillable fields; `false` when no form is saved."),
                ("`application_form_field_count`", "integer", "How many fields it has; `0` when no form is saved."),
                ("`confidence`", "text", "`high`, `medium`, or `low`, as recorded for the jurisdiction."),
                (
                    "`coverage_found`",
                    "JSON list of text",
                    "Categories the research found for this jurisdiction."
                    + (f" {series(paired_in)} also {'lists' if len(paired_in) == 1 else 'list'} some as category:expense, for example `{paired[0]}`." if paired else ""),
                ),
                ("`coverage_not_found`", "JSON list of text", "What the research looked for and did not find or could not verify, in its own words."),
                ("`coverage_notes`", "text", "Notes on what was and was not found."),
                ("`researcher_notes`", "text", "Anything a reviewer should know, such as where sources disagree."),
                ("`rules`", "integer", "Rules for this jurisdiction."),
                ("`sources`", "integer", "Saved sources for this jurisdiction."),
                ("`decision_rules`", "integer", "Rules with `engine_use` decision."),
                ("`information_rules`", "integer", "Rules with `engine_use` information."),
                ("`set_aside_rules`", "integer", "Rules with `engine_use` set_aside."),
                ("`verified_sha256`", "hex", "The sha256 of `rules/verified/ST.json` in the repository. A law image compiled from that file names the same sha256 in its header."),
                ("`ir_sha256`", "hex", "The sha256 of `rules/ir/ST.json`, where `engine_use` comes from."),
            ],
        ),
        "",
        f"### `{JSON_FILE}`",
        "",
        "One object with four keys. `metadata` has `name`, `version`, `description`, `homepage`, `repository`,",
        "`generated_by`, `current_as_of` (the first and last `retrieved_at` of the sources), `counts`, `license`,",
        "and `not_legal_advice`. It has no timestamp of its own. `jurisdictions`, `sources`, and `rules` are",
        "arrays with the columns described above.",
        "",
        "## Methodology",
        "",
        "How the rules were made, as `rules/SCHEMA.md` and `docs/ARCHITECTURE.md` in the repository describe it:",
        "",
        "1. Save the source. `rules/tools/fetch_source.py` saves the raw bytes of a page or PDF, the text",
        "   extracted from it, and the sha256 of the raw bytes. It tries a plain HTTPS request first and falls",
        "   back to a real Chrome tab when a site serves a challenge page.",
        "2. Write the rule. A researcher writes the rule in `rules/jurisdictions/ST.json`: its category,",
        "   params, a plain summary, the quote, copied from the saved text and never paraphrased, and a pinpoint",
        "   citation. `rules/SCHEMA.md` tells researchers to prefer statutes and regulations, to use agency",
        "   pages and PDFs when they state the rule more plainly or the statute is unavailable, to let statutes",
        "   win when sources disagree and record the disagreement in `researcher_notes`, and never to name",
        "   people, describe specific crimes, or cite case law.",
        "3. Verify. `rules/tools/verify.py` accepts a rule only if three things hold:",
        "   - Its quote is a substring of the saved source's text after both are normalized the same way:",
        "     Unicode NFKC, soft hyphens removed, curly quotes made straight, en and em dashes made hyphens,",
        "     and each run of whitespace made one space.",
        "   - The numbers in its params and its summary appear in the quote: `amount_cents` (as dollars),",
        "     `years`, `months`, `weeks`, `days`, `within_days`, `count_limit`, and `days_lost`, and every number",
        "     in the summary except 0 and 1. Numbers written as words count: \"thirty days\" is 30.",
        "   - The saved source file's sha256 still matches the one recorded for it.",
        "",
        "   `verify.py` also accepts a quote that matches only when case is ignored, with a warning. No quote",
        "   in this release needs that: each one matches with its case as written. Passing files go to",
        "   `rules/verified`, with a text-fragment link for each rule from an HTML source.",
        "4. Decide what the engine does with each rule. `rules/tools/normalize.py` writes the law IR",
        "   (`rules/ir`) and so decides `engine_use`, as described above.",
        "5. Export. `rules/tools/export_dataset.py` reads `rules/verified` and `rules/ir` and writes these files.",
        "   It reads no clock, so the same inputs give the same bytes.",
        "",
        "Check it yourself, from a clone of the repository:",
        "",
        "```sh",
        "python3 rules/tools/verify.py all                    # every jurisdiction prints PASS",
        "python3 rules/tools/export_dataset.py --check        # these files match the rules they came from",
        "uv run --with pytest pytest rules/tools/test_export_dataset.py",
        "```",
        "",
        "The tests check every quote against its saved source text with `verify.py`'s own normalization,",
        "every sha256 against the saved files, that the CSV and JSON files agree, and that the export gives",
        "the same bytes each time.",
        "",
        "The sha256 recorded for a source covers its raw file, not the extracted text (`text_path`) that quotes",
        "are matched against. With BeautifulSoup and pdftotext installed, the tests also extract the text again",
        "from each raw file and look for every quote in it:",
        "",
        "```sh",
        "uv run --with pytest --with beautifulsoup4 pytest rules/tools/test_export_dataset.py",
        "```",
        "",
        f"In version {VERSION}, every quote is found that way too: in all the text BeautifulSoup reads from an",
        "HTML page, and in what pdftotext 26.04 reads from a PDF.",
        "",
        "## Limitations",
        "",
        "- A verbatim quote check proves the words exist in the saved source. It does not prove that Tend's",
        "  reading of them is right. The category, the params, the summary, and `engine_use` are Tend's",
        "  interpretation, and a rule can be misread even when its quote is exact.",
        "- Summaries are Tend's plain-language readings, not the law. Rely on the quote and the source.",
        f"- The data is current as of the dates the sources were saved ({day(first)}" + ("" if first[:10] == last[:10] else f" to {day(last)}") + "). Laws and program",
        "  pages change, and nothing re-fetches the sources on a schedule.",
        *republished(sources, rules),
        "- A sha256 shows that the saved copy has not changed since its sha256 was recorded. It cannot show what",
        "  the live page says today, and a live page can differ byte for byte even when its text is the same.",
        *(
            [f"- {n(sum(notes.values()))} saved pages carry the same `note`: \"{next(iter(notes))}\""]
            if len(notes) == 1
            else [f"- {n(sum(notes.values()))} saved pages carry a `note` about the saved copy. Read it before comparing that copy with the live page."]
            if notes
            else []
        ),
        "- Quotes are matched against the text extracted from each saved file (`text_path`). Text the",
        "  extraction missed could not be quoted.",
        "- Coverage gaps are gaps in Tend's research, not findings about the law. When a category is missing",
        "  for a jurisdiction, or listed in `coverage_not_found`, Tend did not find or verify it in the sources",
        "  it saved. The law may still provide it.",
        "- The dataset is not a full copy of any program's rules. The categories in `rules/SCHEMA.md` are built",
        "  around a sexual assault survivor's own claim.",
        "- Text-fragment links exist only for HTML sources. They open at the quote only in browsers that",
        "  support text fragments, and only while the live page still has those words.",
        "- Some `params` keys are not defined in `rules/SCHEMA.md` (see Params). Read their rule's quote.",
        "- Not legal advice. The program decides.",
        "",
        "## How to cite",
        "",
        "> **TODO (Sanat): placeholder.** Add the citation once the release is published. There is no DOI",
        "> yet; do not cite one. Shape to fill in: Sanat Gupta, *Tend verified rules*, version 1.0 [data set],",
        "> [release URL], [DOI, if one is minted].",
        "",
        "## License",
        "",
        "> **TODO (Sanat): no license has been chosen yet.** Suggested for the data: CC BY 4.0. Until a",
        "> license is added here, this dataset has no stated license.",
        "",
        "## Contact",
        "",
        "> **TODO (Sanat): placeholder.** Add an address for corrections and questions.",
        "",
    ]
    return "\n".join(L)


# --- Output ----------------------------------------------------------------------------------------

def build() -> dict:
    """Every output file name -> its bytes."""
    jurisdictions, sources, rules = collect(load())
    meta = metadata(jurisdictions, sources, rules)
    doc = {"metadata": meta, "jurisdictions": jurisdictions, "sources": sources, "rules": rules}
    flat = [flat_jurisdiction(j) for j in jurisdictions]
    files = {
        JSON_FILE: (json.dumps(doc, indent=1, ensure_ascii=False) + "\n").encode("utf-8"),
        RULES_CSV: to_csv(RULE_COLUMNS, rules),
        SOURCES_CSV: to_csv(SOURCE_COLUMNS, sources),
        JURISDICTIONS_CSV: to_csv(JURISDICTION_COLUMNS, flat),
    }
    tables = {
        RULES_CSV: (RULE_COLUMNS, rules, "rule_id"),
        SOURCES_CSV: (SOURCE_COLUMNS, sources, "source_id"),
        JURISDICTIONS_CSV: (JURISDICTION_COLUMNS, flat, "code"),
    }
    text = readme(meta, jurisdictions, sources, rules, {k: len(v) for k, v in files.items()}, tables)
    if not text.isascii():
        sys.exit("the README must stay ASCII")
    files["README.md"] = text.encode("ascii")
    files["SHA256SUMS"] = "".join(f"{sha256(files[k])}  {k}\n" for k in sorted(files)).encode("ascii")
    return files


def shown(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def stale(files: dict) -> list:
    out = []
    for folder in OUT_DIRS:
        for name, data in files.items():
            path = folder / name
            if not path.is_file() or path.read_bytes() != data:
                out.append(path)
    return out


def main(argv: list) -> int:
    if argv not in ([], ["--check"]):
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    files = build()
    if argv == ["--check"]:
        old = stale(files)
        for path in old:
            print(f"stale: {shown(path)}")
        if old:
            print("run python3 rules/tools/export_dataset.py")
            return 1
        print(f"dataset v{VERSION} is current ({len(files)} files in {len(OUT_DIRS)} folders)")
        return 0
    for folder in OUT_DIRS:
        folder.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            (folder / name).write_bytes(data)
    meta = json.loads(files[JSON_FILE])["metadata"]["counts"]
    print(f"dataset v{VERSION}: {meta['rules']} rules, {meta['sources']} sources, {meta['jurisdictions']} jurisdictions")
    for folder in OUT_DIRS:
        print(f"  wrote {shown(folder)}/ ({len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
