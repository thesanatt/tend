// @vitest-environment jsdom
// Layout rules a phone once broke, checked against the CSS that keeps them: hidden words inside a box
// that scrolls sideways stay in that box, the garden's targets are 44px, and Exit this page sits in the
// top bar with nothing sticky under it. jsdom has no layout, so e2e/test_layout.py measures the same
// rules in Chromium at 360, 390, and 430px.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

afterEach(() => cleanup());

const web = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(web, file), "utf8");

interface Rule {
  selector: string;
  media: string | null;
  decls: Record<string, string>;
}

// Enough of CSS for these files: comments dropped, every rule with its declarations and the @media it
// sits in.
function parseCss(text: string): Rule[] {
  const rules: Rule[] = [];
  const open: string[] = [];
  let buf = "";
  for (const ch of text.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") {
      open.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      const prelude = open.pop() ?? "";
      if (!prelude.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const d of buf.split(";")) {
          const i = d.indexOf(":");
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
        rules.push({ selector: prelude, media: open.find((p) => p.startsWith("@")) ?? null, decls });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

const forClass = (rules: Rule[], name: string) =>
  rules.filter((r) => r.selector.split(",").some((s) => s.trim() === `.${name}`));

// vitest names a module class "_tableWrap_687715"; the CSS file calls it ".tableWrap".
const moduleClasses = (el: Element) =>
  [...el.classList].map((c) => /^_(.+)_[0-9a-f]+$/.exec(c)?.[1]).filter((c): c is string => !!c);

const garden = parseCss(read("components/public/LawGarden.module.css"));
const scrolls = (name: string) =>
  forClass(garden, name).some((r) => /\b(auto|scroll)\b/.test(r.decls["overflow-x"] ?? r.decls.overflow ?? ""));

// Each .visually-hidden span is position:absolute. Inside a box that scrolls sideways, the box (or
// something in it) must be positioned, or the span's containing block is the page and the span widens
// it from wherever it sits in the scrolled content.
function hiddenWordsStayInTheirBox(section: Element): number {
  let inBoxes = 0;
  for (const span of section.querySelectorAll(".visually-hidden")) {
    let positioned = false;
    for (let el = span.parentElement; el && el !== section; el = el.parentElement) {
      for (const name of moduleClasses(el)) {
        const rules = forClass(garden, name);
        if (rules.some((r) => /^(relative|absolute|sticky|fixed)$/.test(r.decls.position ?? ""))) positioned = true;
        expect(rules.some((r) => r.decls.position === "static"), `.${name} turns static somewhere`).toBe(false);
      }
      if (moduleClasses(el).some(scrolls)) {
        expect(positioned, `"${span.textContent}" in .${moduleClasses(el).join(".")}`).toBe(true);
        inBoxes += 1;
        break;
      }
    }
  }
  return inBoxes;
}

describe("the law garden on a phone", () => {
  it("keeps the map's and the list's hidden words inside the boxes that scroll", () => {
    render(Home());
    const section = screen.getByRole("heading", { name: "The law garden" }).closest("section")!;
    expect(hiddenWordsStayInTheirBox(section)).toBe(51);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    // The caption, and "for Alabama" and the rest after each Rules link.
    expect(hiddenWordsStayInTheirBox(section)).toBe(52);
  });

  it("gives every map tile, list link, and the demo link a 44px target", () => {
    const map = forClass(garden, "map");
    expect(map.find((r) => !r.media)!.decls["grid-template-columns"]).toBe("repeat(11, minmax(44px, 1fr))");
    expect(map.filter((r) => r.media).every((r) => !("grid-template-columns" in r.decls))).toBe(true);
    const tile = forClass(garden, "tile");
    expect(tile.find((r) => !r.media)!.decls["min-height"]).toBe("44px");
    expect(tile.filter((r) => r.media).every((r) => !("min-height" in r.decls) && !("width" in r.decls))).toBe(true);

    const links = garden.find((r) => r.selector === ".table a")!.decls;
    expect(links["min-width"]).toBe("44px");
    expect(links["padding-block"]).toBe("calc((44px - 1lh) / 2)");

    render(Home());
    const demo = screen.getByRole("link", { name: "Or try it with a fictional demo account" });
    const home = parseCss(read("app/page.module.css"));
    for (const name of moduleClasses(demo)) expect(forClass(home, name)[0].decls["min-height"]).toBe("44px");
    expect(moduleClasses(demo)).toEqual(["demoLink"]);
  });

  it("says the map scrolls sideways only in the map view, and only where it does", () => {
    render(Home());
    expect(screen.getByText("The map scrolls sideways. List shows all 51 programs at once.")).toBeTruthy();
    const note = forClass(garden, "scrollNote");
    expect(note.find((r) => !r.media)!.decls.display).toBe("none");
    expect(note.find((r) => r.media === "@media (max-width: 547px)")!.decls.display).toBe("block");
    const bleed = forClass(garden, "mapScroll").find((r) => r.media === "@media (max-width: 547px)")!;
    expect(bleed.decls["margin-inline"]).toBe("calc(var(--gutter) * -1)");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByText(/The map scrolls sideways/)).toBeNull();
  });
});

describe("the top bar", () => {
  const bar = Number(/--bar:\s*(\d+)px/.exec(read("app/globals.css"))![1]);
  const shell = parseCss(read("components/flow/shell.module.css"));
  const centered = (value: string | undefined) => {
    const m = /^calc\(\(var\(--bar\) - (\d+)px\) \/ 2\)$/.exec(value ?? "");
    return m ? (bar - Number(m[1])) / 2 : NaN;
  };

  it("is an opaque band as tall as the bar, with Exit this page inside it and above it", () => {
    const band = shell.find((r) => r.selector === ".header::before")!.decls;
    expect(band.position).toBe("fixed");
    expect(band.height).toBe("var(--bar)");
    expect(band.background).toBe("var(--paper)");

    const exitWrap = forClass(shell, "exitWrap").find((r) => !r.media)!.decls;
    const exit = forClass(shell, "exit").find((r) => !r.media)!.decls;
    expect(exitWrap.position).toBe("fixed");
    expect(Number(exitWrap["z-index"])).toBeGreaterThan(Number(band["z-index"]));
    const top = centered(exitWrap.top);
    expect(exit["min-height"]).toBe("44px");
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + 44).toBeLessThanOrEqual(bar);
    // The Esc hint sits beside the button, not under it, so it stays in the bar too.
    expect(exitWrap["flex-direction"]).toBe("row-reverse");

    const brand = forClass(shell, "brand").find((r) => !r.media)!.decls;
    expect(centered(brand.top) + 44).toBeLessThanOrEqual(bar);
  });

  it("keeps links to a heading, and focus, from landing under the bar", () => {
    const html = parseCss(read("app/globals.css")).find((r) => r.selector === "html")!.decls;
    expect(html["scroll-padding-top"]).toBe("calc(var(--bar) + var(--space-4))");
  });

  it("has nothing sticky on the page that stops under it", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = path.join(dir, name);
        return statSync(p).isDirectory() ? files(p) : name.endsWith(".css") ? [p] : [];
      });
    // Sticks inside its own scrolling box (.traceWrap), not to the page.
    const ownBox = new Set([".trace thead th"]);
    const sticky = [...files(path.join(web, "app")), ...files(path.join(web, "components"))].flatMap((f) =>
      parseCss(readFileSync(f, "utf8"))
        .filter((r) => r.decls.position === "sticky" && !ownBox.has(r.selector))
        .map((r) => ({ where: `${path.relative(web, f)} ${r.selector}`, top: r.decls.top ?? "" })),
    );
    expect(sticky.length).toBeGreaterThanOrEqual(3);
    for (const { where, top } of sticky) {
      const px = /^(\d+)px$/.exec(top);
      expect(top.includes("var(--bar)") || (px !== null && Number(px[1]) >= bar), `${where}: top ${top}`).toBe(true);
    }
  });
});
