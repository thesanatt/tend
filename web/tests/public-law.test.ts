// "How Tend decides": the listing parser, the plain words for each rule's IR treatment, and the
// two data scripts (sync-rules.mjs, build-asm.mjs) run against temporary directories.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asmHeader, asmLine, directiveAnchor } from "@/components/public/asm";
import { ruleUse, skipReason } from "@/components/public/irWords";
import type { AsmEntry, IrSummary } from "@/components/public/types";

const web = path.resolve(import.meta.dirname, "..");
const ids = new Set(["MI-EXAM-1", "MI-EXAM-2", "MI-COV-1", "MI-CAP-3"]);

describe("listing lines", () => {
  it("splits an instruction into offset, label, code, and a comment with rule links", () => {
    const segs = asmLine("  0077  L1:   decide   held, P1        ; MI-EXAM-1, MI-EXAM-2", ids);
    expect(segs).toEqual([
      { t: "  " },
      { t: "0077", k: "off" },
      { t: "  " },
      { t: "L1:", k: "label" },
      { t: "   decide   held, P1        " },
      { t: "; ", k: "comment" },
      { t: "MI-EXAM-1", k: "comment", id: "MI-EXAM-1" },
      { t: ", ", k: "comment" },
      { t: "MI-EXAM-2", k: "comment", id: "MI-EXAM-2" },
    ]);
  });

  it("links rule ids in the rule table but not unknown ids or register names", () => {
    const segs = asmLine("    R6    MI-CAP-3    expense_cap   counseling   per session   MCL 18.361(6)", ids);
    expect(segs.filter((s) => s.id).map((s) => s.t)).toEqual(["MI-CAP-3"]);
    expect(asmLine("    R9    MI-CAP-9    expense_cap", ids).some((s) => s.id)).toBe(false);
    expect(segs.map((s) => s.t).join("")).toBe(
      "    R6    MI-CAP-3    expense_cap   counseling   per session   MCL 18.361(6)",
    );
  });

  it("marks whole comment lines and section directives, with anchors for the sections", () => {
    const comment = asmLine('              ; MI-COV-1  MCL 18.361(2)(a)  "(a) Medical care..."', ids);
    expect(comment.every((s) => s.k === "comment")).toBe(true);
    expect(comment.find((s) => s.id)?.t).toBe("MI-COV-1");
    const dir = asmLine(".tags   phone=bit0, purse=bit1", ids);
    expect(dir[0]).toEqual({ t: ".tags", k: "dir" });
    expect(directiveAnchor(dir[0])).toBe("asm-tags");
    expect(directiveAnchor(asmLine(".item", ids)[0])).toBe("asm-item");
    expect(directiveAnchor({ t: "push", k: undefined })).toBeNull();
  });

  it("reads the header of a real listing", () => {
    const text = readFileSync(path.join(web, "public/data/asm/MI.txt"), "utf8");
    const head = asmHeader(text);
    expect(head.title).toBe("MI, Michigan");
    expect(head.compiler).toMatch(/^tendc /);
    expect(head.rules_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(head.image_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(head.counts).toMatch(/^\d+ rules, \d+ sources/);
    expect(head.programs).toHaveLength(2);
    // Every line rebuilds exactly from its pieces.
    for (const line of text.split("\n")) expect(asmLine(line, ids).map((s) => s.t).join("")).toBe(line);
  });
});

describe("plain words for what the engine does with a rule", () => {
  it("covers each IR kind", () => {
    expect(ruleUse({ id: "a", kind: "exam_no_bill" }, undefined).use).toBe("decides");
    expect(ruleUse({ id: "a", kind: "total_cap", cap_cents: 4500000 }, undefined).text).toBe(
      "Decides: the total for the claim stops at $45,000.",
    );
    expect(
      ruleUse(
        {
          id: "a",
          kind: "expense_cap",
          expense: "counseling",
          cap_cents: 12500,
          per: "unit",
          unit: "session",
          count_limit: 35,
          alt_rule_ids: ["MI-CAP-2"],
        },
        undefined,
      ).text,
    ).toBe("Decides: counseling is limited to $125 per session, for up to 35 sessions. Lower limits kept beside it: MI-CAP-2.");
    expect(ruleUse({ id: "a", kind: "expense_cap", expense: "relocation", cap_cents: 380000, per: "claim" }, undefined).text).toBe(
      "Decides: moving is limited to $3,800 in total.",
    );
    expect(ruleUse({ id: "a", kind: "covered", expense: "transportation" }, undefined).text).toBe(
      "Decides: travel counts as a covered cost.",
    );
    expect(ruleUse({ id: "a", kind: "excluded", expense: "property_replacement", tags: ["phone", "purse"] }, undefined).text).toBe(
      "Decides: replacing belongings is not covered when it is a phone or purse.",
    );
    expect(ruleUse({ id: "a", kind: "deadline", days: 1826, from: "crime" }, undefined).text).toBe(
      "Decides: the filing deadline, 1,826 days after the crime.",
    );
    expect(ruleUse({ id: "a", kind: "reporting", required: true, alternatives: ["forensic_exam"] }, undefined).text).toBe(
      "Decides: a police report is required, and a forensic exam can count instead.",
    );
    expect(
      ruleUse(
        { id: "a", kind: "minimum_loss", cap_cents: 20000, days_lost: 5, waiver: "discretionary", waiver_for_sexual_assault: true },
        undefined,
      ).text,
    ).toBe("Decides: the minimum loss, at least $200 in costs or 5 days of lost pay. The program may waive it after a sexual assault.");
    expect(ruleUse({ id: "a", kind: "collateral" }, undefined).use).toBe("decides");
    expect(ruleUse({ id: "a", kind: "info", category: "residency" }, undefined)).toEqual({
      use: "info",
      text: "Shown for information. The engine does not use it in the math.",
    });
    expect(ruleUse(undefined, undefined).use).toBe("not_compiled");
    expect(ruleUse(undefined, { id: "a", reason: "less generous duplicate of MI-CAP-3" }).use).toBe("set_aside");
  });

  it("explains each normalizer reason and keeps unknown ones as written", () => {
    expect(skipReason("less generous duplicate of MI-CAP-3")).toMatch(/MI-CAP-3, is used instead/);
    expect(skipReason('applies_to "family members of the victim"')).toBe(
      "it applies only to family members of the victim. The engine does not check that, so it leaves this rule out of the math.",
    );
    expect(skipReason("expense_cap without amount or expense")).toMatch(/nothing to compute/);
    expect(skipReason("something new")).toBe("something new");
  });

  it("gives every rule in the corpus a reading", () => {
    for (const st of ["MI", "NY", "CA", "TX", "IL"]) {
      const ir = JSON.parse(readFileSync(path.join(web, "public/data/ir", `${st}.json`), "utf8")) as IrSummary;
      for (const r of ir.rules) expect(ruleUse(r, undefined).text).not.toMatch(/undefined|NaN/);
      for (const s of ir.skipped) expect(ruleUse(undefined, s).text).not.toMatch(/undefined/);
    }
  });
});

describe("scripts/sync-rules.mjs", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "tend-sync-"));
    const rules = path.join(tmp, "rules");
    mkdirSync(path.join(rules, "verified"), { recursive: true });
    mkdirSync(path.join(rules, "ir"), { recursive: true });
    for (const st of ["MI", "NY"]) {
      cpSync(path.join(web, "..", "rules", "verified", `${st}.json`), path.join(rules, "verified", `${st}.json`));
      cpSync(path.join(web, "..", "rules", "ir", `${st}.json`), path.join(rules, "ir", `${st}.json`));
    }
    // NY's IR now points at an older verified file.
    const ny = JSON.parse(readFileSync(path.join(rules, "ir", "NY.json"), "utf8"));
    writeFileSync(path.join(rules, "ir", "NY.json"), JSON.stringify({ ...ny, source_sha256: "0".repeat(64) }));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("copies verified rules byte for byte and writes IR summaries with counts and freshness", () => {
    const out = path.join(tmp, "data");
    const log = execFileSync("node", ["scripts/sync-rules.mjs", path.join(tmp, "rules"), "--out", out], {
      cwd: web,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(log).toMatch(/^2 of 51 jurisdictions verified/);
    const verified = readFileSync(path.join(tmp, "rules", "verified", "MI.json"));
    expect(readFileSync(path.join(out, "law", "MI.json")).equals(verified)).toBe(true);

    const ir = JSON.parse(readFileSync(path.join(out, "ir", "MI.json"), "utf8")) as IrSummary & { program?: unknown };
    const irRaw = readFileSync(path.join(tmp, "rules", "ir", "MI.json"));
    expect(ir.fresh).toBe(true);
    expect(ir.ir_sha256).toBe(createHash("sha256").update(irRaw).digest("hex"));
    expect(ir.program).toBeUndefined();
    expect(ir.skipped.map((s) => s.id)).toEqual(["MI-CAP-2", "MI-CAP-4", "MI-CAP-7"]);

    const list = JSON.parse(readFileSync(path.join(out, "jurisdictions.json"), "utf8")) as Record<string, unknown>[];
    expect(list).toHaveLength(51);
    const mi = list.find((j) => j.st === "MI")!;
    expect(mi).toMatchObject({ rules: 83, sources: 23, ir_fresh: true, set_aside: 3 });
    expect((mi.decision_rules as number) + (mi.info_rules as number)).toBe(80);
    expect(list.find((j) => j.st === "NY")).toMatchObject({ ir_fresh: false });
    expect(list.find((j) => j.st === "OH")).toEqual({ st: "OH", name: "Ohio", rules: 0, sources: 0 });
  });
});

describe("scripts/build-asm.mjs", () => {
  let tmp: string;
  let data: string;
  let laws: string;
  let tdis: string;
  let listing: string;
  let server: Server;
  let api: string;
  const lawSha = "a".repeat(64);
  const irSha = "b".repeat(64);

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "tend-asm-"));
    data = path.join(tmp, "data");
    laws = path.join(tmp, "laws");
    mkdirSync(path.join(data, "ir"), { recursive: true });
    mkdirSync(laws, { recursive: true });
    writeFileSync(path.join(data, "jurisdictions.json"), JSON.stringify([{ st: "MI", name: "Michigan", sha256: lawSha }]));
    const ir: IrSummary = {
      ir_version: 2,
      jurisdiction: "MI",
      source_sha256: lawSha,
      ir_sha256: irSha,
      fresh: true,
      rules: [
        { id: "MI-EXAM-1", kind: "exam_no_bill" },
        { id: "MI-COV-1", kind: "covered", expense: "medical" },
      ],
      skipped: [{ id: "MI-CAP-2", reason: "less generous duplicate of MI-CAP-3" }],
    };
    writeFileSync(path.join(data, "ir", "MI.json"), JSON.stringify(ir));
    // The compiler writes the IR's sha256 into the image's META section.
    writeFileSync(path.join(laws, "MI.tlaw"), Buffer.concat([Buffer.from("TLAW\0"), Buffer.from(irSha)]));
    listing = [
      "; tend law image MI, Michigan",
      "; format 1.1, compiled by tendc 1.1.0",
      `; source sha256 ${lawSha}`,
      `; image sha256  ${"c".repeat(64)}`,
      "; 3 rules, 1 sources, 1 proofs, 0 ints, 9 strings",
      "",
      ".rules",
      "    R0    MI-EXAM-1    exam_no_bill  -      X 1",
      "    R1    MI-COV-1     covered       medical X 2",
      "    R2    MI-CAP-2     skipped       -       X 3",
      "",
    ].join("\n");
    tdis = path.join(tmp, "tdis");
    writeFileSync(tdis, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(listing)});\n`);
    chmodSync(tdis, 0o755);

    server = createServer((req, res) => {
      if (req.url === "/api/jurisdictions/MI/asm") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ listing: listing.replace("tendc 1.1.0", "tendc 9.9.9"), engine_version: "tend 9.9.9" }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    api = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(() => {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // Async, so the fake API in this process can answer while the script runs.
  function run(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", ["scripts/build-asm.mjs", "--data", data, "--only", "MI", ...args], { cwd: web });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
    });
  }
  const index = () =>
    JSON.parse(readFileSync(path.join(data, "asm", "index.json"), "utf8")).states as Record<string, AsmEntry>;

  it("runs tdis on the law image and records where the listing came from", async () => {
    expect(await run("--tdis", tdis, "--laws", laws)).toMatch(/1 listings from tdis/);
    expect(readFileSync(path.join(data, "asm", "MI.txt"), "utf8")).toBe(listing);
    const mi = index().MI;
    expect(mi).toMatchObject({
      via: "tdis",
      image_dir: "outside the repository",
      ir_fresh: true,
      rules_fresh: true,
      kind_changes: [],
      compiler: "tendc 1.1.0",
      lines: 10,
    });
  });

  it("leaves the tree unchanged on a rerun", async () => {
    const before = readFileSync(path.join(data, "asm", "index.json"), "utf8");
    await run("--tdis", tdis, "--laws", laws);
    expect(readFileSync(path.join(data, "asm", "index.json"), "utf8")).toBe(before);
  });

  it("notices when the IR or the rules moved on since the image was built", async () => {
    const ir = JSON.parse(readFileSync(path.join(data, "ir", "MI.json"), "utf8")) as IrSummary;
    writeFileSync(
      path.join(data, "ir", "MI.json"),
      JSON.stringify({ ...ir, ir_sha256: "d".repeat(64), rules: [...ir.rules, { id: "MI-NEW-1", kind: "info" }] }),
    );
    await run("--tdis", tdis, "--laws", laws);
    expect(index().MI).toMatchObject({ ir_fresh: false, kind_changes: ["MI-NEW-1"] });
    writeFileSync(path.join(data, "ir", "MI.json"), JSON.stringify(ir));
  });

  it("falls back to the API when tdis is absent", async () => {
    expect(await run("--tdis", path.join(tmp, "missing"), "--api", api)).toMatch(/1 from the API/);
    expect(readFileSync(path.join(data, "asm", "MI.txt"), "utf8")).toContain("tendc 9.9.9");
    expect(index().MI).toMatchObject({ via: "api", engine: "tend 9.9.9", compiler: "tendc 9.9.9", ir_fresh: null });
  });

  it("keeps the listing it has when neither tdis nor the API answers", async () => {
    const out = await run("--tdis", path.join(tmp, "missing"), "--api", "http://127.0.0.1:9");
    expect(out).toMatch(/0 from the API, 1 kept/);
    expect(readFileSync(path.join(data, "asm", "MI.txt"), "utf8")).toContain("tendc 9.9.9");
    expect(index().MI.via).toBe("api");
  });
});
