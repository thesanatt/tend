"""The public pages and the shell on a phone, measured in Chromium at 360, 390, and 430 px with touch:
no page scrolls sideways (the List view's hidden words once widened the home page to 493 px), the law
garden's targets are 44 px and each keeps its whole outline inside the box it scrolls in as Tab moves
through them, and Exit this page never sits on top of a heading or a button while the page scrolls under
the top bar. With a mouse and the browser's text set from Very small to Very large, Exit and its Esc hint
stay clear of every link and button in the header. tests/public-layout.test.tsx checks the CSS behind
each rule.
"""
from __future__ import annotations

import json

import pytest
from conftest import BASE_URL, WEB, Stack
from playwright.sync_api import Browser, Page

WIDTHS = [360, 390, 430]
PAGES = ["/", "/mi", "/law/MI", "/how-it-works", "/sources", "/tour", "/check?demo=rowan", "/check?demo=rowan&tour=1"]
STATES = [s["st"] for s in json.loads((WEB / "lib" / "states.json").read_text())]

# A phone has no hover and a coarse pointer; set them outright so a tap never turns them back.
PHONE_MEDIA = [
    {"name": "hover", "value": "none"},
    {"name": "any-hover", "value": "none"},
    {"name": "pointer", "value": "coarse"},
    {"name": "any-pointer", "value": "coarse"},
]

WIDE = "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
SIZES = "els => els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; })"

# Where Exit this page ends, how tall the bar is, and any fixed control over a heading or a control in
# the part of the screen below the bar.
COVERED = r"""
() => {
  const before = getComputedStyle(document.querySelector('header'), '::before');
  const drawn = before.position === 'fixed' && before.content !== 'none' && before.display !== 'none';
  const bar = drawn ? parseFloat(before.height) : 0;
  const fixed = [...document.querySelectorAll('body *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).position === 'fixed' && r.width > 0 && r.height > 0;
  });
  const hits = [];
  for (const el of document.querySelectorAll('main :is(h1, h2, h3, button, a[href], input, select, summary)')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || el.closest('.visually-hidden')) continue;
    for (const f of fixed) {
      const c = f.getBoundingClientRect();
      const x = Math.min(c.right, r.right) - Math.max(c.left, r.left);
      const y = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top, bar);
      if (x > 1 && y > 1) hits.push(`${el.tagName} "${el.textContent.trim().slice(0, 40)}"`);
    }
  }
  const exit = [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'Exit this page' && getComputedStyle(b.parentElement).position === 'fixed');
  return { bar, exitBottom: exit ? exit.getBoundingClientRect().bottom : null, hits };
}
"""

# How many px of a focused element's outline its scrolling box cuts off, on any side. A box that
# scrolls sideways clips at its padding even when nothing overflows.
CLIPPED = r"""
(el) => {
  const cs = getComputedStyle(el);
  const grow = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
  let box = el.parentElement;
  while (getComputedStyle(box).overflowX === 'visible') box = box.parentElement;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return Math.max(0, b.left - (r.left - grow), b.top - (r.top - grow), r.right + grow - b.right, r.bottom + grow - b.bottom);
}
"""


# Chrome's Settings > Appearance > Font size: Very small, Small, Large, and Very large (Medium is 16).
TEXT_SIZES = [9, 12, 20, 24]

# Each header link and button that Exit this page or its hint sits on, and how far down the brand and
# Exit reach, which has to stay inside the bar.
HEADER_CLEAR = r"""
() => {
  const bar = parseFloat(getComputedStyle(document.querySelector('header'), '::before').height);
  const wrap = [...document.querySelectorAll('body > div')].find(
    (d) => getComputedStyle(d).position === 'fixed' && d.querySelector(':scope > button'));
  const parts = [...wrap.children].map((c) => c.getBoundingClientRect()).filter((c) => c.width > 0 && c.height > 0);
  const covered = [];
  for (const el of document.querySelectorAll('header :is(a[href], button)')) {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const under = parts.some((c) => Math.min(c.right, r.right) > Math.max(c.left, r.left)
      && Math.min(c.bottom, r.bottom) > Math.max(c.top, r.top));
    if (!(at && el.contains(at)) || under) covered.push(el.textContent.trim());
  }
  const brand = document.querySelector('header a[href="/"]').getBoundingClientRect();
  return { covered, bar, lowest: Math.max(brand.bottom, wrap.getBoundingClientRect().bottom) };
}
"""

# How far below the bar a focused element's outline starts (negative: that much of it is under the bar).
RING_TOP = r"""
(el) => {
  const cs = getComputedStyle(el);
  const bar = parseFloat(getComputedStyle(document.querySelector('header'), '::before').height);
  return { outline: parseFloat(cs.outlineWidth),
           clear: el.getBoundingClientRect().top - parseFloat(cs.outlineWidth) - parseFloat(cs.outlineOffset) - bar };
}
"""


def phone(browser: Browser, width: int) -> Page:
    context = browser.new_context(base_url=BASE_URL, viewport={"width": width, "height": 780}, is_mobile=True,
                                  has_touch=True, device_scale_factor=2)
    page = context.new_page()
    page.set_default_timeout(30_000)
    context.new_cdp_session(page).send("Emulation.setEmulatedMedia", {"features": PHONE_MEDIA})
    return page


def load(page: Page, path: str) -> None:
    page.goto(path, wait_until="networkidle")
    page.evaluate("document.fonts.ready")


def fits(page: Page, path: str, width: int) -> None:
    load(page, path)
    assert page.evaluate(WIDE) == 0, f"{path} at {width}px"
    # Long URLs and email addresses in quoted law and source notes wrap inside their disclosures too.
    page.evaluate("document.querySelectorAll('details').forEach((d) => { d.open = true; })")
    assert page.evaluate(WIDE) == 0, f"{path} at {width}px with every disclosure open"


def tab_through(page: Page, links, width: int) -> None:
    # Every link in turn, from the keyboard so the outline shows. Chrome scrolls a box to a focused link
    # only when the link is wholly outside it, so whether one is cut off depends on where the last one
    # left the box: checking only the map's corners once passed while five tiles in one column were cut off.
    links.first.focus()
    page.keyboard.press("Shift+Tab")
    for i in range(links.count()):
        page.keyboard.press("Tab")
        link = links.nth(i)
        assert link.evaluate("(el) => el === document.activeElement"), f"Tab {i + 1} at {width}px"
        assert link.evaluate(CLIPPED) == 0, f"{link.inner_text()} at {width}px"


@pytest.mark.parametrize("width", WIDTHS)
def test_no_page_scrolls_sideways(stack: Stack, browser: Browser, width: int) -> None:  # noqa: ARG001
    page = phone(browser, width)
    try:
        for path in PAGES:
            fits(page, path, width)
        load(page, "/")
        page.get_by_role("button", name="List").tap()
        page.get_by_role("table").wait_for()
        assert page.evaluate(WIDE) == 0, f"/ in the List view at {width}px"
    finally:
        page.context.close()


def test_every_program_page_fits_a_phone(stack: Stack, browser: Browser) -> None:  # noqa: ARG001
    # The narrowest phone, every state's page and law page: the words come from each state's sources.
    page = phone(browser, 360)
    try:
        for st in STATES:
            fits(page, f"/{st.lower()}", 360)
            fits(page, f"/law/{st}", 360)
    finally:
        page.context.close()


@pytest.mark.parametrize("width", WIDTHS)
def test_law_garden_targets_are_44px(stack: Stack, browser: Browser, width: int) -> None:  # noqa: ARG001
    page = phone(browser, width)
    try:
        load(page, "/")
        tiles = page.get_by_role("list", name="States and DC").get_by_role("link")
        assert tiles.count() == 51
        assert [s for s in tiles.evaluate_all(SIZES) if s[0] < 44 or s[1] < 44] == []
        demo = page.get_by_role("link", name="Or try it with a fictional demo account").bounding_box()
        assert demo and demo["height"] >= 44, demo
        assert page.get_by_text("The map scrolls sideways.").is_visible()

        page.get_by_role("button", name="List").tap()
        links = page.get_by_role("table").get_by_role("link")
        assert links.count() == 102
        assert [s for s in links.evaluate_all(SIZES) if s[0] < 44 or s[1] < 44] == []
        assert page.get_by_text("The map scrolls sideways.").count() == 0
    finally:
        page.context.close()


@pytest.mark.parametrize("width", [*WIDTHS, 1280])
def test_a_focused_tile_or_row_keeps_its_outline(stack: Stack, browser: Browser, width: int) -> None:  # noqa: ARG001
    if width < 600:
        page = phone(browser, width)
    else:
        page = browser.new_context(base_url=BASE_URL, viewport={"width": width, "height": 900}).new_page()
    try:
        load(page, "/")
        tab_through(page, page.get_by_role("list", name="States and DC").get_by_role("link"), width)
        page.get_by_role("button", name="List").click()
        tab_through(page, page.get_by_role("table").get_by_role("link"), width)
    finally:
        page.context.close()


@pytest.mark.parametrize("size", TEXT_SIZES)
@pytest.mark.parametrize("locale", ["en-US", "es-ES"])
def test_exit_clears_the_header_at_each_text_size(
    stack: Stack, browser: Browser, locale: str, size: int,  # noqa: ARG001
) -> None:
    # A mouse, so the Esc hint shows where it fits. In px, the bar's width switches ignored this setting:
    # at Large and Very large the nav joined the bar at 1000px under Exit and its hint, and the hint sat
    # on the brand at 560px. In em alone, at Very small the nav would join the bar at 563px, under the hint.
    context = browser.new_context(base_url=BASE_URL, viewport={"width": 1280, "height": 800}, locale=locale)
    page = context.new_page()
    page.set_default_timeout(30_000)
    context.new_cdp_session(page).send("Page.setFontSizes", {"fontSizes": {"standard": size, "fixed": 13}})
    try:
        for path in ["/", "/check"]:
            load(page, path)
            page.wait_for_function(f"document.documentElement.lang === '{locale[:2]}'")
            assert page.evaluate("getComputedStyle(document.documentElement).fontSize") == f"{size}px"
            for width in [430, 560, 600, 750, 1000, 1100, 1250, 1500]:
                page.set_viewport_size({"width": width, "height": 800})
                seen = page.evaluate(HEADER_CLEAR)
                assert seen["covered"] == [], (path, width, seen)
                assert seen["lowest"] <= seen["bar"], (path, width, seen)
    finally:
        context.close()


@pytest.mark.parametrize("width", [*WIDTHS, 768])
def test_the_nav_s_focus_ring_clears_the_bar(stack: Stack, browser: Browser, width: int) -> None:  # noqa: ARG001
    # Below the width where the nav joins the bar, it sits just under the bar at the top of the page.
    if width < 600:
        page = phone(browser, width)
    else:
        page = browser.new_context(base_url=BASE_URL, viewport={"width": width, "height": 900}).new_page()
    try:
        load(page, "/")
        items = page.locator("header nav").locator("a[href], button")
        assert items.count() == 3
        items.first.focus()
        page.keyboard.press("Shift+Tab")
        for i in range(items.count()):
            page.keyboard.press("Tab")
            ring = items.nth(i).evaluate(RING_TOP)
            assert ring["outline"] > 0 and ring["clear"] >= 0, (width, items.nth(i).inner_text(), ring)
    finally:
        page.context.close()


@pytest.mark.parametrize("width", WIDTHS)
def test_exit_never_covers_a_heading_or_a_button(stack: Stack, browser: Browser, width: int) -> None:  # noqa: ARG001
    page = phone(browser, width)
    try:
        for path in ["/", "/mi", "/check?demo=rowan"]:
            load(page, path)
            end = page.evaluate("document.documentElement.scrollHeight - innerHeight")
            for y in range(0, end + 1, 40):
                page.evaluate(f"window.scrollTo(0, {y})")
                seen = page.evaluate(COVERED)
                assert seen["exitBottom"] is not None and seen["exitBottom"] <= seen["bar"], (path, y, seen)
                assert seen["hits"] == [], (path, width, y, seen["hits"])
    finally:
        page.context.close()
