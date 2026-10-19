# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.67.0", "uharfbuzz==0.56.3"]
# ///
"""The press kit logos in web/public/press: the leaf mark and the "Tend" wordmark, as SVG and PNG.

The mark is the one in the site header (components/flow/AppHeader.tsx) and the share cards. The word is
set in Source Serif 4 Semibold, the share cards' font (components/public/og/fonts), shaped with HarfBuzz
so its kerning is the font's own, and written as paths so the SVG looks the same without the font.
PNGs are drawn from those SVGs by Chromium (Playwright), with a transparent background.

usage (from the repo root):
    uv run web/scripts/press-logos.py            write the SVGs (and the PNGs when --png is given)
    uv run web/scripts/press-logos.py --png
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

WEB = Path(__file__).resolve().parents[1]
FONT = WEB / "components" / "public" / "og" / "fonts" / "SourceSerif4-Semibold.ttf"
OUT = WEB / "public" / "press"

# app/globals.css, light theme.
GREEN = "#1F5136"
INK = "#1C1B18"
PAPER = "#F6F2E9"

# The header mark, in its 24-unit box.
MARK = """<path d="M12 21V11" stroke="{c}" stroke-width="1.8" stroke-linecap="round" fill="none"/>
<path d="M12 12.5C11.2 8.6 7.6 6.3 4 6.6C4.4 10.6 8 13 12 12.5Z" fill="{c}"/>
<path d="M12 10C12.6 6.4 15.8 3.8 19.6 4C19.4 7.8 16 10.4 12 10Z" fill="{c}" fill-opacity="0.72"/>
<path d="M7 21H17" stroke="{c}" stroke-width="1.4" stroke-linecap="round"/>"""

# The share card sets the word at 36 px beside a 40 px mark with a 12 px gap and -0.5 px tracking.
SIZE = 36.0
MARK_BOX = 40.0
GAP = 12.0
TRACK = -0.5


def word_path(text: str, size: float) -> tuple[str, float]:
    """The word's outline as one SVG path in a y-down box whose baseline is y=0, and its advance width."""
    font = TTFont(FONT)
    upem = font["head"].unitsPerEm
    blob = hb.Blob.from_file_path(str(FONT))
    hb_font = hb.Font(hb.Face(blob))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf, {"kern": True, "liga": True})
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    scale = size / upem
    pen = SVGPathPen(glyphs)
    x = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        # Font units are y-up; flip to the SVG's y-down box at the pen position.
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x + pos.x_offset * scale, -pos.y_offset * scale)))
        x += pos.x_advance * scale + TRACK
    return pen.getCommands(), x - TRACK


def logo(word: str, ink: str, mark: str, background: str | None) -> str:
    path, width = word_path(word, SIZE)
    cap = 0.67 * SIZE  # Source Serif 4's cap height is 670 of 1000 units
    pad = 8.0
    # The mark's ground line sits on the word's baseline, as in the header.
    baseline = pad + MARK_BOX * 21 / 24
    total_w = pad + MARK_BOX + GAP + width + pad
    total_h = pad + MARK_BOX + pad
    word_x = pad + MARK_BOX + GAP
    bg = f'<rect width="{total_w:.2f}" height="{total_h:.2f}" fill="{background}"/>\n' if background else ""
    assert cap < baseline
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total_w:.2f} {total_h:.2f}" '
        f'width="{total_w:.2f}" height="{total_h:.2f}" role="img" aria-label="Tend">\n'
        f"<title>Tend</title>\n{bg}"
        f'<g transform="translate({pad} {pad}) scale({MARK_BOX / 24})">\n{MARK.format(c=mark)}\n</g>\n'
        f'<path transform="translate({word_x:.2f} {baseline:.2f})" fill="{ink}" d="{path}"/>\n'
        "</svg>\n"
    )


def mark_only(color: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Tend">\n'
        f"<title>Tend</title>\n{MARK.format(c=color)}\n</svg>\n"
    )


def tile() -> str:
    # The site's own icon (app/icon.svg), which has its own padding inside the rounded square.
    return (WEB / "app" / "icon.svg").read_text(encoding="ascii")


FILES = {
    "tend-logo.svg": lambda: logo("Tend", INK, GREEN, None),
    "tend-logo-reversed.svg": lambda: logo("Tend", PAPER, PAPER, GREEN),
    "tend-mark.svg": lambda: mark_only(GREEN),
    "tend-mark-tile.svg": tile,
}
# PNG name, its SVG, and the width to draw it at.
PNGS = [
    ("tend-logo.png", "tend-logo.svg", 1200),
    ("tend-logo-reversed.png", "tend-logo-reversed.svg", 1200),
    ("tend-mark-512.png", "tend-mark.svg", 512),
    ("tend-mark-tile-512.png", "tend-mark-tile.svg", 512),
]

# A blank page may not load file:// images, so each SVG goes in as a data: URL.
PLAYWRIGHT = """
import base64
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
jobs = [line.split("\\t") for line in sys.stdin.read().splitlines() if line]
with sync_playwright() as p:
    browser = p.chromium.launch()
    for svg, png, width in jobs:
        src = "data:image/svg+xml;base64," + base64.b64encode(Path(svg).read_bytes()).decode()
        page = browser.new_page(device_scale_factor=1)
        page.set_content(f'<html><body style="margin:0;background:transparent"><img id="i" src="{src}" style="display:block;width:{width}px"></body></html>')
        page.wait_for_function("document.getElementById('i').complete")
        page.locator("#i").screenshot(path=png, omit_background=True)
        page.close()
    browser.close()
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--png", action="store_true", help="also draw the PNGs (needs Playwright's Chromium)")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, make in FILES.items():
        (OUT / name).write_text(make(), encoding="ascii")
        print(f"wrote {OUT / name}")
    if args.png:
        jobs = "\n".join(f"{OUT / svg}\t{OUT / png}\t{w}" for png, svg, w in PNGS)
        cmd = ["uv", "run", "--quiet", "--python", "3.12", "--with", "playwright==1.47.0", "python", "-c", PLAYWRIGHT]
        subprocess.run(cmd, input=jobs, text=True, check=True)
        for png, _, _ in PNGS:
            print(f"wrote {OUT / png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
