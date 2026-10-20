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
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
CATEGORIES = {"exam_no_bill", "exam_payment", "total_cap", "expense_cap", "covered_expense", "excluded_expense", "filing_deadline", "reporting_requirement", "minimum_loss", "collateral_source", "conduct_reduction", "emergency_award", "eligible_crime", "residency", "submission", "required_document", "processing_time", "address_confidentiality", "record_confidentiality"}
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


# Characters a word may run across (Unicode UAX #29, which browsers use through ICU): letters on both sides
# of an apostrophe, a period or a colon stay one word ("victim's"), and so do digits on both sides of a
# period, comma or semicolon ("1,000").
_MID_LETTER = frozenset("'\u2019\u2018.:\xb7")
_MID_NUMBER = frozenset("'\u2019\u2018.,;")


def _word_class(ch: str) -> str:
    return "L" if ch.isalpha() else "N" if ch.isdigit() else ""


def _is_boundary(text: str, p: int) -> bool:
    """Whether a browser sees a word boundary at position p of text."""
    if p <= 0 or p >= len(text):
        return True
    a, b = text[p - 1], text[p]
    if a.isalnum() and b.isalnum():
        return False
    for x, mid, y in ((a, b, text[p + 1] if p + 1 < len(text) else ""), (text[p - 2] if p >= 2 else "", a, b)):
        k = _word_class(x)
        if k and k == _word_class(y) and mid in (_MID_LETTER if k == "L" else _MID_NUMBER):
            return False
    return True


def _first_word_match(text: str, term: str, start: int = 0, end_bound: bool = True) -> int:
    """Where a browser's text fragment would first find term: case-insensitive (text and term are
    folded by the caller), starting at a word boundary, and ending at one when end_bound is set."""
    i = text.find(term, start)
    while i >= 0:
        if _is_boundary(text, i) and (not end_bound or _is_boundary(text, i + len(term))):
            return i
        i = text.find(term, i + 1)
    return -1


# How a browser reads a page for a text fragment (the text-fragment spec). It searches one block of text at
# a time, so a term never spans two blocks. It ignores case and curly quotes. The start term must begin at a
# word boundary, and the spec makes it end at one only when no end term follows (Chrome asks for both; the
# links here meet the spec's looser rule, so they work either way). The end term must begin and end at word
# boundaries, and it is the first match after the start term. The page model below keeps the saved HTML's
# blocks, which the flattened .txt loses.
_BLOCK_TAGS = frozenset(
    "address article aside blockquote body center dd details dialog dir div dl dt fieldset figcaption figure "
    "footer form frameset h1 h2 h3 h4 h5 h6 header hgroup hr html legend li listing main menu nav ol p plaintext "
    "pre search section summary table ul xmp".split()
)
# Table cells and rows, line breaks and form controls: a term stays inside them too, but a search is allowed
# to run across them, since browsers differ on these.
_BREAK_TAGS = frozenset(
    "br caption col colgroup td th thead tbody tfoot tr option optgroup select textarea button input img iframe "
    "svg math video audio object embed canvas".split()
)
_SKIP_TAGS = frozenset({"script", "style", "title", "template"})
# Elements whose whitespace a browser keeps as written (Texas statutes sit inside one <pre>).
_PRE_TAGS = frozenset({"pre", "xmp", "listing", "plaintext", "textarea"})
_VOID_TAGS = frozenset("area base br col embed hr img input link meta param source track wbr".split())
# A style that lays an element out on its own (Utah's rule page sets each line in an absolutely positioned
# span) or keeps its whitespace. Read from the element's style attribute and the page's own <style> classes.
_OWN_BOX = re.compile(r"position\s*:\s*(absolute|fixed)|display\s*:\s*(block|flex|grid|table|list-item|flow-root|inline-block)", re.I)
_KEEP_SPACE = re.compile(r"white-space\s*:\s*(pre|pre-wrap|break-spaces)\s*(;|$|!)", re.I)
_BLOCK, _BREAK = "\x00", "\x01"
_QUOTE_FOLD = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})


def _style_classes(html: str) -> tuple[frozenset, frozenset]:
    """Class names that the page's own <style> rules lay out on their own box, and those that keep their
    whitespace. Only plain ".name" selectors are read."""
    own, keep = set(), set()
    for css in re.findall(r"<style[^>]*>(.*?)</style>", html, re.S | re.I):
        for selectors, decl in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
            names = [m.group(1) for m in (re.fullmatch(r"\s*\.([\w-]+)\s*", s) for s in selectors.split(",")) if m]
            if names and _OWN_BOX.search(decl):
                own.update(names)
            if names and _KEEP_SPACE.search(decl):
                keep.update(names)
    return frozenset(own), frozenset(keep)


class _PageText(HTMLParser):
    def __init__(self, own_box: frozenset = frozenset(), keep_space: frozenset = frozenset()):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.pre = 0
        self.own_box, self.keep_space = own_box, keep_space
        # Open elements with their own style: (tag, laid out on its own, keeps whitespace).
        self.open: list[tuple[str, bool, bool]] = []

    def _mark(self, tag: str) -> None:
        if tag in _BLOCK_TAGS:
            self.parts.append(_BLOCK)
        elif tag in _BREAK_TAGS:
            self.parts.append(_BREAK)

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self.skip += 1
            return
        if tag == "body":
            self.skip = 0
        if tag in _PRE_TAGS:
            self.pre += 1
        self._mark(tag)
        if tag in _VOID_TAGS:
            return
        a = dict(attrs)
        classes = set((a.get("class") or "").split())
        style = a.get("style") or ""
        own = bool(classes & self.own_box) or bool(_OWN_BOX.search(style))
        keep = bool(classes & self.keep_space) or bool(_KEEP_SPACE.search(style))
        self.open.append((tag, own, keep))
        if own:
            self.parts.append(_BREAK)
        if keep:
            self.pre += 1

    def handle_startendtag(self, tag, attrs):
        self._mark(tag)

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
            return
        if tag in _PRE_TAGS:
            self.pre = max(0, self.pre - 1)
        self._mark(tag)
        if any(t == tag for t, _, _ in self.open):
            while self.open:
                t, own, keep = self.open.pop()
                if own:
                    self.parts.append(_BREAK)
                if keep:
                    self.pre = max(0, self.pre - 1)
                if t == tag:
                    break

    def handle_data(self, data):
        if self.skip:
            return
        if self.pre:
            # Kept whitespace: one space reads as a space, any other run (two spaces, a tab, a newline)
            # stays as written, so a term never spans it.
            data = re.sub(r"\s+", lambda m: " " if m.group(0) in (" ", "\xa0") else _BREAK, data)
        self.parts.append(data)


def _space(m: re.Match) -> str:
    """A run of whitespace as a browser renders it. Spaces, tabs and newlines collapse to one space, and a
    single no-break space reads as a space. Any other run (several no-break spaces, or one beside a space)
    stays as wide as it is, so a term never spans it and it counts as a line break here."""
    run = m.group(0)
    return " " if run == "\xa0" or not run.strip(" \t\n\r\f") else _BREAK


def page_model(raw: bytes) -> tuple[str, str, list[int]]:
    """A saved HTML page as a browser searches it: its text with each block boundary as \\x00 and each
    table-cell, row or line break as \\x01, whitespace collapsed as rendered (_space; kept as written inside
    <pre>). Also the same text folded like norm() and lowercased, with the index of each folded character in
    the text, to find quotes in it."""
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError:
        html = raw.decode("cp1252", errors="replace")
    parser = _PageText(*_style_classes(html))
    parser.feed(html)
    parser.close()
    text = re.sub(r"[^\S\x00\x01]+", _space, "".join(parser.parts).replace("\xad", ""))
    text = re.sub(r" *[\x00\x01][ \x00\x01]*", lambda m: _BLOCK if _BLOCK in m.group(0) else _BREAK, text)
    text = text.strip(" \x00\x01")
    folded, index = [], []
    for i, ch in enumerate(text):
        for f in _fold_char(ch):
            folded.append(f)
            index.append(i)
    return text, "".join(folded), index


@lru_cache(maxsize=None)
def _fold_char(ch: str) -> str:
    if ch in (_BLOCK, _BREAK):
        return ch
    return norm(ch).lower() if ch.strip() else " "


def _browser_fold(text: str) -> str:
    """What a browser's search ignores (case and curly quotes), one character for one."""
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text).translate(_QUOTE_FOLD)


def _block_fragment(url: str, quote_text: str, page: tuple[str, str, list[int]]) -> str | None:
    """A text-fragment link whose terms each sit inside one block of the saved page and whose first
    matches, as a browser finds them, are the quote's own start and end. The terms are the page's own
    words. None when the quote cannot be placed in the page model."""
    text, folded, index = page
    words = norm(quote_text).lower().split()
    if not words:
        return None
    m = re.search(r"[ \x00\x01]*".join(re.escape(w) for w in words), folded)
    if not m:
        return None
    start, end = index[m.start()], index[m.end() - 1] + 1
    toks = [(start + t.start(), start + t.end()) for t in re.finditer(r"[^ \x00\x01]+", text[start:end])]
    n = len(toks)
    # Which block or line each word sits in: any break between two words starts a new one.
    seg = [0]
    for (_, e0), (s1, _) in zip(toks, toks[1:]):
        seg.append(seg[-1] + (1 if re.search(r"[\x00\x01]", text[e0:s1]) else 0))
    search = _browser_fold(text.replace(_BREAK, " "))

    # A quote cut inside a word as a browser splits words ("Victim" before "'s") gets the rest of that
    # word, since a term has to start and end on a word boundary.
    def left(i: int) -> int:
        p = toks[i][0]
        while not _is_boundary(search, p):
            p -= 1
        return p

    def right(j: int) -> int:
        p = toks[j - 1][1]
        while not _is_boundary(search, p):
            p += 1
        return p

    span = lambda i, j: text[left(i) : right(j)]
    enc = lambda s: quote(s, safe="").replace("-", "%2D")

    def unique(term: str, at: int, end_bound: bool) -> bool:
        return _first_word_match(search, _browser_fold(term), 0, end_bound) == at

    one_block = seg[-1] == 0
    if one_block and n <= 10 and unique(span(0, n), left(0), True):
        return f"{url}#:~:text={enc(span(0, n))}"
    # The start term is the first words of the quote's first block that a browser finds there first. If
    # that block's words all appear earlier on the page (a list marker such as "(a)" alone, or a sentence
    # the statute repeats), the highlight starts at the next block of the quote instead; likewise the end
    # term comes from the last block, or the one before it.
    firsts = [i for i in range(n) if i == 0 or seg[i] != seg[i - 1]]
    lasts = [i + 1 for i in range(n) if i == n - 1 or seg[i] != seg[i + 1]]
    for s in firsts:
        size = seg.count(seg[s])
        k = next((k for k in range(min(5, size), size + 1) if unique(span(s, s + k), left(s), False)), None)
        if k is None:
            continue
        after = right(s + k)
        for e in reversed(lasts):
            size = seg.count(seg[e - 1])
            for m_ in range(min(5, size), size + 1):
                if e - m_ < s + k:
                    break
                term = span(e - m_, e)
                j = _first_word_match(search, _browser_fold(term), after, True)
                if j >= 0 and j + len(term) == right(e):
                    return f"{url}#:~:text={enc(span(s, s + k))},{enc(term)}"
            # Start and end words would meet inside one block: that block's words are the whole term.
            if seg[e - 1] == seg[s] and unique(span(s, e), left(s), True):
                return f"{url}#:~:text={enc(span(s, e))}"
        break
    if one_block:
        return f"{url}#:~:text={enc(span(0, n))}"
    return None


def fragment(url: str, quote_text: str, page_text: str = "", page: tuple[str, str, list[int]] | None = None) -> str:
    """A text-fragment link that highlights the quote itself. With the saved HTML's page model, each term
    stays inside one block and is the page's own words (_block_fragment). Without it, or when the quote
    cannot be placed in it, the flattened saved text is used: the browser highlights from the first match
    of the start words to the first match of the end words after it, so each term grows a word at a time
    until its first match is the quote's own start (and end). When the two terms would meet, the whole
    quote is the fragment."""
    if page is not None:
        link = _block_fragment(url, quote_text, page)
        if link:
            return link
    words = quote_text.split()
    enc = lambda s: quote(s, safe="").replace("-", "%2D")
    whole = f"{url}#:~:text={enc(quote_text)}"
    if len(words) <= 10:
        return whole
    text = page_text.lower()
    nw = [norm(w).lower() for w in words]
    target = " ".join(nw)
    at = text.find(target)
    if at < 0:
        return f"{url}#:~:text={enc(' '.join(words[:5]))},{enc(' '.join(words[-5:]))}"
    k = 5
    while k < len(words) and _first_word_match(text, " ".join(nw[:k])) != at:
        k += 1
    after_start = at + len(" ".join(nw[:k]))
    end_at = at + len(target)
    m = 5
    while k + m < len(words):
        term = " ".join(nw[-m:])
        j = _first_word_match(text, term, after_start)
        if j >= 0 and j + len(term) == end_at:
            break
        m += 1
    if k + m >= len(words):
        return whole
    return f"{url}#:~:text={enc(' '.join(words[:k]))},{enc(' '.join(words[-m:]))}"


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

    texts, kinds, urls, raws, pages = {}, {}, {}, {}, {}
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
        raws[sid] = rp

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
            if sid not in pages:
                pages[sid] = page_model(raws[sid].read_bytes())
            r["fragment_url"] = fragment(urls[sid], r.get("quote", "").strip(), texts[sid], pages[sid])
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
