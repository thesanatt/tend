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

const sources = [...files(path.join(web, "app")), ...files(path.join(web, "components")), ...files(path.join(web, "lib"))];
const HYPE = /\b(elevate|empower|unlock|seamless(ly)?|cutting-edge|robust|journey|revolutionize|supercharge|game-?changer)\b/i;

describe("user-facing copy", () => {
  it("has no em dashes, en dashes, or curly quotes in source", () => {
    const bad = sources.filter((f) => /[–—‘’“”]/.test(readFileSync(f, "utf8")));
    expect(bad.map((f) => path.relative(web, f))).toEqual([]);
  });

  it("avoids hype words", () => {
    const bad = sources.filter((f) => HYPE.test(readFileSync(f, "utf8")));
    expect(bad.map((f) => path.relative(web, f))).toEqual([]);
  });

  it("says the program decides wherever an amount is shown as askable", () => {
    const claim = readFileSync(path.join(web, "app/claim/ClaimScreen.tsx"), "utf8");
    expect(claim).toContain("Amount you can ask for. The program decides.");
  });
});
