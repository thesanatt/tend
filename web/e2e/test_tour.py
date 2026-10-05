"""The visitor tour, from the home page through Track: each step shows its note, the buttons the note
names are the ones on the screen, the last note leads to the summary, and Exit tour ends it.
Normal visitors (the other tests here) never see a note.
"""
from __future__ import annotations

import re

from conftest import Stack
from playwright.sync_api import Browser, Page, expect
from test_demo_path import HELD, REST, bills, check, gather, new_page, packet, pay, step
from test_demo_path import _servers_up  # noqa: F401 (each test starts from a fresh dry-run bank)

TEST = "tour"


def note(page: Page):
    return page.get_by_role("complementary", name=re.compile(r"^Tour, step"))


def expect_note(page: Page, n: int, title: str, *phrases: str) -> None:
    box = note(page)
    expect(box).to_have_count(1)
    expect(box).to_contain_text(f"Tour, step {n} of 5: {title}")
    for p in phrases:
        expect(box).to_contain_text(p)
    expect(box.get_by_role("button", name="Exit tour")).to_be_visible()


def test_tour_from_home_through_track(stack: Stack, browser: Browser) -> None:  # noqa: ARG001
    context, page = new_page(browser)
    try:
        with step(TEST, "Home: visitor intro"):
            page.goto("/")
            intro = page.get_by_role("region", name="About Tend")
            expect(intro).to_contain_text("without giving up their name.")
            expect(intro).to_contain_text("1st place, Capital One Best Use of Nessie.")
            expect(intro).to_contain_text("fictional")
            expect(intro.get_by_role("link", name="How it works")).to_have_attribute("href", "/how-it-works")
            expect(note(page)).to_have_count(0)

        with step(TEST, "Tour: Check"):
            intro.get_by_role("link", name="Take the 2-minute tour").click()
            expect(page).to_have_url(re.compile(r"/check\?demo=rowan&tour=1$"))
            expect_note(page, 1, "Check", "every line links to the exact sentence", "Find my costs")
        expect(page.get_by_text("File by June 14, 2031.")).to_be_visible()

        # Gather: the note's own order. The sample statement opens as a 5-page PDF in a new tab.
        page.get_by_role("link", name="Find my costs").click()
        expect_note(page, 2, "Gather", "190 transactions on this device; nothing is uploaded")
        with step(TEST, "Tour: see the sample statement"):
            link = page.get_by_role("link", name="See the sample statement (PDF)")
            expect(link).to_have_attribute("href", "/samples/rowan-statement-FICTIONAL.pdf")
            expect(link).to_have_attribute("target", "_blank")
            res = page.request.get("/samples/rowan-statement-FICTIONAL.pdf")
            assert res.ok and res.body().startswith(b"%PDF")
            # The note says 5 pages.
            assert len(re.findall(rb"/Type\s*/Page[^s]", res.body())) == 5
        # Run the path the way the notes say, from Check. Its link has no tour=1; the tab remembers.
        check(page, TEST)
        expect_note(page, 1, "Check")
        gather(page, TEST)
        expect_note(page, 2, "Gather")

        bills(page, TEST)
        expect_note(page, 3, "Bills", "Line 2 is a $325 forensic exam", f"Pay {REST} now from Checking 0011")
        pay(page, TEST)

        packet(page, TEST)
        expect_note(page, 4, "Packet", "Michigan's real application, filled with safe fields only", "Wi-Fi off")

        # What the note says to try: Wi-Fi off, back one page, build the packet again.
        with step(TEST, "Tour: packet again with the network off"):
            expect(page.locator("html[data-offline=ready]")).to_have_count(1, timeout=90_000)
            context.set_offline(True)
            try:
                page.go_back()
                expect(page.get_by_role("heading", name="Your bills", level=1)).to_be_visible()
                page.get_by_role("link", name="Build my packet").click()
                expect(page.get_by_role("link", name="Download the filled form")).to_be_visible()
                assert page.evaluate("navigator.onLine") is False
            finally:
                context.set_offline(False)

        with step(TEST, "Tour: Track"):
            page.get_by_role("link", name="See your garden").click()
            expect(page.get_by_role("heading", name="Your garden", level=1)).to_be_visible()
            expect_note(page, 5, "Track", "The $325 never grows.")
        expect(page.get_by_text(f"Held: {HELD} on a bill the law says you should not pay.", exact=False)).to_be_visible()

        with step(TEST, "Tour: What you just saw"):
            note(page).get_by_role("link", name="What you just saw").click()
            expect(page.get_by_role("heading", name="What you just saw", level=1)).to_be_visible()
        for name in ("How it works", "The code on GitHub", "The Devpost write-up", "Sources"):
            expect(page.get_by_role("link", name=name).first).to_be_visible()
        expect(page.get_by_role("link", name="The Devpost write-up")).to_have_attribute(
            "href", "https://devpost.com/software/tend-ua9rm8"
        )

        with step(TEST, "How it works"):
            page.get_by_role("link", name="How it works").first.click()
            expect(page.get_by_role("heading", name="How Tend works", level=1)).to_be_visible()
        expect(page.get_by_role("heading", name="The path of a claim")).to_be_visible()
        expect(page.get_by_text("121,000", exact=True)).to_be_visible()

        # Exit tour ends it for the tab.
        with step(TEST, "Exit tour"):
            page.goto("/track")
            expect_note(page, 5, "Track")
            note(page).get_by_role("button", name="Exit tour").click()
            expect(note(page)).to_have_count(0)
            page.goto("/check")
            expect(page.get_by_role("heading", level=1)).to_be_visible()
            expect(note(page)).to_have_count(0)
    finally:
        context.close()


def test_spanish_ui_shows_no_tour_notes(stack: Stack, browser: Browser) -> None:  # noqa: ARG001
    context, page = new_page(browser)
    try:
        page.goto("/check?demo=rowan&tour=1")
        expect_note(page, 1, "Check")
        page.get_by_role("button", name="Español").click()
        expect(page.locator("html[lang=es]")).to_have_count(1)
        expect(note(page)).to_have_count(0)
    finally:
        context.close()
