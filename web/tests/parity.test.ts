// Holds the preview engine to the Python reference (refengine/), which the C++ VM is difftested
// against. Regenerate with `python3 scripts/parity-fixtures.py` after the rules or the reference change.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePreview } from "@/lib/engine/preview";
import type { EngineInput, EngineOutput, Jurisdiction } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const dir = path.join(web, "fixtures/parity");
const states = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

describe("preview engine matches the reference engine", () => {
  it("covers every jurisdiction in public/data/law", () => {
    const laws = readdirSync(path.join(web, "public/data/law")).filter((f) => f.endsWith(".json"));
    expect(states).toHaveLength(laws.length);
  });

  it.each(states)("%s", (st) => {
    const raw = readFileSync(path.join(web, "public/data/law", `${st}.json`));
    const sha = createHash("sha256").update(raw).digest("hex");
    const fixture = JSON.parse(readFileSync(path.join(dir, `${st}.json`), "utf8")) as {
      law_sha256: string;
      cases: { input: EngineInput; output: EngineOutput }[];
    };
    expect(sha, "law file changed since the parity fixtures were made; rerun scripts/parity-fixtures.py").toBe(
      fixture.law_sha256,
    );
    const law = JSON.parse(raw.toString("utf8")) as Jurisdiction;
    for (const { input, output } of fixture.cases) {
      expect(evaluatePreview(input, law, sha)).toEqual(output);
    }
  });
});
