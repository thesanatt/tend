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
    // Dotfiles left out: Finder can drop a .DS_Store in either folder (gitignored).
    const listed = (dir: string) =>
      readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .sort();
    expect(listed(dataset)).toEqual(FILES);
    expect(listed(downloads)).toEqual(FILES);
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
  const limit = (words: string) =>
    [...doc.querySelectorAll("#limits ~ ul > li")].map((li) => li.textContent!).find((text) => text.includes(words));
  const released = JSON.parse(readFileSync(path.join(downloads, "tend-rules-v1.0.json"), "utf8")) as {
    sources: { source_id: string; url: string; kind: string; text_path: string; note: string | null }[];
    rules: { source_id: string }[];
  };
  const from = (host: string) => released.sources.filter((s) => new URL(s.url).hostname === host);
  const savedText = (s: { text_path: string }) => readFileSync(path.join(web, "..", s.text_path), "utf8");
  // Read from the "Universal Citation: ... (2025)" line on each saved Justia page.
  const justiaYears = () =>
    [
      ...new Set(
        from("law.justia.com").map((s) => /Universal Citation: [\s\S]{0,80}?\((\d{4})\)/.exec(savedText(s))![1]),
      ),
    ]
      .sort()
      .join(" or ");

  it("shows the same counts as the corpus the site is built from", () => {
    const rows = counts();
    expect(rows["Rules"]).toBe(n(sum((j) => j.rules)));
    expect(rows["Jurisdictions"]).toBe(`${corpus.length}, the 50 states and DC`);
    expect(rows["Sources saved"]).toMatch(
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
      `${first === last ? first : `${first} to ${last}`}, when the sources were saved; the ${n(from("law.justia.com").length)} statutes copied from Justia show each state's ${justiaYears()} code`,
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

  it("describes how the rules were made without saying who made them", () => {
    // Who drafted and reviewed the rules is Sanat's to say (a TODO in the page source and the README).
    expect(doc.body.textContent).not.toMatch(/researcher/i);
    const quoted = [...doc.querySelectorAll("#method ~ ol > li")].find((li) => li.textContent!.startsWith("Quoted."))!;
    expect(quoted.textContent).toContain("Each rule's quote was copied from the saved text, never paraphrased");
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

  it("says which sources are copies from sites that republish state law, counted from their addresses", () => {
    const [justia, cornell] = [from("law.justia.com"), from("www.law.cornell.edu")];
    const ids = new Set([...justia, ...cornell].map((s) => s.source_id));
    // The page names these two sites and their kinds of source; another site in the export needs its own words.
    expect(new Set(justia.map((s) => s.kind))).toEqual(new Set(["statute"]));
    expect(new Set(cornell.map((s) => s.kind))).toEqual(new Set(["regulation"]));
    // What the page says each saved copy says about how current it is.
    for (const s of justia) expect(savedText(s), s.source_id).toContain("may not be the most recent version");
    for (const s of cornell) expect(savedText(s), s.source_id).toContain("State regulations are updated quarterly");
    const item = limit("republish state law")!;
    expect(item).toContain(
      `${n(ids.size)} sources are copies on sites that republish state law, not the state's own publication: ${n(justia.length)} statutes from Justia and ${n(cornell.length)} regulations from Cornell's Legal Information Institute.`,
    );
    expect(item).toContain(
      `Justia's pages show each state's ${justiaYears()} code and say it may not be the most recent version`,
    );
    const quoting = released.rules.filter((r) => ids.has(r.source_id)).length;
    expect(item).toContain(`The ${n(quoting)} rules that quote these copies match the copies`);
    expect(doc.body.textContent).not.toMatch(/official/i);
  });

  it("says the SHA-256 of a redacted page is of the redacted copy", () => {
    const redacted = released.sources.filter((s) => s.note?.includes("redacted")).length;
    expect(limit("was recorded")).toBe(
      `A SHA-256 shows the saved copy has not changed since its SHA-256 was recorded. It cannot show what the live page says today. On ${n(redacted)} saved pages, third-party API keys embedded in the page were redacted after the page was saved, so their SHA-256 is of the redacted copy.`,
    );
  });

  it("counts the detail fields verify.py checks from verify.py itself", () => {
    const verify = readFileSync(path.join(web, "..", "rules/tools/verify.py"), "utf8");
    const keys = /^NUMERIC_PARAMS = \{(.+)\}$/m.exec(verify)![1].split(",");
    expect(keys).toHaveLength(8);
    expect(doc.querySelector("#method ~ ol")!.textContent).toContain("The numbers in eight of its detail fields");
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
