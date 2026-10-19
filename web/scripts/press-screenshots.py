# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.47.0"]
# ///
"""The press kit screenshots in web/public/press/screenshots, taken in Chromium from a production build.

Each one shows a public page or the fictional demo (Rowan Hale, Riverbend General Hospital, made-up
records). The script only clicks: it types nothing, so no screenshot can hold anything a person typed,
and it stops if the privacy line says something left the device. app/press/files.ts lists the same
files with their captions; keep the two in step.

usage (from web/, after `npx next build`):
    uv run --python 3.12 scripts/press-screenshots.py              starts `next start` on port 3700, then stops it
    uv run --python 3.12 scripts/press-screenshots.py --port 3681
    uv run --python 3.12 scripts/press-screenshots.py --url http://localhost:3000   a server already running

Playwright's Chromium is needed once:
    uv run --python 3.12 --with playwright==1.47.0 python -m playwright install chromium
"""
from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Browser, Page, expect, sync_playwright

WEB = Path(__file__).resolve().parents[1]
OUT = WEB / "public" / "press" / "screenshots"

DESKTOP = {"viewport": {"width": 1280, "height": 800}, "device_scale_factor": 2}
PHONE = {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True}
QUIET = "On this device. Nothing has left it since this page opened."
HELD = "$325.00"
# The itemized bill and, beside it on a wide screen, the held line's law.
BILL = 'article[aria-labelledby^="bill-"]'


def wait_up(url: str, seconds: float, proc: subprocess.Popen | None) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise SystemExit("next start exited; run `npx next build` first")
        try:
            with urllib.request.urlopen(url, timeout=2) as res:
                if res.status < 500:
                    return
        except Exception:
            time.sleep(0.4)
    raise SystemExit(f"{url} did not answer in {seconds:.0f} s")


def new_page(browser: Browser, base: str, device: dict) -> Page:
    # Light theme, no motion, English: the same frames on every run.
    context = browser.new_context(
        base_url=base, color_scheme="light", reduced_motion="reduce", locale="en-US", **device
    )
    page = context.new_page()
    page.set_default_timeout(30_000)
    return page


# Every image in the frame has loaded. Lazy images further down may not have started, so only those that
# show count. Polled from here: wait_for_function would eval the check in the page, which the site's CSP
# refuses.
IMAGES_IN_VIEW = """() => [...document.images]
  .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; })
  .every((i) => i.complete && i.naturalWidth > 0)"""


def settle(page: Page) -> None:
    page.evaluate("document.fonts.ready.then(() => true)")
    deadline = time.monotonic() + 20
    while not page.evaluate(IMAGES_IN_VIEW):
        if time.monotonic() > deadline:
            raise SystemExit(f"{page.url}: an image in view did not load")
        time.sleep(0.1)
    # Against the frame's own width: on an emulated phone the browser widens innerWidth to fit the page.
    wide = page.evaluate("document.documentElement.scrollWidth") - page.viewport_size["width"]
    if wide > 0:
        raise SystemExit(f"{page.url} scrolls sideways by {wide}px")


def quiet(page: Page) -> None:
    # Nothing a person could have entered has left the device, and nothing was sent at all.
    expect(page.locator("header [role=status]").first).to_have_text(QUIET)


def shoot(page: Page, name: str) -> None:
    settle(page)
    path = OUT / name
    page.screenshot(path=str(path))
    print(f"wrote {path.relative_to(WEB)}")


def to_top(page: Page, selector: str) -> None:
    # The page's scroll padding keeps the element below the fixed top bar.
    page.locator(selector).first.evaluate("el => el.scrollIntoView({ block: 'start' })")


def add_more(page: Page) -> None:
    # Once something is read, the ways to add a record and the list of records fold under this.
    summary = page.locator("details > summary", has_text="Add another record").first
    if not summary.evaluate("s => s.parentElement.open"):
        summary.click()


def demo_bill(page: Page) -> None:
    """Rowan's demo claim up to the bill: Check, the demo bank, the sample bill, and a yes to every question."""
    page.goto("/check?demo=rowan")
    expect(page.get_by_text("File by June 14, 2031.")).to_be_visible()
    page.get_by_role("link", name="Find my costs").click()
    expect(page.get_by_role("heading", name="Gather your costs", level=1)).to_be_visible()
    page.get_by_role("button", name="Use the demo bank account").click()
    add_more(page)
    records = page.get_by_role("list", name="Records read")
    expect(records).to_contain_text("Demo bank: 190 transactions")
    page.get_by_role("button", name="Use a sample bill").click()
    add_more(page)
    expect(records).to_contain_text("Riverbend General Hospital: 3 lines, adding up to $443.00.")
    # The questions Tend asks about its guesses (rides to care, short paychecks), all answered yes. Each
    # answered group's button goes away; the bound stops a loop if one ever stays.
    yes = page.get_by_role("button", name=re.compile(r"^Yes to all "))
    for _ in range(10):
        if not yes.count():
            break
        yes.first.click()
    expect(yes).to_have_count(0)
    page.get_by_role("link", name=re.compile(r"^Next: your bill")).click()
    expect(page.get_by_role("heading", name="Your bills", level=1)).to_be_visible()
    expect(page.get_by_text(f"Medical forensic exam, deductible applied, {HELD}.", exact=False).first).to_be_visible()
    quiet(page)


def demo_packet(page: Page) -> None:
    page.get_by_role("link", name="Build my packet").click()
    expect(page.get_by_role("heading", name="Your packet", level=1)).to_be_visible()
    expect(page.get_by_role("link", name="Download the filled form")).to_be_visible()
    expect(page.get_by_text("The program decides.").first).to_be_visible()
    quiet(page)


def run(base: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = new_page(browser, base, DESKTOP)
            page.goto("/")
            expect(page.get_by_role("heading", level=1)).to_be_visible()
            shoot(page, "tend-home-desktop.png")
            demo_bill(page)
            to_top(page, BILL)
            shoot(page, "tend-bill-held-desktop.png")
            demo_packet(page)
            shoot(page, "tend-packet-desktop.png")
            page.context.close()

            page = new_page(browser, base, PHONE)
            page.goto("/mi")
            expect(page.get_by_role("heading", level=1)).to_be_visible()
            shoot(page, "tend-mi-phone.png")
            to_top(page, "#share")
            shoot(page, "tend-share-card-phone.png")
            demo_bill(page)
            to_top(page, BILL)
            shoot(page, "tend-bill-held-phone.png")
            page.context.close()
        finally:
            browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", help="a Tend server already running; otherwise one is started")
    parser.add_argument("--port", type=int, default=3700, help="port for the server this starts (default 3700)")
    args = parser.parse_args()
    if args.url:
        run(args.url.rstrip("/"))
        return 0
    if not (WEB / ".next" / "BUILD_ID").exists():
        raise SystemExit("No production build: run `npx next build` in web/ first")
    base = f"http://localhost:{args.port}"
    server = subprocess.Popen(
        ["npx", "next", "start", "--port", str(args.port)],
        cwd=WEB,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        wait_up(f"{base}/", 120, server)
        run(base)
    finally:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
