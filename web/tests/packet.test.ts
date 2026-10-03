// lib/packet: the cited summary for any of the 51 jurisdictions, Michigan's application filled from
// an allowlist only, the still-needed checklist, filing routes, and the letters.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { evaluatePreview } from "@/lib/engine/preview";
import {
  allowlist,
  createPacketBuilder,
  docScope,
  filledFields,
  fillForm,
  formValues,
  FormGuardError,
  guard,
  LawBook,
  MI_FORM,
  NEVER_FILL,
  stillNeeded,
  TOTAL_LINE,
  type BuiltPacket,
} from "@/lib/packet";
import type { EngineInput, EngineOutput, Expense, Jurisdiction } from "@/lib/types";
import { blankForm, hasVerified, rowanInput, rowanOutput, verifiedLaw, webDir, webLaw } from "./trust-helpers";

const bytesOf = async (b: Blob | null) => (b ? new Uint8Array(await b.arrayBuffer()) : null);
const sha = (b: Uint8Array | null) => (b ? createHash("sha256").update(b).digest("hex") : null);

const builderFor = (law: (st: string) => Jurisdiction) =>
  createPacketBuilder({ loadLaw: async (st) => law(st), loadForm: blankForm });

async function uriLinks(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const a = annots!.lookup(i, PDFDict);
      const uri = a.lookupMaybe(PDFName.of("A"), PDFDict)?.lookup(PDFName.of("URI"));
      if (uri instanceof PDFString || uri instanceof PDFHexString) out.push(uri.decodeText());
    }
  }
  return out;
}

async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: pdf.slice(), disableFontFace: true, useSystemFonts: false }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("") + "\n";
  }
  return text.replace(/\s+/g, " ");
}

describe("Rowan's Michigan packet", () => {
  const law = hasVerified ? verifiedLaw : webLaw;
  let built: BuiltPacket;
  const build = async () => (built ??= await builderFor(law).build("MI", rowanInput(), rowanOutput()));

  it("cites every line: amount, transaction, pinpoint, verbatim quote, and link", async () => {
    const p = await build();
    const pdf = (await bytesOf(p.summaryPdf))!;
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const text = p.transcript.join("\n");
    const book = new LawBook(law("MI"));
    const links = await uriLinks(pdf);
    for (const line of rowanOutput().lines) {
      expect(text).toContain(line.item_id);
      for (const id of line.rule_ids) {
        const rule = book.rule(id)!;
        expect(text).toContain(rule.pinpoint);
        expect(text).toContain(`"${rule.quote.trim()}"`);
        expect(links).toContain(book.link(rule));
      }
    }
    expect(text).toContain(TOTAL_LINE);
    expect(text).toContain("$1,394.00");
    expect(text).toContain("Held. Do not pay this.");
  });

  it("puts that text in the PDF itself, not just the transcript", async () => {
    const p = await build();
    const text = await pdfText((await bytesOf(p.summaryPdf))!);
    expect(text).toContain("Amount you can ask for. The program decides.");
    expect(text).toContain("A health care provider shall not submit a bill for any portion of the costs");
    expect(text).toContain("rcpt:9c41e2a7:3");
    expect(text).toContain("MCL 18.355a(2)");
  });

  it("lists what is still needed, where to file, and the privacy protections", async () => {
    const p = await build();
    const text = p.transcript.join("\n");
    const ids = p.stillNeeded.map((i) => i.rule_id);
    // Counseling, lost pay, and a lock change are claimed; funeral and loss-of-support papers are not.
    expect(ids).toEqual(expect.arrayContaining(["MI-DOC-5", "MI-DOC-10", "MI-DOC-11", "MI-DOC-21"]));
    expect(ids).not.toContain("MI-DOC-26"); // funeral bills
    expect(ids).not.toContain("MI-DOC-28"); // loss of support
    expect(ids).not.toContain("MI-DOC-3"); // filing late (it is on time)
    expect(ids).not.toContain("MI-DOC-4"); // only with a lawyer
    expect(ids).not.toContain("MI-DOC-1"); // the exam stands in for a police report
    for (const item of p.stillNeeded) {
      expect(law("MI").rules.find((r) => r.id === item.rule_id)?.category).toBe("required_document");
      expect(text).toContain(item.document);
    }
    expect(p.filing.map((f) => f.method)).toEqual(["email", "mail", "fax"]);
    expect(text).toContain("MDHHS-MichiganCrimeVictim@Michigan.gov");
    if (hasVerified) {
      expect(text).toContain("Address Confidentiality Program (ACP)");
      expect(text).toContain(
        `"${verifiedLaw("MI")
          .rules.find((r) => r.id === "MI-RECCONF-1")!
          .quote.trim()}"`,
      );
    }
  });

  it("fills only allowlisted fields of the Michigan application", async () => {
    const p = await build();
    const form = (await bytesOf(p.formPdf))!;
    const filled = await filledFields(form);
    const allowed = allowlist(MI_FORM);
    expect(filled).toEqual(p.formFilled);
    expect(filled.length).toBeGreaterThan(0);
    for (const name of filled) expect(allowed.has(name)).toBe(true);
    expect(filled).toEqual(["Medical Expenses", "SECTION 6  Compensation Benefits"]);
    const doc = await PDFDocument.load(form);
    expect(doc.getForm().getTextField("SECTION 6  Compensation Benefits").getText()).toBe(
      "Itemized list attached: 2 costs, $1,394.00",
    );
    // Signature, SSN, crime details, offender, and location stay blank.
    for (const name of MI_FORM.never) expect(filled).not.toContain(name);
  });

  it("writes the letters this claim needs, with the law quoted and placeholder names", async () => {
    const p = await build();
    expect(p.letters.map((l) => l.kind)).toEqual(["billing_hold", "employer_wages", "provider_statement"]);
    const hold = p.letters[0];
    const exam = law("MI").rules.find((r) => r.id === "MI-EXAM-1")!;
    expect(hold.body).toContain(`"${exam.quote}" (${exam.pinpoint})`);
    expect(hold.body).toContain("$325.00");
    expect(hold.rule_ids[0]).toBe("MI-EXAM-1");
    for (const l of p.letters) {
      expect(l.body).toContain("[Your name]");
      expect(l.body).not.toMatch(/Rowan/i);
      for (const id of l.rule_ids)
        expect(l.body).toContain(
          law("MI")
            .rules.find((r) => r.id === id)!
            .quote.trim(),
        );
    }
    const all = await builderFor(law).build("MI", rowanInput(), rowanOutput(), { allLetters: true });
    expect(all.letters.map((l) => l.kind)).toEqual([
      "billing_hold",
      "employer_wages",
      "provider_statement",
      "itemized_bill_request",
    ]);
  });

  it("is deterministic: the same claim gives the same bytes", async () => {
    const a = await build();
    const b = await builderFor(law).build("MI", structuredClone(rowanInput()), structuredClone(rowanOutput()));
    expect(sha(await bytesOf(b.summaryPdf))).toBe(sha(await bytesOf(a.summaryPdf)));
    expect(sha(await bytesOf(b.formPdf))).toBe(sha(await bytesOf(a.formPdf)));
    expect(b.letters).toEqual(a.letters);
    const builder = builderFor(law);
    const l1 = await bytesOf(await builder.letterPdf(a.letters[0]));
    const l2 = await bytesOf(await builder.letterPdf(b.letters[0]));
    expect(sha(l1)).toBe(sha(l2));
    // A different claim gives a different summary.
    const other = rowanOutput();
    other.totals.allowed_cents = 100;
    const c = await builderFor(law).build("MI", rowanInput(), other);
    expect(sha(await bytesOf(c.summaryPdf))).not.toBe(sha(await bytesOf(a.summaryPdf)));
  });
});

describe("the Michigan form allowlist", () => {
  it("names only real, safe fields of the right kind", async () => {
    const doc = await PDFDocument.load(await blankForm(MI_FORM));
    const form = doc.getForm();
    expect(form.getFields()).toHaveLength(202);
    for (const name of allowlist(MI_FORM)) {
      expect(NEVER_FILL.test(name), name).toBe(false);
      expect(MI_FORM.never).not.toContain(name);
      const field = form.getField(name);
      expect(field instanceof PDFCheckBox || field instanceof PDFTextField).toBe(true);
    }
    for (const name of MI_FORM.never) expect(() => form.getField(name)).not.toThrow();
    expect(await filledFields(await blankForm(MI_FORM))).toEqual([]);
  });

  it("stays inside the allowlist even when every kind of cost is counted", async () => {
    const out = rowanOutput();
    const expenses: Expense[] = [
      "medical",
      "dental",
      "counseling",
      "lost_wages",
      "relocation",
      "temporary_housing",
      "security",
      "transportation",
      "crime_scene_cleanup",
      "clothing_bedding",
      "property_replacement",
      "funeral",
      "prescription",
      "childcare",
      "legal",
      "tuition",
      "other",
      "forensic_exam",
    ];
    out.lines = expenses.map((expense, i) => ({
      item_id: `x${i}`,
      expense,
      status: "eligible",
      requested_cents: 100,
      allowed_cents: 100,
      rule_ids: [],
      cap_rule_id: null,
      flags: [],
    }));
    out.totals.allowed_cents = 100 * expenses.length;
    const { filled } = await fillForm(MI_FORM, await blankForm(MI_FORM), out);
    const allowed = allowlist(MI_FORM);
    expect(filled.every((f) => allowed.has(f))).toBe(true);
    expect(filled.length).toBe(allowed.size);
  });

  it("refuses anything outside it, and a changed blank form", async () => {
    expect(() => guard(MI_FORM, ["Medical Expenses", "3 Social Security Number"])).toThrow(FormGuardError);
    expect(() => guard(MI_FORM, ["Claimant Signature"])).toThrow(FormGuardError);
    expect(() => guard(MI_FORM, ["31 Location of Crime"])).toThrow(FormGuardError);
    expect(() => guard(MI_FORM, ["36 Name of Offenders if known"])).toThrow(FormGuardError);
    expect(() =>
      guard({ ...MI_FORM, summaryField: "33 Briefly describe the crime and injuries that resulted from this crime" }, [
        "33 Briefly describe the crime and injuries that resulted from this crime",
      ]),
    ).toThrow(FormGuardError);
    // Counted lines only: waiting and held lines check nothing.
    const out = rowanOutput();
    out.lines = out.lines.filter((l) => l.status !== "eligible");
    expect([...formValues(MI_FORM, out).keys()]).toEqual([]);
    const blank = await blankForm(MI_FORM);
    const changed = blank.slice();
    changed[changed.length - 10] ^= 1;
    await expect(fillForm(MI_FORM, changed, rowanOutput())).rejects.toThrow(/not the version Tend checked/);
  });
});

describe("still needed: which required documents fit the claim", () => {
  const book = new LawBook(webLaw("MI"));
  const input = rowanInput();
  const output = rowanOutput();
  const ids = (inp: EngineInput, out: EngineOutput) => stillNeeded(book, inp, out).map((i) => i.rule_id);

  it("scopes by the kinds of cost, the deadline, and the police report answer", () => {
    expect(docScope(book.rule("MI-DOC-28")!)).toEqual({ kind: "skip", why: "for a claim after a death" });
    expect(docScope(book.rule("MI-DOC-3")!).kind).toBe("late");
    expect(docScope(book.rule("MI-DOC-13")!)).toEqual({ kind: "expenses", expenses: ["lost_wages"] });
    expect(docScope(book.rule("MI-DOC-2")!).kind).toBe("always"); // SSN goes on the form; not home security

    const late = structuredClone(output);
    late.checks.deadline.status = "late";
    expect(ids(input, late)).toContain("MI-DOC-3");

    const reported: EngineInput = { ...input, context: { ...input.context, police_report: "yes" } };
    expect(ids(reported, output)).toContain("MI-DOC-1");

    const noWages = structuredClone(output);
    noWages.lines = noWages.lines.filter((l) => l.expense !== "lost_wages");
    expect(ids(input, noWages)).not.toContain("MI-DOC-11");
  });

  it("marks itemized bills as on hand only when every cost they cover came from a read bill", () => {
    const out = structuredClone(output);
    out.lines = out.lines.filter((l) => l.expense === "medical");
    const items = stillNeeded(book, input, out, { photo_id: true });
    expect(items.find((i) => i.rule_id === "MI-DOC-5")?.have_it).toBe(true);
    expect(stillNeeded(book, input, output).find((i) => i.rule_id === "MI-DOC-5")?.have_it).toBe(false);
  });
});

describe("a packet for each of the 51 jurisdictions", () => {
  const states = readdirSync(path.join(webDir, "public", "data", "law"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();

  it("covers 51", () => expect(states).toHaveLength(51));

  it.each(states)("%s", async (st) => {
    const law = webLaw(st);
    const raw = JSON.stringify(law);
    const input: EngineInput = { ...rowanInput(), jurisdiction: st };
    const output = evaluatePreview(input, law, createHash("sha256").update(raw).digest("hex"));
    const p = await builderFor(webLaw).build(st, input, output);
    const pdf = (await bytesOf(p.summaryPdf))!;
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
    const text = p.transcript.join("\n");
    expect(text).toContain(TOTAL_LINE);
    for (const line of output.lines) expect(text).toContain(line.item_id);
    const book = new LawBook(law);
    for (const id of new Set(output.lines.flatMap((l) => l.rule_ids))) {
      expect(text).toContain(`"${book.rule(id)!.quote.trim()}"`);
    }
    expect(p.filing.length).toBeGreaterThan(0);
    for (const f of p.filing) expect(book.rule(f.rule_id)?.category).toBe("submission");
    expect(p.formPdf === null).toBe(st !== "MI");
    // Held exam lines get a billing letter quoting that state's exam_no_bill rule (or, where a
    // state has none, the rule naming who pays for the exam).
    if (output.lines.some((l) => l.status === "held")) {
      const hold = p.letters.find((l) => l.kind === "billing_hold")!;
      const first = book.rule(hold.rule_ids[0])!;
      expect(first.category).toBe(book.byCategory("exam_no_bill").length ? "exam_no_bill" : "exam_payment");
      expect(hold.body).toContain(first.quote.trim());
    }
  });
});

describe("text the standard PDF fonts cannot draw", () => {
  it("is folded instead of failing", async () => {
    const input = rowanInput();
    input.items[1] = { ...input.items[1], description: "Clínica São Paulo \u{1F49A} 病院 ≥ x" };
    const p = await builderFor(webLaw).build("MI", input, rowanOutput());
    expect(p.transcript.join("\n")).toContain("Clínica São Paulo");
    expect(await bytesOf(p.summaryPdf)).not.toBeNull();
  });

  it("keeps the file valid when a link has a stray parenthesis or backslash", async () => {
    const law = webLaw("MI");
    const odd = "https://example.org/statute(1\\a).pdf#:~:text=a)b";
    law.rules = law.rules.map((r) => (r.id === "MI-EXAM-1" ? { ...r, fragment_url: odd } : r));
    const p = await builderFor(() => law).build("MI", rowanInput(), rowanOutput());
    const pdf = (await bytesOf(p.summaryPdf))!;
    expect(await uriLinks(pdf)).toContain(odd);
    expect(await pdfText(pdf)).toContain("Amount you can ask for. The program decides.");
  });

  it("refuses a claim checked under another state's law", async () => {
    await expect(builderFor(webLaw).build("NY", rowanInput(), rowanOutput())).rejects.toThrow(/Michigan|MI law/);
  });
});
