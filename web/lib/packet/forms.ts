// The state's own application, filled on the device from an ALLOWLIST of safe fields. A field is
// filled only if it is on the allowlist and its name passes the never-fill guard; the saved file
// is then read back and checked again, so nothing outside the allowlist can land in it.
// Signature, Social Security number, crime details, offender, and location fields stay blank.
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
} from "pdf-lib";
import { formatCents } from "../money";
import type { EngineOutput, Expense } from "../types";

export interface FormSpec {
  st: string;
  // Served from public/forms; a copy of api/forms/<ST>/application.pdf.
  path: string;
  title: string;
  // sha256 of the blank form. A different file is not filled.
  sha256: string;
  // Expense to the checkbox that requests it. Several expenses can share one box.
  checkboxes: Partial<Record<Expense, string>>;
  // A free-text line where Tend notes that an itemized list is attached.
  summaryField: string | null;
  // Fields named here are never filled, whatever else changes.
  never: string[];
  // What the survivor fills in, in plain words.
  onlyYou: string[];
}

// Michigan DCH-0560 (Rev. 1-26), 202 fields. Names copied from the PDF.
export const MI_FORM: FormSpec = {
  st: "MI",
  path: "/forms/MI.pdf",
  title: "Michigan Crime Victim Compensation application (DCH-0560)",
  sha256: "6fa0accc275a0eaeb6f29f7999d5b2153593041aba103e18a9ce587691ca191b",
  checkboxes: {
    medical: "Medical Expenses",
    prescription: "Medical Expenses",
    dental: "Dental Expenses",
    counseling: "Psychological Counseling",
    lost_wages: "Loss of Earnings",
    temporary_housing: "Relocation Temporary",
    relocation: "Relocation Permanent",
    security: "Residential Security",
    transportation: "Transportation",
    crime_scene_cleanup: "Crime Scene Cleanup",
    clothing_bedding: "Replacement Costs",
    property_replacement: "Replacement Costs",
    funeral: "Funeral and Burial Expenses",
  },
  summaryField: "SECTION 6  Compensation Benefits",
  never: [
    "1 Name of Victim",
    "2 Date of Birth",
    "3 Social Security Number",
    "4 Address",
    "10 Name of Claimant",
    "11 Date of Birth",
    "12 Social Security Number",
    "13 Address",
    "Claimant Signature",
    "Date of Signature",
    "Claimants Signature",
    "Date of Signature_2",
    "expire one year from the signature date below if you leave this section blank",
    "27 Date of Crime",
    "28 Date Crime was Reported",
    "29 Law enforcement agency to which crime was reported",
    "30 County in which Crime Occurred",
    "31 Location of Crime",
    "32 Incident Number",
    "33 Briefly describe the crime and injuries that resulted from this crime",
    "34 If the crime was NOT reported to law enforcement explain why",
    "35 If you are NOT filing this claim within five years of the date of crime explain delay waivers may apply",
    "36 Name of Offenders if known",
    "38 Name of Court and Case Number",
    "the victim an individual with whom the victim had a child in common or a resident or former resident",
    "Sexual Assault",
    "Assault",
    "Child Sexual Assault",
    "Human Trafficking",
    "Stalking",
  ],
  onlyYou: [
    "Your name, date of birth, and how to reach you (Sections 1 and 2)",
    "Your Social Security number (questions 3 and 12)",
    "What happened, when, and where (Section 4, questions 25 to 35)",
    "Anything about the person who did it, and any court case (Section 5, questions 36 to 42)",
    "Your signatures and the dates you sign (page 4)",
  ],
};

export const FORM_SPECS: Record<string, FormSpec> = { MI: MI_FORM };

// Field names that may never be filled on any state's form.
export const NEVER_FILL =
  /signature|social security|\bssn\b|date of birth|offender|date of crime|crime was reported|describe the crime|location of crime|county in which|incident number|law enforcement|court|restitution|civil|settlement|attorney|name of victim|name of claimant|address|phone|email|gender|assault|stalking|trafficking/i;

export function allowlist(spec: FormSpec): Set<string> {
  const names = new Set<string>(Object.values(spec.checkboxes).filter((v): v is string => !!v));
  if (spec.summaryField) names.add(spec.summaryField);
  return names;
}

export class FormGuardError extends Error {
  constructor(readonly fields: string[]) {
    super(`Tend refused to fill fields outside its safe list: ${fields.join(", ")}`);
    this.name = "FormGuardError";
  }
}

export function guard(spec: FormSpec, names: Iterable<string>): void {
  const allowed = allowlist(spec);
  const never = new Set(spec.never);
  const bad = [...names].filter((n) => !allowed.has(n) || never.has(n) || NEVER_FILL.test(n));
  if (bad.length) throw new FormGuardError(bad.sort());
}

// What Tend would write: a check for each kind of cost that is counted, and one line noting the
// attached list. No names, dates of the crime, or anything about what happened.
export function formValues(spec: FormSpec, output: EngineOutput): Map<string, true | string> {
  const values = new Map<string, true | string>();
  const counted = output.lines.filter((l) => l.status === "eligible" && l.allowed_cents > 0);
  for (const l of counted) {
    const box = spec.checkboxes[l.expense as Expense];
    if (box) values.set(box, true);
  }
  if (spec.summaryField && counted.length) {
    const n = counted.length;
    values.set(
      spec.summaryField,
      `Itemized list attached: ${n} ${n === 1 ? "cost" : "costs"}, ${formatCents(output.totals.allowed_cents)}`,
    );
  }
  guard(spec, values.keys());
  return values;
}

function hasValue(field: PDFField): boolean {
  if (field instanceof PDFTextField) return !!field.getText();
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return field.getSelected() !== undefined;
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected().length > 0;
  // Signatures and buttons: anything stored as the field's value counts.
  const v = field.acroField.dict.get(PDFName.of("V"));
  return v !== undefined && v.toString() !== "/Off" && v.toString() !== "()";
}

// Every field that holds a value in a saved PDF.
export async function filledFields(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  return doc
    .getForm()
    .getFields()
    .filter(hasValue)
    .map((f) => f.getName())
    .sort();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class FormChangedError extends Error {
  constructor(st: string) {
    super(`The saved ${st} application is not the version Tend checked, so Tend did not fill it.`);
    this.name = "FormChangedError";
  }
}

export async function fillForm(
  spec: FormSpec,
  blank: Uint8Array,
  output: EngineOutput,
): Promise<{ bytes: Uint8Array; filled: string[] }> {
  if ((await sha256Hex(blank)) !== spec.sha256) throw new FormChangedError(spec.st);
  const values = formValues(spec, output);
  const doc = await PDFDocument.load(blank, { updateMetadata: false });
  const form = doc.getForm();
  for (const [name, value] of values) {
    if (value === true) form.getCheckBox(name).check();
    else form.getTextField(name).setText(value);
  }
  const bytes = await doc.save({ useObjectStreams: false });
  // Check what actually landed in the file, not just what was asked for.
  const filled = await filledFields(bytes);
  guard(spec, filled);
  return { bytes, filled };
}
