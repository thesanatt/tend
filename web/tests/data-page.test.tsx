// @vitest-environment jsdom
// The rules dataset on the site: public/downloads holds exact copies of dataset/ (written by
// rules/tools/export_dataset.py), and /data shows each file's real size and SHA-256 and the same counts
// as the corpus the rest of the site is built from.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import DataPage, { metadata } from "@/app/data/page";
import { shortDate } from "@/components/public/format";
import type { Jurisdiction, JurisdictionSummary } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const dataset = path.join(web, "..", "dataset");
const downloads = path.join(web, "public", "downloads");
const FILES = [
  "README.md",
  "SHA256SUMS",
  "tend-jurisdictions-v1.0.csv",
  "tend-rules-v1.0.csv",
  "tend-rules-v1.0.json",
  "tend-sources-v1.0.csv",
];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const n = (x: number) => x.toLocaleString("en-US");

describe("public/downloads", () => {
  it("holds a byte-for-byte copy of every file in dataset/", () => {
    expect(readdirSync(dataset).sort()).toEqual(FILES);
    expect(readdirSync(downloads).sort()).toEqual(FILES);
    for (const name of FILES) {
      expect(readFileSync(path.join(downloads, name)).equals(readFileSync(path.join(dataset, name))), name).toBe(true);
    }
  });

  it("lists every other file in SHA256SUMS with its real SHA-256", () => {
    const sums = readFileSync(path.join(downloads, "SHA256SUMS"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => line.split("  "));
    expect(sums.map(([, name]) => name)).toEqual(FILES.filter((f) => f !== "SHA256SUMS"));
    for (const [digest, name] of sums) expect(sha256(readFileSync(path.join(downloads, name))), name).toBe(digest);
  });
});

describe("/data", () => {
  let doc: Document;
  const corpus = JSON.parse(
    readFileSync(path.join(web, "public/data/jurisdictions.json"), "utf8"),
  ) as (JurisdictionSummary & {
    decision_rules: number;
    info_rules: number;
    set_aside: number;
  })[];
  const sum = (pick: (j: (typeof corpus)[number]) => number) => corpus.reduce((total, j) => total + pick(j), 0);

  beforeAll(() => {
    doc = new DOMParser().parseFromString(renderToStaticMarkup(DataPage()), "text/html");
  });

  const counts = () =>
    Object.fromEntries(
      [...doc.querySelectorAll("#contents ~ dl > div")].map((row) => [
        row.querySelector("dt")!.textContent,
        row.querySelector("dd")!.textContent,
      ]),
    );

  it("shows the same counts as the corpus the site is built from", () => {
    const rows = counts();
    expect(rows["Rules"]).toBe(n(sum((j) => j.rules)));
    expect(rows["Jurisdictions"]).toBe(`${corpus.length}, the 50 states and DC`);
    expect(rows["Official sources saved"]).toMatch(
      new RegExp(`^${n(sum((j) => j.sources))}, of which [\\d,]+ are quoted by a rule$`),
    );
    expect(rows["What the engine does with them"]).toBe(
      `${n(sum((j) => j.decision_rules))} compiled as decision rules, ${n(sum((j) => j.info_rules))} kept as information, ${n(sum((j) => j.set_aside))} set aside with a reason`,
    );
    const saved = corpus
      .flatMap(
        (j) =>
          (JSON.parse(readFileSync(path.join(web, "public/data/law", `${j.st}.json`), "utf8")) as Jurisdiction).sources,
      )
      .map((s) => s.retrieved_at)
      .sort();
    const [first, last] = [shortDate(saved[0]), shortDate(saved.at(-1)!)];
    expect(rows["Current as of"]).toBe(
      `${first === last ? first : `${first} to ${last}`}, when the sources were saved`,
    );
  });

  it("links every file with its real size and SHA-256", () => {
    const items = [...doc.querySelectorAll("#download ~ ul > li")];
    expect(items).toHaveLength(FILES.length);
    for (const name of FILES) {
      const link = doc.querySelector(`a[href="/downloads/${name}"]`)!;
      expect(link, name).not.toBeNull();
      expect(link.hasAttribute("download")).toBe(true);
      const item = link.closest("li")!;
      const bytes = readFileSync(path.join(downloads, name));
      expect(item.querySelector("code")!.textContent).toBe(sha256(bytes));
      // The shown size, rounded to its unit, is the file's.
      const [, figure, unit] = /^([\d.]+) (MB|KB|bytes)$/.exec(item.querySelector("div > span")!.textContent!)!;
      const scale = { MB: 1_000_000, KB: 1_000, bytes: 1 }[unit as "MB" | "KB" | "bytes"];
      expect(Math.abs(Number(figure) * scale - bytes.length), name).toBeLessThanOrEqual(scale === 1 ? 0 : scale / 2);
    }
  });

  it("shows one real rule column by column, quote and all", () => {
    const mi = JSON.parse(readFileSync(path.join(web, "public/data/law/MI.json"), "utf8")) as Jurisdiction;
    const rule = mi.rules.find((r) => r.id === "MI-EXAM-1")!;
    const fields = doc.querySelector("#columns ~ dl")!;
    expect(fields.querySelectorAll(":scope > div")).toHaveLength(18);
    expect(fields.querySelector("mark")!.textContent).toBe(rule.quote);
    expect(fields.textContent).toContain(rule.pinpoint);
    expect(fields.querySelector(`a[href="${rule.fragment_url}"]`)).not.toBeNull();
    expect(fields.textContent).toContain(mi.sources.find((s) => s.id === rule.source_id)!.sha256);
  });

  it("keeps the citation and license marked as not decided, with no DOI", () => {
    const box = doc.querySelector("#cite ~ div")!;
    expect(box.textContent).toContain("Not decided yet");
    expect(box.textContent).toContain("How to cite: not set up yet. This version has no DOI.");
    expect(box.textContent).toContain("License: not chosen yet.");
    expect(doc.body.textContent).not.toMatch(/\b10\.\d{4,}\//);
  });

  it("says it is not legal advice and loads nothing from another site", () => {
    expect(doc.body.textContent).toContain("Tend is not legal advice.");
    expect(doc.body.textContent).toContain("The program decides.");
    expect(doc.querySelectorAll("script[src], img, iframe, link[href]")).toHaveLength(0);
  });

  it("has a title and a description, and nothing else for link previews yet", () => {
    expect(Object.keys(metadata).sort()).toEqual(["description", "title"]);
    expect(metadata.title).toBe("Rules data");
  });
});
