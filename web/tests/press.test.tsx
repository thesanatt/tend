// @vitest-environment jsdom
// /press as a reporter reads it: one paragraph on what Tend does, the builder's line word for word, every
// key fact with a link to its source, the real and demo box, Sanat's words and the contact as marked
// placeholders, and every file in public/press offered for download at its real size. Every number on the
// page is quoted from the docs or counted from the data, so nothing new is claimed here.
import { cleanup, render, screen, within } from "@testing-library/react";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PressPage, { metadata } from "@/app/press/page";
import { BUILDER, CONTACT, pressFacts, VIDEO, WHY } from "@/app/press/facts";
import { FACT_SHEET, LINK_CARD, LOGOS, PRESS_DIR, pngSize, SHOT_DIR, SHOTS } from "@/app/press/files";
import AppFooter from "@/components/flow/AppFooter";
import { loadCorpus } from "@/components/public/data";
import { siteCardAlt } from "@/components/public/og/siteCard";
import { LINKS } from "@/components/tour/links";
import { renderFlow } from "./helpers/flow";

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "..");
const BLOB = `${LINKS.repo}/blob/main/`;
const kit = pressFacts();

afterEach(() => cleanup());

const section = (name: string) => screen.getByRole("region", { name });
const flat = (el: Element) => el.textContent!.replace(/\s+/g, " ").trim();

function files(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
}

// Where a link on this site lands in the repo: a page in app/ (flow pages sit in app/(flow)) or a file in
// public/.
function onSite(href: string): boolean {
  const url = new URL(href, "https://youreowed.tech");
  const p = url.pathname;
  if (/\.\w+$/.test(p)) return existsSync(path.join(web, "public", p));
  const dir = p === "/" ? "" : p;
  const page = [path.join(web, "app", dir, "page.tsx"), path.join(web, "app", "(flow)", dir, "page.tsx")].find(
    existsSync,
  );
  if (!page) return false;
  return !url.hash || readFileSync(page, "utf8").includes(`id="${url.hash.slice(1)}"`);
}

describe("/press", () => {
  beforeEach(() => {
    render(PressPage());
  });

  it("says what Tend does in one paragraph, then gives the builder's line word for word", () => {
    expect(BUILDER).toBe(
      "Built by Sanat Gupta, a computer science senior at the University of Michigan, at MHacks 2026, where it took 1st place in Capital One's track.",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Press kit");
    const about = screen.getByText(kit.about);
    expect(about.tagName).toBe("P");
    expect(kit.about).toContain("Tend is a prototype.");
    expect(kit.about).toContain("not legal advice");
    const builder = screen.getByText((_, el) => el?.tagName === "P" && flat(el).startsWith(BUILDER));
    expect(within(builder).getByRole("link", { name: "Devpost" }).getAttribute("href")).toBe(LINKS.devpost);
  });

  it("links every key fact to its source, and every source to a page or file that exists", () => {
    const items = within(section("Key facts")).getAllByRole("listitem");
    expect(items).toHaveLength(kit.facts.length);
    for (const fact of kit.facts) {
      const item = document.getElementById(`fact-${fact.id}`)!;
      expect(flat(item), fact.id).toContain(fact.text);
      expect(fact.sources.length, fact.id).toBeGreaterThan(0);
      for (const source of fact.sources) {
        const link = within(item).getByRole("link", { name: source.label });
        expect(link.getAttribute("href")).toBe(source.href);
        if (source.href.startsWith("/")) expect(onSite(source.href), source.href).toBe(true);
        else expect(source.href, source.href).toMatch(/^https:\/\//);
        if (source.href.startsWith(BLOB))
          expect(existsSync(path.join(repo, source.href.slice(BLOB.length)))).toBe(true);
      }
    }
  });

  it("quotes every number from the docs or counts it from the data", () => {
    // The demo's numbers ($443.00, $325.00) live in docs/JUDGES.md, which holds the demo step by step.
    const docs = ["docs/SOURCES.md", "docs/EVAL.md", "docs/PRIVACY.md", "docs/JUDGES.md", "README.md"]
      .map((f) => readFileSync(path.join(repo, f), "utf8"))
      .join("\n");
    const corpus = loadCorpus();
    const counted = [corpus.rules, corpus.sources, corpus.programs].map((x) => x.toLocaleString("en-US"));
    const kb = Math.floor(statSync(path.join(web, "public/engine/tend.wasm")).size / 1000);
    counted.push(String(kb));
    // The counts are the site's own data, as the home page and /data show them.
    const synced = JSON.parse(readFileSync(path.join(web, "public/data/jurisdictions.json"), "utf8")) as {
      rules: number;
      sources: number;
    }[];
    expect(corpus.rules).toBe(synced.reduce((n, j) => n + j.rules, 0));
    expect(corpus.sources).toBe(synced.reduce((n, j) => n + j.sources, 0));
    const copy = [kit.about, kit.builder, ...kit.facts.map((f) => f.text), ...kit.real.map((r) => r.text)];
    for (const text of copy) {
      for (const [number] of text.matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)) {
        const plain = number.replace(/[.,]$/, "");
        expect(docs.includes(plain) || counted.includes(plain), `${plain} in "${text}"`).toBe(true);
      }
    }
  });

  it("says what is real, what is fictional, what is mock, and that Tend is a prototype", () => {
    const box = section("What's real and what's demo");
    const labels = within(box)
      .getAllByRole("term")
      .map((dt) => dt.textContent);
    expect(labels).toEqual(["Real", "Fictional", "Mock", "Prototype", "AI"]);
    const text = flat(box);
    expect(text).toContain("Rowan Hale, Riverbend General Hospital, every merchant, and every dollar in the demo.");
    expect(text).toContain("Nessie is Capital One's mock bank API");
    expect(text).toContain("moves only mock money");
    expect(text).toContain("No real users and no partners.");
    expect(text).toContain("Tend files nothing");
    expect(text).toContain("It does not show Tend read them correctly.");
  });

  it("says what can leave the device after a yes, and that the AI reads bills too", () => {
    // With a yes, the law check can run on Tend's server, and a bill or the bank rows Tend could not sort can
    // go to cloud AI. Design for safety and docs/PRIVACY.md (item 5) both describe the server check.
    const device = kit.facts.find((f) => f.id === "device")!;
    expect(device.text).toContain("Tend's server");
    expect(device.text).toContain("cloud AI");
    expect(device.sources.map((s) => s.href)).toContain("/how-it-works#safety");
    // Gemini Nano copies the lines of a bill photo or a scanned PDF, not only labels.
    const ai = kit.real.find((r) => r.label === "AI")!.text;
    expect(ai).toContain("reads photos and scans of bills");
    expect(ai).toContain("Cloud Gemini can do the same, but only after a yes");
  });

  it("does not call the rules open data, since no license is chosen yet", () => {
    // /data says "License: not chosen yet." Data with no license is not open data. Revisit once Sanat picks one.
    expect(document.body.textContent).not.toMatch(/open data/i);
    expect(kit.facts.find((f) => f.id === "rules")!.sources[0]).toEqual({
      label: "The rules as JSON and CSV",
      href: "/data",
    });
  });

  it("marks what Sanat has yet to write or choose, and writes none of it for him", () => {
    expect(WHY).toBeNull();
    expect(CONTACT).toBeNull();
    expect(VIDEO).toBeNull();
    const words = section("In Sanat's words");
    expect(flat(words)).toContain("Placeholder");
    expect(flat(words)).toContain("He has not written them yet.");
    expect(words.querySelector("blockquote")).toBeNull();
    expect(flat(section("Contact"))).toContain("Placeholder");
    expect(flat(section("Contact"))).toContain("not chosen yet");
    expect(section("Contact").querySelector('a[href^="mailto:"]')).toBeNull();
    expect(flat(section("Files"))).toContain("A video of the fictional demo is not published yet.");
  });

  it("offers every file in public/press for download, with its real size", () => {
    const offered = new Set(
      [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/press/"]')]
        .filter((a) => a.hasAttribute("download"))
        .map((a) => a.getAttribute("href")!),
    );
    const onDisk = files(PRESS_DIR).map((f) => `/press/${path.relative(PRESS_DIR, f).split(path.sep).join("/")}`);
    expect([...offered].sort()).toEqual(onDisk.sort());
    const text = flat(section("Files"));
    for (const logo of LOGOS) {
      const { width, height } = pngSize(logo.png);
      expect(text).toContain(`PNG, ${width} x ${height}`);
    }
    const card = pngSize(LINK_CARD.file);
    expect(text).toContain(`PNG, ${card.width} x ${card.height}`);
    expect(text).toMatch(/PDF, 1 page, \d+ KB/);
    // The button at the top downloads the same fact sheet.
    const button = screen.getByRole("link", { name: "Download the fact sheet (PDF)" });
    expect(button.getAttribute("href")).toBe(`/press/${FACT_SHEET}`);
    expect(button.hasAttribute("download")).toBe(true);
  });

  it("has 4 to 6 screenshots of the five screens, desktop at 1280 and phone at 390, each with alt text", () => {
    expect(SHOTS.length).toBeGreaterThanOrEqual(4);
    expect(SHOTS.length).toBeLessThanOrEqual(6);
    expect(
      readdirSync(path.join(PRESS_DIR, SHOT_DIR))
        .filter((f) => !f.startsWith("."))
        .sort(),
    ).toEqual(SHOTS.map((s) => s.file).sort());
    for (const subject of ["home", "mi", "bill-held", "packet", "share-card"])
      expect(
        SHOTS.some((s) => s.file.includes(subject)),
        subject,
      ).toBe(true);
    expect(new Set(SHOTS.map((s) => s.device))).toEqual(new Set(["desktop", "phone"]));
    // A downloaded frame leaves its caption behind, so a frame the caption calls fictional says demo in its name.
    for (const shot of SHOTS)
      expect(shot.file.startsWith("tend-demo-"), shot.file).toBe(/fictional/i.test(shot.caption));
    for (const shot of SHOTS) {
      const name = `${SHOT_DIR}/${shot.file}`;
      const bytes = readFileSync(path.join(PRESS_DIR, name));
      expect(bytes.subarray(1, 4).toString("ascii"), shot.file).toBe("PNG");
      // Taken at twice the pixels, so a frame 1280 or 390 pixels wide is 2560 or 780 in the file.
      expect(pngSize(name), shot.file).toEqual(
        shot.device === "desktop" ? { width: 2560, height: 1600 } : { width: 780, height: 1688 },
      );
      const img = document.querySelector(`img[src="/press/${name}"]`)!;
      expect(img.getAttribute("alt"), shot.file).toBe(shot.alt);
      expect(shot.alt.length, shot.file).toBeGreaterThan(40);
      expect(img.getAttribute("width")).toBe(String(shot.device === "desktop" ? 2560 : 780));
    }
  });

  it("names the scripts that make the files, and they exist", () => {
    const scripts = [...section("Files").querySelectorAll<HTMLAnchorElement>(`a[href^="${BLOB}"]`)].map((a) =>
      a.getAttribute("href")!.slice(BLOB.length),
    );
    expect(scripts).toEqual([
      "web/scripts/press-factsheet.ts",
      "web/scripts/press-screenshots.py",
      "web/scripts/press-logos.py",
      "web/scripts/press-social.tsx",
    ]);
    for (const file of scripts) expect(existsSync(path.join(repo, file)), file).toBe(true);
  });

  it("still says Tend is not legal advice and the program decides", () => {
    expect(document.body.textContent).toContain("Tend is not legal advice.");
    expect(document.body.textContent).toContain("The program decides.");
  });
});

describe("/press, as served", () => {
  const html = renderToStaticMarkup(PressPage());
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = doc.body.textContent!.replace(/\s+/g, " ");

  it("loads nothing from another site: no scripts, frames, or outside images", () => {
    expect(doc.querySelectorAll("script, iframe, embed, object")).toHaveLength(0);
    for (const img of doc.querySelectorAll("img")) expect(img.getAttribute("src")).toMatch(/^\/press\//);
  });

  it("keeps the copy plain: ASCII, no dashes for punctuation, no exclamation marks, never solo", () => {
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).not.toMatch(/!| - |--/);
    expect(text).not.toMatch(/\bsolo\b/i);
    expect(text).not.toMatch(/Fetch\.ai|ASI:One|Agentverse|uAgents/i);
    for (const fact of kit.facts) {
      for (const sentence of fact.text.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(30);
      }
    }
  });
});

describe("/press metadata", () => {
  it("has a title and description, and a posted link shows the home page's card", () => {
    expect(metadata.title).toBe("Press kit");
    expect(metadata.description).toMatch(/^Facts about Tend/);
    const image = { url: "/card.png", width: 1200, height: 630, type: "image/png", alt: siteCardAlt("home") };
    expect(metadata.openGraph).toEqual({
      type: "website",
      siteName: "Tend",
      title: "Tend press kit",
      description: metadata.description,
      url: "/press",
      images: [image],
    });
    expect(metadata.twitter).toEqual({
      card: "summary_large_image",
      title: "Tend press kit",
      description: metadata.description,
      images: [image],
    });
  });
});

describe("the site footer", () => {
  it("links the press kit on every page, in English", () => {
    renderFlow(<AppFooter />);
    const link = screen.getByRole("link", { name: "Press kit" });
    expect(link.getAttribute("href")).toBe("/press");
    expect(link.closest("p")!.textContent).toBe("Press kit for reporters.");
  });

  it("and in Spanish, where it says the page is in English", () => {
    renderFlow(<AppFooter />, { lang: "es" });
    const link = screen.getByRole("link", { name: "Kit de prensa" });
    expect(link.getAttribute("href")).toBe("/press");
    expect(link.getAttribute("hreflang")).toBe("en");
    expect(link.closest("p")!.textContent).toBe("Kit de prensa para periodistas, en ingl\u00e9s.");
  });
});
