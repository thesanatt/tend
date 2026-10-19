// @vitest-environment jsdom
// /sources, as a skeptical reader checks it: every count about Tend's own rules is recounted here from the
// synced corpus, each state the page names is named for a reason the rules still give, and the rerun
// command is the one that prints the number.
import { cleanup, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOT_A_BAR } from "@/app/sources/counts";
import Sources from "@/app/sources/page";
import STATES from "@/lib/states.json";
import type { Jurisdiction } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "..");

const law = (st: string) =>
  JSON.parse(readFileSync(path.join(web, `public/data/law/${st}.json`), "utf8")) as Jurisdiction;
const ir = (st: string) =>
  JSON.parse(readFileSync(path.join(web, `public/data/ir/${st}.json`), "utf8")) as {
    rules: { id: string; kind: string }[];
    skipped: { id: string; reason: string }[];
  };
const rule = (st: string, id: string) => law(st).rules.find((r) => r.id === id)!;

let text: string;
beforeEach(() => {
  render(Sources());
  text = document.body.textContent!.replace(/\s+/g, " ");
});
afterEach(() => cleanup());

// The claim block whose heading starts with these words.
function claim(start: string): string {
  const h3 = screen.getAllByRole("heading", { level: 3 }).find((h) => h.textContent!.startsWith(start));
  expect(h3, start).toBeDefined();
  return h3!.parentElement!.textContent!.replace(/\s+/g, " ");
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const Word = (x: number) => WORDS[x].charAt(0).toUpperCase() + WORDS[x].slice(1);

// The numbers here are recounted from the corpus, so they follow the rules when the rules change. The comments
// give today's values (corpus of Oct 3, 2026).
describe("the exam billing count", () => {
  // A jurisdiction counts when its engine applies an exam_no_bill rule that bars billing the survivor.
  const counted = STATES.filter(({ st }) => {
    const applied = new Set(
      ir(st)
        .rules.filter((r) => r.kind === "exam_no_bill")
        .map((r) => r.id),
    );
    return law(st).rules.some((r) => r.category === "exam_no_bill" && applied.has(r.id) && !NOT_A_BAR.has(r.id));
  }).map((s) => s.st);
  const missing = STATES.filter((s) => !counted.includes(s.st));
  const heading = `In ${counted.length} of ${STATES.length} jurisdictions`;

  it("counts only rules that bar billing the survivor, so Idaho's insurance and payment rules are left out", () => {
    // 48 today: every jurisdiction but Idaho, Rhode Island, and Wyoming.
    expect(counted.length).toBeLessThanOrEqual(48);
    expect(missing.map((s) => s.st)).toEqual(expect.arrayContaining(["ID", "RI", "WY"]));
    const block = claim(heading);
    expect(block).toContain(`${Word(missing.length)} are not counted.`);
    for (const { name } of missing) expect(block).toContain(name);
    expect(block).not.toMatch(/more likely|\byet\b/);
  });

  it("states Idaho's rules in their own terms", () => {
    expect(rule("ID", "ID-EXAM-3").quote).toContain("private insurance should not be billed");
    expect(rule("ID", "ID-EXAM-5").quote).toContain("may not attempt to collect any further payment");
    const saved = readFileSync(path.join(repo, "rules/sources/ID/ID-S5.txt"), "utf8");
    expect(saved).toContain("the medical provider may collect the unpaid balance for those services from the victim");
    expect(claim(heading)).toContain("None of Tend's verified Idaho rules says the survivor must not be billed.");
  });

  it("gives Wyoming's and Rhode Island's reasons from their rules", () => {
    expect(ir("WY").skipped).toContainEqual({
      id: "WY-EXAM-2",
      category: "exam_no_bill",
      reason: expect.stringContaining("law enforcement"),
    });
    expect(law("RI").rules.filter((r) => r.category === "exam_no_bill")).toEqual([]);
    const block = claim(heading);
    expect(block).toContain("Wyoming's rule covers only survivors who report to police");
    expect(block).toContain("For Rhode Island, Tend's verified rules don't include an exam-billing rule.");
  });

  it("names the six states GAO found, and why Tend still counts the ones it does", () => {
    const block = claim(heading);
    expect(block).toContain(
      "found six states with no law or policy that explicitly says survivors must not be billed: Hawaii, Idaho, Oklahoma, Rhode Island, Virginia, and Wyoming (GAO-24-106036, page 12).",
    );
    // Hawaii, Oklahoma, and Virginia today.
    const still = ["HI", "ID", "OK", "RI", "VA", "WY"].filter((st) => counted.includes(st));
    expect(block).toContain(`Tend still counts ${WORDS[still.length]} of them.`);
    const why: Record<string, [string, string, string]> = {
      OK: [
        "OK-EXAM-1",
        "The right to a free forensic medical examination",
        "An Oklahoma statute lists a free forensic exam",
      ],
      VA: [
        "VA-EXAM-3",
        "evidence collection at no cost to you",
        "Virginia's notice to patients says evidence collection is at no cost",
      ],
      HI: [
        "HI-EXAM-1",
        "victims are offered and provided free forensic examinations",
        "Hawaii's Attorney General program page says police are to make sure",
      ],
    };
    for (const st of still) {
      const [id, quote, says] = why[st];
      expect(rule(st, id).quote).toContain(quote);
      expect(block).toContain(says);
    }
    if (!still.includes("HI"))
      expect(block).toContain("Hawaii's rule is a sentence on the Attorney General's program page");
  });

  it("gives its examples of limits from the quotes", () => {
    expect(counted).toEqual(expect.arrayContaining(["AR", "TX"]));
    expect(rule("AR", "AR-EXAM-1").quote).toContain("within ninety-six (96) hours of the attack");
    expect(rule("TX", "TX-EXAM-1").quote).toContain("the forensic portion of the forensic medical examination");
    expect(claim(heading)).toContain(
      "such as an exam within 96 hours of the attack in Arkansas, or only the forensic part of the exam in Texas.",
    );
  });
});

describe("the address confidentiality count", () => {
  const programs = (st: string) => law(st).rules.filter((r) => r.category === "address_confidentiality");
  const open = STATES.filter(({ st }) => programs(st).some((r) => r.params?.covers_sexual_assault === true));
  const narrow = STATES.filter(({ st }) => programs(st).length && !open.some((s) => s.st === st));
  const none = STATES.filter(({ st }) => !programs(st).length);
  const heading = `In ${open.length} jurisdictions, Tend's verified rules include an address confidentiality program`;

  it("counts only programs open to sexual assault survivors, and names the rest", () => {
    // 45 today. Florida, Arkansas, and South Dakota have narrower programs; Alabama, North Dakota, and Wyoming none.
    expect(open.length).toBeLessThanOrEqual(45);
    const block = claim(heading);
    expect(block).toContain(`${Word(narrow.length)} more are not counted.`);
    const says: Record<string, string> = {
      FL: "Florida's program covers domestic violence, dating violence, and stalking.",
      AR: "Arkansas's program puts a post office box on the driver's license or ID card",
      SD: "South Dakota's program only keeps a voter record private.",
    };
    for (const { st, name } of narrow) expect(block).toContain(says[st] ?? name);
    for (const { name } of none) expect(block).toContain(name);
    expect(block).toMatch(/Tend's rules include none for [A-Z]/);
    expect(block).not.toMatch(/48 jurisdictions/);
  });

  it("says Alaska's program is counted while its saved sources say nothing about enrolling", () => {
    expect(String(programs("AK")[0].params?.enroll)).toContain("No enrollment procedure or application was published");
    expect(claim(heading)).toContain(
      "Alaska's program is counted, though none of the Alaska sources Tend saved says how to enroll.",
    );
  });

  it("matches what each named state's rule says", () => {
    expect(rule("SD", "SD-ACP-1").quote).toContain(
      "A voter record with a secured active designation shall be excluded",
    );
    expect(rule("AR", "AR-ACP-1").quote).toContain("post office box in lieu of a residential address");
    expect(rule("FL", "FL-ACP-1").quote).toContain("relocated victims of domestic violence");
  });
});

describe("Tend's own numbers", () => {
  it("counts the rules and the saved copies from Justia and Cornell", () => {
    const hosts = STATES.flatMap(({ st }) => {
      const j = law(st);
      const host = new Map(j.sources.map((s) => [s.id, new URL(s.url).hostname]));
      return j.rules.map((r) => host.get(r.source_id));
    });
    const sources = STATES.flatMap(({ st }) => law(st).sources.map((s) => new URL(s.url).hostname));
    const justia = sources.filter((h) => h === "law.justia.com").length;
    const cornell = sources.filter((h) => h === "www.law.cornell.edu").length;
    const quoting = hosts.filter((h) => h === "law.justia.com" || h === "www.law.cornell.edu").length;
    expect([justia, cornell, quoting]).toEqual([103, 17, 234]);
    const block = claim("2,578 rules from 824 saved sources, for 51 jurisdictions.");
    expect(block).toContain(
      `${justia + cornell} of the sources are copies of state statutes and regulations saved from Justia (${justia}) or Cornell's Legal Information Institute (${cornell})`,
    );
    expect(block).toContain(`The ${quoting} rules that quote them match those copies`);
  });

  it("gives the difftest command that runs 121,000 claims, and what byte for byte covers", () => {
    const evalMd = readFileSync(path.join(repo, "engine/EVAL.md"), "utf8");
    expect(evalMd).toContain(
      "difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000`) | **121,000 claims, 0 mismatches**",
    );
    expect(evalMd).toContain("119,600 claims were well-formed JSON");
    expect(evalMd).toContain("1,400 of the refused claims were not JSON at all");
    const block = claim("121,000 test claims, 0 mismatches between the two law engines.");
    expect(block).toContain("On the 119,600 claims that are valid JSON, both return the same bytes.");
    const commands = screen.getByLabelText("Commands that rerun the engine test").textContent!.split("\n");
    expect(commands).toEqual([
      "make -C engine",
      "uv run --project refengine python refengine/difftest.py --n 2000 --random-laws 300 --ir-fuzz 3000",
    ]);
  });

  it("reads the engine size from the file and says the compiler is not in it", () => {
    const kb = Math.floor(statSync(path.join(web, "public/engine/tend.wasm")).size / 1000);
    expect(readdirSync(path.join(web, "public/engine/laws")).filter((f) => f.endsWith(".tlaw"))).toHaveLength(51);
    expect(claim(`The law VM runs in your browser as ${kb} KB of WebAssembly.`)).toContain(
      "The compiler, tendc, is not in it",
    );
  });

  it("holds a page or document from every program's own website, and says what Kentucky's are", () => {
    const host = (u?: string | null) => (u ? new URL(u).hostname.replace(/^www\./, "") : null);
    for (const { st } of STATES) {
      const j = law(st);
      const own = new Set([j.program.website, j.program.apply_url, j.program.application_pdf_url].map(host));
      expect(
        j.sources.some((s) => own.has(host(s.url))),
        st,
      ).toBe(true);
    }
    expect(law("KY").sources.some((s) => s.kind === "agency_page")).toBe(false);
    expect(text).toContain("For Kentucky, Tend saved the program's PDFs, such as its FAQ, brochure, and application");
    expect(text).not.toMatch(/official program pages/);
  });

  it("still says Tend is not legal advice and the program decides", () => {
    expect(text).toContain("Tend is not legal advice.");
    expect(text).toContain("The program decides.");
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});
