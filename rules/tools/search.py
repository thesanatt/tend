"""Web search through the persistent Chrome (Google), printed as JSON lines of title and url.

usage: uv run --with playwright python rules/tools/search.py "query words"

Use sparingly (at most about 6 per jurisdiction). Opens and closes its own tab.
"""
import json
import sys
import time
from urllib.parse import quote_plus

from playwright.sync_api import sync_playwright

q = " ".join(sys.argv[1:])
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = browser.contexts[0].new_page()
    try:
        page.goto(f"https://www.google.com/search?q={quote_plus(q)}&num=10&hl=en", wait_until="domcontentloaded", timeout=45000)
        time.sleep(1.5)
        if "unusual traffic" in page.content().lower() or "/sorry/" in page.url:
            print(json.dumps({"error": "google rate-limited this browser; wait a minute or fetch known official URLs directly"}))
            sys.exit(3)
        results = page.evaluate(
            """() => Array.from(document.querySelectorAll('a h3')).map(h => {
                const a = h.closest('a'); const box = h.closest('div.g, div[data-hveid]');
                const snip = box ? (box.querySelector('[data-sncf], .VwiC3b') || {}).innerText : '';
                return {title: h.innerText, url: a.href, snippet: snip || ''}; })"""
        )
    finally:
        page.close()
for r in results[:10]:
    print(json.dumps(r, ensure_ascii=False))
