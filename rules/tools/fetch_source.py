"""Save an official source for a jurisdiction: raw bytes, extracted text, sha256.

usage: uv run --with beautifulsoup4 --with playwright --with certifi python rules/tools/fetch_source.py ST SOURCE_ID URL [--chrome]

Tries a plain HTTPS request first. If that is blocked or returns a challenge page, it opens the
URL in its own tab of the persistent Chrome (CDP on 127.0.0.1:9222) and saves what the browser
gets. Prints one JSON line with the fields to paste into the jurisdiction's "sources" list.
"""
import hashlib
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36"
BLOCK_MARKERS = ("access denied", "request blocked", "captcha", "are you a robot", "enable javascript and cookies", "attention required", "bots use duckduckgo")


def looks_blocked(raw: bytes, ctype: str) -> bool:
    if "pdf" in ctype or raw.startswith(b"%PDF"):
        return not raw.startswith(b"%PDF")
    text = html_to_text(raw).lower()
    return len(text) < 600 or (len(text) < 6000 and any(m in text for m in BLOCK_MARKERS))


def plain_fetch(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"})
    import ssl

    import certifi

    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        return r.read(), r.headers.get("Content-Type", "")


def chrome_fetch(url: str):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = browser.contexts[0].new_page()
        try:
            if url.lower().split("?")[0].endswith(".pdf"):
                origin = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
                page.goto(origin, wait_until="domcontentloaded", timeout=45000)
                b64 = page.evaluate(
                    """async (u) => { const r = await fetch(u, {credentials: 'include'});
                    const b = new Uint8Array(await r.arrayBuffer()); let s = '';
                    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
                    return btoa(s); }""",
                    url,
                )
                import base64

                return base64.b64decode(b64), "application/pdf"
            resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
            time.sleep(2.5)
            ctype = (resp.headers.get("content-type", "") if resp else "") or "text/html"
            return page.content().encode("utf-8"), ctype
        finally:
            page.close()


def html_to_text(raw: bytes) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "header", "footer", "form"]):
        tag.decompose()
    return soup.get_text(" ", strip=True)


def pdf_to_text(path: Path) -> str:
    out = subprocess.run(["pdftotext", "-enc", "UTF-8", str(path), "-"], capture_output=True, text=True, timeout=120)
    return out.stdout


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force_chrome = "--chrome" in sys.argv
    st, sid, url = args[0].upper(), args[1], args[2]
    outdir = ROOT / "rules" / "sources" / st
    outdir.mkdir(parents=True, exist_ok=True)

    raw, ctype, via = b"", "", "http"
    if not force_chrome:
        try:
            raw, ctype = plain_fetch(url)
        except Exception as e:
            print(f"plain fetch failed: {e}", file=sys.stderr)
    if force_chrome or not raw or looks_blocked(raw, ctype.lower()):
        raw, ctype = chrome_fetch(url)
        via = "chrome"
    if not raw or looks_blocked(raw, ctype.lower()):
        print(json.dumps({"error": "blocked or empty", "url": url, "via": via}))
        sys.exit(2)

    is_pdf = "pdf" in ctype.lower() or raw.startswith(b"%PDF")
    raw_path = outdir / f"{sid}.{'pdf' if is_pdf else 'html'}"
    raw_path.write_bytes(raw)
    text = pdf_to_text(raw_path) if is_pdf else html_to_text(raw)
    text_path = outdir / f"{sid}.txt"
    text_path.write_text(text, encoding="utf-8")
    meta = {
        "id": sid,
        "url": url,
        "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "raw_path": str(raw_path.relative_to(ROOT)),
        "text_path": str(text_path.relative_to(ROOT)),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "chars": len(text),
        "via": via,
    }
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
