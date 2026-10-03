// The state's own application, filled on the device from an ALLOWLIST of safe fields (specs.ts).
// A field is filled only if it is on the allowlist and its name passes the never-fill guard; the
// saved file is then read back and checked again, so nothing outside the allowlist can land in it.
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
import { guard, type FormSpec } from "./specs";

export { allowlist, FORM_SPECS, FormGuardError, guard, MI_FORM, NEVER_FILL, type FormSpec } from "./specs";

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
