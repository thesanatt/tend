// @vitest-environment jsdom
// How it works, as a reporter reads it: Design for safety comes first, every protection links to a file
// that exists in this repo, and each number in the copy is still the number in the code.
import { cleanup, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import HowItWorks from "@/app/how-it-works/page";
import { DOUBLE_PRESS_MS, EXIT_URL } from "@/components/QuickExit";
import { LINKS } from "@/components/tour/links";
import { MAX_EXPIRES_HOURS } from "@/lib/share";
import { MIN_PASSPHRASE } from "@/lib/vault";
import { PBKDF2_ITERATIONS } from "@/lib/vault/crypto";
import { DEFAULT_IDLE_MS } from "@/lib/vault/idle";

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "..");
const BLOB = `${LINKS.repo}/blob/main/`;

const GUARDS = [
  "Exit this page",
  "No name, no story",
  "On this device",
  "Saved progress",
  "Sharing with an advocate",
  "Payments",
];

let section: HTMLElement;
beforeEach(() => {
  render(HowItWorks());
  section = screen.getByRole("region", { name: "Design for safety" });
});
afterEach(() => cleanup());

const text = () => section.textContent!.replace(/\s+/g, " ");
const guard = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("li")!;

describe("Design for safety on /how-it-works", () => {
  it("comes right after the header and takes the place of the old Privacy section", () => {
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2[0]).toBe("Design for safety");
    expect(h2).toContain("The path of a claim");
    expect(h2).not.toContain("Privacy");
  });

  it("names each protection, then what it cannot stop", () => {
    const h3 = within(section)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(h3).toEqual([...GUARDS, "What Tend cannot stop"]);
    expect(text()).toContain("Malware on the device, or someone watching the screen.");
    expect(within(section).getByRole("link", { name: "docs/PRIVACY.md" }).getAttribute("href")).toBe(LINKS.privacy);
  });

  it("links every protection to files that exist in this repo", () => {
    for (const name of GUARDS) {
      const links = [...guard(name).querySelectorAll<HTMLAnchorElement>(`a[href^="${BLOB}"]`)];
      expect(links.length, name).toBeGreaterThan(0);
      for (const a of links) {
        const file = a.getAttribute("href")!.slice(BLOB.length);
        expect(a.textContent).toBe(file);
        expect(existsSync(path.join(repo, file)), file).toBe(true);
      }
    }
  });

  it("says what Exit this page does, and what it leaves behind", () => {
    expect(EXIT_URL).toBe("https://www.google.com/search?q=weather");
    expect(DOUBLE_PRESS_MS).toBe(1000);
    const exit = guard("Exit this page").textContent!;
    expect(exit).toContain("swaps the page for a Google search for the weather");
    expect(exit).toContain("twice within a second");
    expect(exit).toContain("Back can still reach an earlier Tend page in the same tab.");
  });

  it("matches the vault and share numbers in the code", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(DEFAULT_IDLE_MS).toBe(5 * 60_000);
    expect(MIN_PASSPHRASE).toBe(6);
    expect(MAX_EXPIRES_HOURS).toBe(7 * 24);
    const box = readFileSync(path.join(web, "components/flow/packet/ShareBox.tsx"), "utf8");
    expect(box).toContain("const HOURS = [24, 72, 168] as const;");
    expect(text()).toContain("PBKDF2-SHA-256 600,000 times");
    expect(text()).toContain("locks after five minutes");
    expect(text()).toContain("as short as six characters");
    expect(text()).toContain("one, three, or seven days");
  });

  it("matches the payment rules in api/tend_api/actions.py", () => {
    const actions = readFileSync(path.join(repo, "api/tend_api/actions.py"), "utf8");
    expect(actions).toMatch(/^CODE_TTL = dt\.timedelta\(minutes=10\)$/m);
    expect(actions).toMatch(/^MAX_ATTEMPTS = 5$/m);
    expect(actions).toContain('code = f"{secrets.randbelow(1_000_000):06d}"');
    expect(actions).toContain("if any(i in held for i in item_ids):");
    const pay = guard("Payments").textContent!;
    expect(pay).toContain("6-digit code");
    expect(pay).toContain("works once, for ten minutes, and five wrong tries lock the payment");
    expect(pay).toContain("will not pay a held exam line");
  });

  it("keeps the copy plain: ASCII, no dashes for punctuation, no exclamation marks, short sentences", () => {
    expect(text()).toMatch(/^[\x20-\x7e]*$/);
    expect(text()).not.toMatch(/!| - |--/);
    for (const p of section.querySelectorAll("p")) {
      for (const sentence of p.textContent!.trim().split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(28);
      }
    }
  });

  it("still says Tend is not legal advice and the program decides", () => {
    expect(document.body.textContent).toContain("Tend is not legal advice.");
    expect(document.body.textContent).toContain("The program decides.");
  });
});
