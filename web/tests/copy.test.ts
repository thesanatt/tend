// Guards the copy rules for user-facing text: no em or en dashes, no curly quotes, no hype words.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const web = path.resolve(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|md)$/.test(name) ? [p] : [];
  });
}

const sources = [
  ...files(path.join(web, "app")),
  ...files(path.join(web, "components")),
  ...files(path.join(web, "lib")),
];
// en dash, em dash, and curly quotes, built from code points so this file stays ASCII
const BANNED = new RegExp(
  `[${[0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c)).join("")}]`,
);
const HYPE =
  /\b(elevate|empower|unlock|seamless(ly)?|cutting-edge|robust|journey|revolutionize|supercharge|game-?changer)\b/i;

describe("user-facing copy", () => {
  it("has no em dashes, en dashes, or curly quotes in source", () => {
    const bad = sources.filter((f) => BANNED.test(readFileSync(f, "utf8")));
    expect(bad.map((f) => path.relative(web, f))).toEqual([]);
  });

  // Code names such as Vault.unlock() are not copy; a lowercase name right before "(" is a call or
  // a method, so it is dropped before the check.
  const prose = (text: string) => text.replace(/\b[a-z]\w*\(/g, "(");

  it("avoids hype words", () => {
    const bad = sources.filter((f) => HYPE.test(prose(readFileSync(f, "utf8"))));
    expect(bad.map((f) => path.relative(web, f))).toEqual([]);
  });

  it("still catches hype words in copy while skipping method names", () => {
    expect(HYPE.test(prose("unlock(opts: { passphrase?: string }): Promise<boolean>;"))).toBe(false);
    expect(HYPE.test(prose("vault.unlock({ passkey: true })"))).toBe(false);
    expect(HYPE.test(prose("<p>Unlock your money journey</p>"))).toBe(true);
    expect(HYPE.test(prose("Tap to unlock (Touch ID)"))).toBe(true);
  });

  it("says the program decides wherever an amount is shown as askable", () => {
    const claim = readFileSync(path.join(web, "app/claim/ClaimScreen.tsx"), "utf8");
    expect(claim).toContain("Amount you can ask for. The program decides.");
  });
});
