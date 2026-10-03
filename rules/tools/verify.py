"""Check a jurisdiction file against its saved sources. Prints PASS or the problems.

usage: python3 rules/tools/verify.py ST [ST ...]   (or: all)

A rule passes only if its quote is a verbatim substring of its source text (after Unicode and
whitespace normalization), every number in its params and summary appears in the quote, and the
source file's sha256 still matches. Passing files are written to rules/verified/ST.json with a
text-fragment link for HTML sources.
"""
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
CATEGORIES = {"exam_no_bill", "exam_payment", "total_cap", "expense_cap", "covered_expense", "excluded_expense", "filing_deadline", "reporting_requirement", "minimum_loss", "collateral_source", "conduct_reduction", "emergency_award", "eligible_crime", "residency", "submission", "required_document", "processing_time"}
EXPENSES = {"medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation", "temporary_housing", "security", "crime_scene_cleanup", "childcare", "property_replacement", "clothing_bedding", "prescription", "dental", "funeral", "legal", "tuition", "other"}
NUMERIC_PARAMS = {"amount_cents", "years", "days", "within_days", "count_limit", "days_lost", "weeks", "months"}
WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("­", "").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = s.replace("–", "-").replace("—", "-").replace(" ", " ").replace("§", "§")
    return re.sub(r"\s+", " ", s).strip()


def numbers_in(text: str) -> set:
    found = set()
    for m in re.finditer(r"\d[\d,]*(?:\.\d+)?", text):
        tok = m.group().replace(",", "")
        try:
            v = float(tok)
            found.add(v)
            found.add(int(v))
        except ValueError:
            pass
    toks = re.findall(r"[a-z]+", text.lower().replace("-", " "))
    cur, total, active = 0, 0, False
    for t in toks + ["end"]:
        if t in WORDS:
            cur += WORDS[t]
            active = True
        elif t in SCALES and active:
            if SCALES[t] == 100:
                cur *= 100
            else:
                total += cur * SCALES[t]
                cur = 0
        elif t == "and" and active:
            continue
        else:
            if active:
                found.add(total + cur)
            cur, total, active = 0, 0, False
    return found


def money_in_quote(cents: int, quote_nums: set) -> bool:
    dollars = cents / 100
    return dollars in quote_nums or int(dollars) in quote_nums


def fragment(url: str, quote_text: str) -> str:
    words = quote_text.split()
    enc = lambda s: quote(s, safe="").replace("-", "%2D")
    if len(words) <= 10:
        return f"{url}#:~:text={enc(quote_text)}"
    return f"{url}#:~:text={enc(' '.join(words[:5]))},{enc(' '.join(words[-5:]))}"


def check(st: str):
    errors, warnings = [], []
    path = ROOT / "rules" / "jurisdictions" / f"{st}.json"
    if not path.exists():
        return [f"{path} missing"], [], None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return [f"invalid JSON: {e}"], [], None
    for k in ("jurisdiction", "name", "program", "sources", "rules", "coverage", "confidence"):
        if k not in data:
            errors.append(f"missing top-level key: {k}")
    if errors:
        return errors, warnings, None
    if data["jurisdiction"].upper() != st:
        errors.append(f"jurisdiction is {data['jurisdiction']}, file is {st}")

    texts, kinds, urls = {}, {}, {}
    for s in data["sources"]:
        sid = s.get("id", "?")
        if sid in texts:
            errors.append(f"duplicate source id {sid}")
        tp, rp = ROOT / s.get("text_path", ""), ROOT / s.get("raw_path", "")
        if not tp.is_file() or not rp.is_file():
            errors.append(f"{sid}: snapshot files missing ({s.get('text_path')}, {s.get('raw_path')})")
            continue
        if hashlib.sha256(rp.read_bytes()).hexdigest() != s.get("sha256"):
            errors.append(f"{sid}: sha256 does not match {s.get('raw_path')}")
        texts[sid] = norm(tp.read_text(encoding="utf-8", errors="ignore"))
        kinds[sid] = "pdf" if str(rp).endswith(".pdf") else "html"
        urls[sid] = s.get("url", "")

    ids = set()
    for r in data["rules"]:
        rid = r.get("id", "?")
        if rid in ids:
            errors.append(f"duplicate rule id {rid}")
        ids.add(rid)
        if r.get("category") not in CATEGORIES:
            errors.append(f"{rid}: unknown category {r.get('category')}")
        exp = r.get("expense") or (r.get("params") or {}).get("expense")
        if exp and exp not in EXPENSES:
            errors.append(f"{rid}: unknown expense {exp}")
        if not r.get("pinpoint"):
            errors.append(f"{rid}: missing pinpoint citation")
        sid, q = r.get("source_id"), norm(r.get("quote", ""))
        if not q:
            errors.append(f"{rid}: empty quote")
            continue
        if len(q) > 700:
            warnings.append(f"{rid}: quote is long ({len(q)} chars); trim to the operative sentence")
        if sid not in texts:
            errors.append(f"{rid}: source {sid} not found or not saved")
            continue
        if q not in texts[sid]:
            if q.lower() in texts[sid].lower():
                warnings.append(f"{rid}: quote matches only case-insensitively")
            else:
                errors.append(f"{rid}: quote is not a verbatim substring of {sid}: {q[:90]!r}")
                continue
        qn = numbers_in(q)
        for k, v in (r.get("params") or {}).items():
            if k not in NUMERIC_PARAMS or v is None:
                continue
            ok = money_in_quote(v, qn) if k == "amount_cents" else (v in qn)
            if not ok:
                errors.append(f"{rid}: params.{k}={v} does not appear in the quote")
        for n in numbers_in(r.get("summary", "")):
            if n not in qn and n not in (0, 1):
                errors.append(f"{rid}: summary number {n} is not in the quote")
        if kinds[sid] == "html" and urls[sid]:
            r["fragment_url"] = fragment(urls[sid], r.get("quote", "").strip())
    return errors, warnings, data


def main():
    sts = sys.argv[1:]
    if sts == ["all"]:
        sts = sorted(p.stem for p in (ROOT / "rules" / "jurisdictions").glob("*.json"))
    outdir = ROOT / "rules" / "verified"
    outdir.mkdir(exist_ok=True)
    bad = 0
    for st in sts:
        st = st.upper()
        errors, warnings, data = check(st)
        for w in warnings:
            print(f"{st} WARN {w}")
        for e in errors:
            print(f"{st} FAIL {e}")
        if errors:
            bad += 1
        else:
            (outdir / f"{st}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False))
            print(f"{st} PASS ({len(data['rules'])} rules, {len(data['sources'])} sources)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
