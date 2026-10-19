// The one-page fact sheet in public/press. scripts/press-factsheet.ts prints it from app/press/facts.ts, the
// module /press renders, so the PDF and the page say the same thing. Building it again here must give the
// same bytes: when a fact or a count changes, the PDF in the repo has to be printed again.
import { readFileSync } from "node:fs";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { absolute, buildFactSheet } from "@/app/press/factsheet";
import { CONTACT, pressFacts, VIDEO, WHY } from "@/app/press/facts";
import { FACT_SHEET, pressFile } from "@/app/press/files";

const committed = () => readFileSync(pressFile(FACT_SHEET));

// Every link on the page, as the address a PDF reader opens.
function links(doc: PDFDocument): string[] {
  const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  return annots.asArray().map((ref) => {
    const action = doc.context.lookup(ref, PDFDict).lookup(PDFName.of("A"), PDFDict);
    return action.lookup(PDFName.of("URI"), PDFHexString).decodeText();
  });
}

describe("the fact sheet PDF", () => {
  it("is in public/press, one letter page, and says whose it is", async () => {
    const doc = await PDFDocument.load(committed(), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getTitle()).toBe("Tend fact sheet");
    expect(doc.getAuthor()).toBe("Sanat Gupta");
  });

  it("is exactly what scripts/press-factsheet.ts prints from today's facts", async () => {
    const { bytes } = await buildFactSheet();
    // A failure here means a fact or a count changed: run `npx tsx scripts/press-factsheet.ts` in web/.
    expect(Buffer.from(bytes).equals(committed())).toBe(true);
  });

  it("prints the paragraph, the builder's line, every fact, and every real and demo row", async () => {
    const kit = pressFacts();
    const text = (await buildFactSheet(kit)).transcript.join("\n");
    expect(text).toContain(kit.about);
    expect(text).toContain(kit.builder);
    for (const fact of kit.facts) expect(text, fact.id).toContain(fact.text);
    for (const row of kit.real) expect(text, row.label).toContain(row.text);
    expect(text).toContain("Tend is not legal advice.");
    expect(text).toContain("The program decides.");
  });

  it("links every source, the builder's line, and the press page, as full addresses", async () => {
    const kit = pressFacts();
    const doc = await PDFDocument.load(committed(), { updateMetadata: false });
    const uris = links(doc);
    const expected = [
      ...kit.facts.flatMap((f) => f.sources.map((s) => s.href)),
      kit.builderSource.href,
      "/press",
      "/",
      "/check?demo=rowan",
      "https://github.com/thesanatt/tend",
    ].map(absolute);
    for (const href of expected) expect(uris, href).toContain(href);
    expect(uris.every((u) => /^(https:\/\/|mailto:)/.test(u))).toBe(true);
  });

  it("leaves out Sanat's words until he writes them, and says the contact is not chosen", async () => {
    expect(WHY).toBeNull();
    expect(CONTACT).toBeNull();
    expect(VIDEO).toBeNull();
    const text = (await buildFactSheet()).transcript.join("\n");
    expect(text).not.toContain("In Sanat Gupta's words");
    expect(text).toContain("Contact: not chosen yet.");
  });

  it("keeps room for three sentences from Sanat, a contact address, and a video link", async () => {
    // About as long as three plain sentences in print.
    const sentence =
      "This sentence stands in for one that Sanat writes himself and runs about as long as a plain sentence in a newspaper.";
    const kit = {
      ...pressFacts(),
      why: [sentence, sentence, sentence].join(" "),
      contact: "reporters.contact.address@umich.edu",
      video: "https://youtu.be/AAAAAAAAAAA",
    };
    const { bytes, room } = await buildFactSheet(kit);
    expect(room).toBeGreaterThanOrEqual(0);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
