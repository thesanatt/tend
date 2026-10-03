// lib/packet: the claim packet, built on the device (lib/contracts.ts PacketBuilder).
//   summaryPdf  the cited summary (any of the 51 jurisdictions)
//   formPdf     the state's own application, safe fields only (Michigan for now)
//   letters     billing hold, employer wages, provider statement, itemized bill request
//   stillNeeded the state's required documents that fit this claim
//   filing      where and how to send it
// Nothing here reads the clock or random numbers: the same claim always gives the same bytes.
import type { Letter, Packet, PacketBuilder } from "../contracts";
import { isIsoDay } from "../dates";
import { assertCents } from "../money";
import type { EngineInput, EngineOutput } from "../types";
import { stillNeeded } from "./checklist";
import { filingRoutes } from "./filing";
import { FORM_SPECS, FormChangedError, fillForm, type FormSpec } from "./forms";
import { fetchLawLoader, LawBook, type LawLoader } from "./law";
import { buildLetters } from "./letters";
import { MARGIN, Pdf } from "./pdf";
import { renderSummary } from "./summary";

export { docScope, scopeApplies, stillNeeded } from "./checklist";
export { filingRoutes, privacyNotes, METHOD_LABEL } from "./filing";
export {
  allowlist,
  FORM_SPECS,
  filledFields,
  fillForm,
  formValues,
  FormChangedError,
  FormGuardError,
  guard,
  MI_FORM,
  NEVER_FILL,
  type FormSpec,
} from "./forms";
export { fetchLawLoader, LawBook, LawNotFoundError, type LawLoader } from "./law";
export { buildLetters, LETTER_KINDS } from "./letters";
export { isDemo, TOTAL_LINE } from "./summary";

export interface PacketDeps {
  loadLaw?: LawLoader;
  // The blank state form for a spec, or null when it cannot be had.
  loadForm?: (spec: FormSpec) => Promise<Uint8Array | null>;
}

export interface BuildOptions {
  // What the survivor already has, by rule id or document type (e.g. { photo_id: true }).
  have?: Record<string, boolean>;
  // Every letter kind the state's rules support, not only the ones this claim calls for.
  allLetters?: boolean;
}

export interface BuiltPacket extends Packet {
  // Paragraphs of the summary as written, for checking what it says.
  transcript: string[];
  // Fields that hold a value in formPdf, read back from the saved file.
  formFilled: string[];
  // Plain notes about anything left out, e.g. a state form that did not match.
  notes: string[];
}

export interface TendPacketBuilder extends PacketBuilder {
  build(st: string, input: EngineInput, output: EngineOutput, opts?: BuildOptions): Promise<BuiltPacket>;
  letterPdf(letter: Letter): Promise<Blob>;
}

export class PacketInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PacketInputError";
  }
}

function validate(st: string, input: EngineInput, output: EngineOutput): void {
  if (!/^[A-Z]{2}$/.test(st)) throw new PacketInputError(`Not a state code: ${st}`);
  if (input.jurisdiction?.toUpperCase() !== st || output.jurisdiction?.toUpperCase() !== st) {
    throw new PacketInputError(`This claim was checked under ${output.jurisdiction} law, not ${st}.`);
  }
  for (const d of [input.context.incident_date, input.context.as_of_date]) {
    if (!isIsoDay(d)) throw new PacketInputError(`Not a date: ${d}`);
  }
  const ids = new Set(input.items.map((i) => i.item_id));
  for (const i of input.items) assertCents(i.amount_cents, i.item_id);
  for (const l of output.lines) {
    assertCents(l.requested_cents, l.item_id);
    assertCents(l.allowed_cents, l.item_id);
    if (!ids.has(l.item_id)) throw new PacketInputError(`The line ${l.item_id} has no matching cost.`);
  }
  assertCents(output.totals.allowed_cents, "total");
}

const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });

async function fetchForm(spec: FormSpec): Promise<Uint8Array | null> {
  try {
    const res = await fetch(spec.path);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function renderLetter(letter: Letter): Promise<Uint8Array> {
  const pdf = await Pdf.create(letter.title);
  pdf.text(letter.title, { font: "serifBold", size: 15, leading: 19 });
  pdf.space(4);
  pdf.text("Fill in each [blank] before you send it. Keep a copy for yourself.", { size: 8.5, color: "ink3" });
  pdf.space(14);
  for (const para of letter.body.trimEnd().split("\n\n")) {
    for (const line of para.split("\n")) {
      const indent = /^ {2,}/.test(line) ? 18 : 0;
      const quoted = /^".*"\s\(.+\)$/.test(line.trim());
      pdf.runs(
        [{ text: line.trim() || " " }],
        { size: 10.5, leading: 14.5, font: quoted ? "italic" : "sans" },
        MARGIN + indent,
        504 - indent,
      );
    }
    pdf.space(8);
  }
  pdf.finish({ footer: "Written with Tend. Not legal advice." });
  return pdf.save();
}

export function createPacketBuilder(deps: PacketDeps = {}): TendPacketBuilder {
  const loadLaw = deps.loadLaw ?? fetchLawLoader();
  const loadForm = deps.loadForm ?? fetchForm;

  return {
    async build(st, input, output, opts: BuildOptions = {}) {
      const code = st.toUpperCase();
      validate(code, input, output);
      const law = new LawBook(await loadLaw(code));
      const needed = stillNeeded(law, input, output, opts.have);
      const filing = filingRoutes(law);
      const letters = buildLetters(law, input, output, { all: opts.allLetters });
      const notes: string[] = [];

      let formPdf: Blob | null = null;
      let formFilled: string[] = [];
      const spec = FORM_SPECS[code] ?? null;
      if (spec) {
        const blank = await loadForm(spec);
        if (!blank) notes.push(`The ${spec.title} could not be loaded, so it is not in this packet.`);
        else {
          try {
            const filled = await fillForm(spec, blank, output);
            formPdf = pdfBlob(filled.bytes);
            formFilled = filled.filled;
          } catch (e) {
            if (!(e instanceof FormChangedError)) throw e;
            notes.push(e.message);
          }
        }
      }

      const summary = await renderSummary({
        law,
        input,
        output,
        stillNeeded: needed,
        filing,
        letters,
        form: formPdf ? spec : null,
      });
      return {
        summaryPdf: pdfBlob(summary.bytes),
        formPdf,
        letters,
        stillNeeded: needed,
        filing,
        transcript: summary.transcript,
        formFilled,
        notes,
      };
    },

    async letterPdf(letter) {
      return pdfBlob(await renderLetter(letter));
    },
  };
}

// The app's builder: rules from /data/law (or the API), the blank form from /forms.
export const packetBuilder: TendPacketBuilder = createPacketBuilder();
