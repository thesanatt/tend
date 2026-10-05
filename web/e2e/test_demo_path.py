"""The judges' demo path, end to end, on the real modules: Check for Rowan (fictional, Michigan),
Gather (statement, bill, demo bank), the held exam line and the billing letter, the $118 payment with
a confirm code, the packet, an encrypted share link, and Track. Then the same survivor path with the
network gone, and a check of what every request carried.

Rowan's numbers must agree everywhere: a $443.00 bill, $325.00 held, $118.00 paid.
"""
from __future__ import annotations

import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import urlparse

import pytest
from conftest import BASE_URL, Stack, record
from playwright.sync_api import Browser, BrowserContext, Page, Request, expect

BILL, HELD, REST = "$443.00", "$325.00", "$118.00"
# What Rowan can ask for once the statement, the bill, and the bank are read and no question is
# answered yet (questions are guesses and count only after a yes). The bank adds nothing new: its
# rows were in the statement, and its pending hospital bill is the itemized bill.
TOTAL = "$3,142.00"
QUIET = "On this device. Nothing has left it."
# Words that are Rowan's transactions and bill lines. None may leave the device.
PRIVATE = [
    "Clearwater Counseling", "Wayfare Rides", "Larkfield Market", "Fernway Books", "Linen & Loom", "Linen &amp; Loom",
    "Northside Hardware", "Keyline Lock", "Elm Court", "Two Rivers Truck", "Hearthstone Pharmacy", "Copper Kettle",
    "allergy relief", "sheet set", "door chain", "security deposit",
    "Emergency department visit", "Medical forensic exam", "Laboratory services", "deductible applied", "coinsurance",
]


@contextmanager
def step(test: str, name: str) -> Iterator[None]:
    started = time.monotonic()
    yield
    record(test, name, time.monotonic() - started)


def new_page(browser: Browser) -> tuple[BrowserContext, Page]:
    context = browser.new_context(base_url=BASE_URL, viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = context.new_page()
    page.set_default_timeout(30_000)
    return context, page


def privacy_line(page: Page):
    return page.locator("header [role=status]").first


def records_read(page: Page):
    return page.get_by_role("list", name="Records read")


def open_add_more(page: Page) -> None:
    # Once something is read, the ways to add a record fold under "Add another record".
    summary = page.locator("details > summary", has_text="Add another record").first
    expect(summary).to_be_visible()
    if not summary.evaluate("s => s.parentElement.open"):
        summary.click()


def check(page: Page, test: str) -> None:
    with step(test, "Check (Rowan, Michigan)"):
        page.goto("/check?demo=rowan")
        expect(page.get_by_text("File by June 14, 2031.")).to_be_visible()
    expect(page.get_by_text("You can likely apply in Michigan.")).to_be_visible()
    expect(page.get_by_text("Your forensic exam counts in place of a police report here.")).to_be_visible()
    expect(page.get_by_text("Law math: on this device (WebAssembly)")).to_be_visible()


def gather(page: Page, test: str, bank: bool = True) -> None:
    with step(test, "Gather: open"):
        page.get_by_role("link", name="Find my costs").click()
        expect(page.get_by_role("heading", name="Gather your costs", level=1)).to_be_visible()
    with step(test, "Gather: sample statement (PDF, on device)"):
        page.get_by_role("button", name="Use a sample statement").click()
        open_add_more(page)
        expect(records_read(page)).to_contain_text("sample-statement-fictional.pdf: 190 transactions read")
    with step(test, "Gather: Riverbend bill (PDF, on device)"):
        open_add_more(page)
        page.get_by_role("button", name="Use a sample bill").click()
        expect(records_read(page)).to_contain_text(f"Riverbend General Hospital: 3 lines, adding up to {BILL}.")
        expect(page.get_by_text("Held: don't pay")).to_be_visible()
    if bank:
        with step(test, "Gather: demo bank (shipped copy)"):
            open_add_more(page)
            page.get_by_role("button", name="Use the demo bank account").click()
            expect(records_read(page)).to_contain_text("Demo bank: 191 transactions read")
            # The same account was already read from the statement, so its costs count once.
            expect(records_read(page)).to_contain_text("already here from another record")
    # Moves between Rowan's own accounts are never costs.
    expect(page.get_by_text("Move to checking")).to_have_count(0)
    expect(page.get_by_label("Your claim so far")).to_contain_text(TOTAL)


def bills(page: Page, test: str) -> None:
    with step(test, "Bills: open, lines checked"):
        page.get_by_role("link", name=re.compile(r"^Next: your bill")).click()
        expect(page.get_by_role("heading", name="Your bills", level=1)).to_be_visible()
        table = page.get_by_role("table")
        expect(table).to_contain_text(BILL)
        expect(table).to_contain_text(f"-{HELD}")
        expect(table).to_contain_text(REST)
    expect(page.get_by_text(f"Medical forensic exam, deductible applied, {HELD}. Michigan law says you should not be billed for it.")).to_be_visible()
    expect(page.get_by_text("MCL 18.355a(2)").first).to_be_visible()
    with step(test, "Bills: letter to billing"):
        page.get_by_role("button", name="Get a letter for the billing office").click()
        letter = page.get_by_role("dialog").locator("pre")
        expect(letter).to_contain_text("To: Billing office, Riverbend General Hospital")
    expect(letter).to_contain_text("MCL 18.355a(2)")
    expect(letter).to_contain_text(f"Medical forensic exam, deductible applied, June 14, 2026: {HELD}")
    page.get_by_role("dialog").get_by_role("button", name="Close").click()


def pay(page: Page, test: str) -> None:
    with step(test, "Pay $118: get a 6-digit code"):
        page.get_by_role("button", name=re.compile(rf"^Pay \{REST} now from Checking 0011")).click()
        sheet = page.get_by_role("dialog")
        expect(sheet).to_contain_text(REST)
        expect(sheet).to_contain_text("Riverbend General Hospital")
        sheet.get_by_role("button", name="Get a code").click()
        code_box = sheet.get_by_label("Confirmation code")
        expect(code_box).to_be_visible()
    code = sheet.locator(".visually-hidden", has_text=re.compile(r"^\d \d \d \d \d \d$")).inner_text().replace(" ", "")
    assert re.fullmatch(r"\d{6}", code)
    with step(test, "Pay $118: confirm"):
        code_box.fill(code)
        sheet.get_by_role("button", name=f"Pay {REST}").click()
        expect(sheet.get_by_text(f"Paid {REST}.")).to_be_visible()
    expect(sheet).to_contain_text("dry run")
    sheet.get_by_role("button", name="Done").click()
    expect(page.get_by_text(re.compile(rf"You paid \{REST} to Riverbend General Hospital"))).to_be_visible()
    expect(privacy_line(page)).to_contain_text("a payment")


def packet(page: Page, test: str) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    with step(test, "Packet: built on device"):
        page.get_by_role("link", name="Build my packet").click()
        expect(page.get_by_role("heading", name="Your packet", level=1)).to_be_visible()
        expect(page.get_by_role("link", name="Download the filled form")).to_be_visible()
    expect(page.get_by_text(f"Separate from this: {HELD} on a bill you should not pay.")).to_be_visible()
    expect(page.locator("[class*=packetTotal]")).to_contain_text(TOTAL)
    expect(page.get_by_text("The program decides.").first).to_be_visible()
    for name, label in (("form", "Download the filled form"), ("summary", "Download the summary (PDF)")):
        with page.expect_download() as info:
            page.get_by_role("link", name=label).click()
        files[name] = open(info.value.path(), "rb").read()  # noqa: SIM115
        assert files[name].startswith(b"%PDF"), name
    expect(page.get_by_text("By mail", exact=True)).to_be_visible()
    return files


def share(page: Page, test: str) -> str:
    with step(test, "Share: sealed link"):
        page.get_by_role("button", name="Make a share link").click()
        box = page.get_by_label("Share this link with your advocate:")
        expect(box).to_have_value(re.compile(r"/share#[\w-]+\.[\w-]{43}$"))
    expect(privacy_line(page)).to_contain_text("a locked share link")
    return box.input_value()


def track(page: Page, test: str) -> None:
    with step(test, "Track: the garden"):
        page.get_by_role("link", name="See your garden").click()
        expect(page.get_by_role("heading", name="Your garden", level=1)).to_be_visible()
    bar = page.locator("[class*=deadlineBar]")
    expect(bar).to_contain_text("File by June 14, 2031.")
    expect(bar).to_contain_text("The law counts from your report, so you may have longer.")
    expect(page.get_by_text(f"Held: {HELD} on a bill the law says you should not pay.", exact=False)).to_be_visible()
    expect(page.get_by_text("You paid it through Tend").first).to_be_visible()


def test_demo_path(stack: Stack, browser: Browser) -> None:
    context, page = new_page(browser)
    try:
        check(page, "online")
        expect(privacy_line(page)).to_have_text(QUIET)
        gather(page, "online")
        bills(page, "online")
        pay(page, "online")
        packet(page, "online")
        link = share(page, "online")
        track(page, "online")

        # The advocate opens the link in another tab: the claim opens in that browser, with the key
        # from the link's fragment.
        with step("online", "Share: advocate opens the link"):
            advocate = context.new_page()
            advocate.goto(link)
            expect(advocate.get_by_role("heading", name="Claim summary", level=1)).to_be_visible()
        expect(advocate.get_by_text(f"Held: {HELD}", exact=False)).to_be_visible()
    finally:
        context.close()

    # The same bill from a second device: the bank's copy already has Tend's payment, so nothing moves.
    context, page = new_page(browser)
    try:
        check(page, "second device")
        gather(page, "second device")
        bills(page, "second device")
        with step("second device", "Pay $118 again: refused"):
            page.get_by_role("button", name=re.compile(rf"^Pay \{REST} now from Checking 0011")).click()
            sheet = page.get_by_role("dialog")
            sheet.get_by_role("button", name="Get a code").click()
            expect(sheet.get_by_text("The bank already shows a payment from Tend for these lines of this bill", exact=False)).to_be_visible()
        expect(sheet.get_by_label("Confirmation code")).to_have_count(0)
    finally:
        context.close()


def test_offline_survivor_path(stack: Stack, browser: Browser) -> None:
    """After one online visit the survivor path runs with both servers stopped and the network off."""
    context, page = new_page(browser)
    try:
        with step("offline", "First visit, saved for offline"):
            page.goto("/check?demo=rowan")
            expect(page.locator("html[data-offline=ready]")).to_have_count(1, timeout=90_000)
        expect(page.get_by_text("Saved on this device, so the steps work without internet.")).to_be_visible()

        stack.stop_web()
        stack.stop_api()
        context.set_offline(True)
        try:
            with step("offline", "Reload with no network"):
                page.reload()
                expect(page.get_by_text("File by June 14, 2031.")).to_be_visible()
            assert page.evaluate("navigator.onLine") is False
            expect(page.get_by_text("Law math: on this device (WebAssembly)")).to_be_visible()
            expect(page.get_by_text("You are offline. Every step still works here.", exact=False)).to_be_visible()

            gather(page, "offline")
            bills(page, "offline")

            # A payment needs the network: it says so, sends nothing, and offers to try again.
            with step("offline", "Pay: says it is offline"):
                page.get_by_role("button", name=re.compile(rf"^Pay \{REST} now")).click()
                sheet = page.get_by_role("dialog")
                sheet.get_by_role("button", name="Get a code").click()
                expect(sheet.get_by_text("You are offline, so this did not reach the bank. Nothing was sent.", exact=False)).to_be_visible()
            expect(sheet.get_by_role("button", name="Try again")).to_be_visible()
            sheet.get_by_role("button", name="Cancel").click()
            expect(privacy_line(page)).to_have_text(QUIET)

            packet(page, "offline")
            with step("offline", "Share: says it is offline"):
                page.get_by_role("button", name="Make a share link").click()
                expect(page.get_by_text("You are offline. A share link needs the internet. Nothing was sent.", exact=False)).to_be_visible()
            expect(page.get_by_role("button", name="Make a share link")).to_be_visible()
            expect(privacy_line(page)).to_have_text(QUIET)

            with step("offline", "Track"):
                page.get_by_role("link", name="See your garden").click()
                expect(page.locator("[class*=deadlineBar]")).to_contain_text("File by June 14, 2031.")

            # Saved progress opens with the network off too.
            with step("offline", "Save to the vault, reload, open it"):
                page.get_by_role("button", name="Save this").first.click()
                sheet = page.get_by_role("dialog")
                sheet.get_by_label("Passcode").fill("rowan-demo-passcode")
                sheet.get_by_role("button", name="Save with this passcode").click()
                expect(page.get_by_text("Saved on this device").first).to_be_visible()
                page.reload()
                expect(page.get_by_role("heading", name="Pick up where you left off")).to_be_visible()
                page.get_by_label("Passcode").fill("rowan-demo-passcode")
                page.get_by_role("button", name="Open", exact=True).click()
                expect(page.get_by_role("heading", name="Your garden", level=1)).to_be_visible()
                expect(page.locator("[class*=deadlineBar]")).to_contain_text("File by June 14, 2031.")
            assert page.evaluate("navigator.onLine") is False
        finally:
            context.set_offline(False)
            stack.start_api()
            stack.start_web()

        # Back online, the same payment goes through.
        with step("offline", "Back online: pay $118"):
            page.get_by_role("link", name="Gather").first.click()
            page.get_by_role("link", name=re.compile(r"^Next: your bill")).click()
            pay(page, "back online")
    finally:
        context.close()


def test_nothing_private_leaves(stack: Stack, browser: Browser) -> None:
    """Every request of the whole path, payment and share included: no transaction text, no bill line,
    no share key, and nothing to another site."""
    context, page = new_page(browser)
    seen: list[Request] = []
    context.on("request", lambda r: seen.append(r))
    try:
        check(page, "privacy")
        gather(page, "privacy")
        bills(page, "privacy")
        pay(page, "privacy")
        packet(page, "privacy")
        link = share(page, "privacy")
        key = link.split("#", 1)[1].split(".", 1)[1]
    finally:
        context.close()

    assert seen, "no requests were recorded"
    origin = urlparse(BASE_URL)
    for r in seen:
        url = urlparse(r.url)
        assert url.scheme in ("http", "https", "blob", "data"), r.url
        if url.scheme in ("http", "https"):
            assert (url.hostname, url.port) == (origin.hostname, origin.port), f"request to another site: {r.url}"
        body = r.post_data or ""
        for word in PRIVATE:
            assert word.lower() not in r.url.lower(), f"{word!r} in {r.method} {r.url}"
            assert word.lower() not in body.lower(), f"{word!r} in the body of {r.method} {r.url}"
        assert key not in r.url and key not in body, f"the share key left in {r.method} {r.url}"

    posts = [(r.method, urlparse(r.url).path) for r in seen if r.method != "GET"]
    # Only what the survivor chose to send: a payment (code, then confirm) and a sealed share.
    assert sorted(set(posts)) == [("POST", "/api/actions/confirm"), ("POST", "/api/actions/propose"), ("POST", "/api/shares")]
    propose = next(r for r in seen if urlparse(r.url).path == "/api/actions/propose")
    assert sorted((propose.post_data_json or {}).keys()) == ["amount_cents", "from_account_id", "payee"]
    assert propose.post_data_json["amount_cents"] == 11800
    sealed = next(r for r in seen if urlparse(r.url).path == "/api/shares")
    assert sorted((sealed.post_data_json or {}).keys()) == ["alg", "ciphertext", "expires_hours", "iv", "once"]


@pytest.fixture(autouse=True)
def _servers_up(stack: Stack) -> None:
    # Each test starts from a fresh API, so its dry-run bank has no earlier payment of Rowan's bill
    # (the way seed/reset_demo.py puts the Nessie bank back before a live demo). This also brings back
    # a server a test that failed while offline left down.
    stack.stop_api()
    stack.start_api()
    if stack.web is None or stack.web.poll() is not None:
        stack.start_web()
