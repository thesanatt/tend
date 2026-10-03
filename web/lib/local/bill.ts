// Reads a bill on the device. A PDF with text goes through the same line parser the server uses
// (billtext.ts); a photo, or a PDF that is only a picture, goes to Gemini Nano's image input when
// it is ready. The model only transcribes: every amount on each line, left to right, and the
// totals row. Code then reads them the way the text parser does (what the patient owes is the last
// column). Either way the bill is "ok" only when its lines add up to its own total and to the
// amount due; otherwise it is "unreliable" and the survivor sees the original instead.
import type { Source } from "../contracts";
import type { ItemExpense } from "../types";
import { parseAmount, parseDate } from "./amounts";
import { balanceChecks, BillReadError, matchExpense, parseTextBill, type TextBill } from "./billtext";
import { baseSession, deviceAiStatus, promptJson } from "./deviceai";
import { sha256Hex } from "./hash";
import { isPdf, linesToText, openPdf, pdfLines } from "./pdf";
import type { LocalBillLine, LocalBillReader, LocalBillReading } from "./types";

export const IMAGE_TIMEOUT_MS = 60_000;

export const BILL_SYSTEM_PROMPT = `You copy itemized medical bills into JSON. Copy words and amounts exactly as printed.
Never add, round, or compute amounts. If a value is not printed, leave it empty.`;

const BILL_INSTRUCTIONS = `Read this bill. For every charge line, copy its date, its description, and every dollar
amount printed on that line, from left to right, exactly as printed. Do the same for the totals row. Also copy the
provider's name, the statement date, and the amount due.`;

const AMOUNTS = { type: "array", items: { type: "string" } };

export const BILL_SCHEMA = {
  type: "object",
  properties: {
    provider: { type: "string" },
    statement_date: { type: "string" },
    amount_due: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { date: { type: "string" }, description: { type: "string" }, amounts: AMOUNTS },
        required: ["description", "amounts"],
        additionalProperties: false,
      },
    },
    totals: AMOUNTS,
  },
  required: ["lines", "totals", "amount_due"],
  additionalProperties: false,
};

export interface ImageAnswer {
  provider?: string;
  statement_date?: string;
  amount_due?: string;
  lines?: { date?: string; description?: string; amounts?: string[] }[];
  totals?: string[];
}

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i;

function isImage(file: Blob & { name?: string }, bytes: Uint8Array): boolean {
  if (file.type && IMAGE_TYPES.test(file.type)) return true;
  if (/\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(file.name ?? "")) return true;
  const b = bytes;
  return (
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // PNG
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) // JPEG
  );
}

const lineId = (sha: string, n: number) => `bill:${sha.slice(0, 16)}:${n}`;

function reading(
  bill: TextBill,
  sha: string,
  format: LocalBillReading["format"],
  source: Source,
  warnings: string[],
): LocalBillReading {
  const lines: LocalBillLine[] = bill.lines.map((l) => ({
    line_id: lineId(sha, l.line_no),
    description: l.description,
    amount_cents: l.amount_cents,
    expense: matchExpense(l.description).expense as ItemExpense,
    date: l.date || null,
    columns_cents: l.columns_cents,
  }));
  const checks = lines.length ? balanceChecks(bill) : [{ name: "has_lines", ok: false }];
  const sumsMatch = lines.length > 0 && checks.every((c) => c.ok);
  const dates = bill.lines
    .map((l) => l.date)
    .filter(Boolean)
    .sort();
  if (!sumsMatch && lines.length)
    warnings.push("The lines on this bill do not add up to its total, so Tend will not use its numbers.");
  return {
    status: sumsMatch ? "ok" : "unreliable",
    provider: bill.provider,
    total_cents: bill.total_cents ?? bill.amount_due_cents,
    lines,
    sums_match: sumsMatch,
    source,
    format,
    sha256: sha,
    statement_date: bill.statement_date ? (parseDate(bill.statement_date) ?? bill.statement_date) : null,
    service_date: dates[0] ?? null,
    amount_due_cents: bill.amount_due_cents,
    adjustments: bill.adjustments,
    lines_sum_cents: lines.reduce((s, l) => s + l.amount_cents, 0),
    fictional: bill.fictional,
    checks,
    warnings,
  };
}

function emptyBill(): TextBill {
  return {
    lines: [],
    provider: null,
    statement_date: null,
    bill_id: null,
    account_ref: null,
    fictional: false,
    total_cents: null,
    amount_due_cents: null,
    adjustments: [],
  };
}

function unreadable(
  sha: string,
  format: LocalBillReading["format"],
  source: Source,
  warning: string,
): LocalBillReading {
  return reading(emptyBill(), sha, format, source, [warning]);
}

function fromText(text: string, sha: string, format: LocalBillReading["format"]): LocalBillReading {
  try {
    const bill = parseTextBill(text);
    if (!bill.lines.length) return reading(bill, sha, format, "rule", ["No itemized lines were found on this bill."]);
    return reading(bill, sha, format, "rule", []);
  } catch (err) {
    if (err instanceof BillReadError) return unreadable(sha, format, "rule", "A line on this bill could not be read.");
    throw err;
  }
}

// Money the model copied as text becomes integer cents here, or the line is dropped.
function centsFromModel(text: unknown): number | null {
  const a = parseAmount(typeof text === "string" ? text : "");
  return a ? (a.negative ? -a.cents : a.cents) : null;
}

// What the model transcribed, read the way billtext.ts reads a text line: the last amount on a
// line is what the patient owes, and the last amount on the totals row is the bill's total.
export function billFromAnswer(answer: ImageAnswer): { bill: TextBill; dropped: number } {
  const bill = emptyBill();
  bill.provider = answer.provider?.trim() || null;
  bill.statement_date = answer.statement_date?.trim() || null;
  const totals = (Array.isArray(answer.totals) ? answer.totals : []).map(centsFromModel);
  bill.total_cents = totals.length && totals.every((c) => c !== null) ? totals[totals.length - 1] : null;
  bill.amount_due_cents = centsFromModel(answer.amount_due);
  let dropped = 0;
  for (const l of Array.isArray(answer.lines) ? answer.lines : []) {
    const columns = (Array.isArray(l.amounts) ? l.amounts : []).map(centsFromModel);
    const description = (l.description ?? "").replace(/\s+/g, " ").trim();
    if (!columns.length || columns.some((c) => c === null) || !description) {
      dropped++;
      continue;
    }
    const owed = columns[columns.length - 1]!;
    if (owed < 0) {
      bill.adjustments.push({ label: description, amount_cents: -owed });
      continue;
    }
    bill.lines.push({
      line_no: bill.lines.length + 1,
      date: parseDate(l.date ?? "") ?? "",
      description,
      amount_cents: owed,
      columns_cents: columns as number[],
    });
  }
  return { bill, dropped };
}

async function fromImage(
  image: Blob,
  sha: string,
  format: LocalBillReading["format"],
  signal?: AbortSignal,
): Promise<LocalBillReading> {
  const status = await deviceAiStatus("image");
  if (status !== "available")
    return unreadable(
      sha,
      format,
      "rule",
      "Reading a photo needs the on-device model, which is not ready in this browser.",
    );
  let answer: ImageAnswer;
  try {
    const base = await baseSession(BILL_SYSTEM_PROMPT, "image");
    answer = (await promptJson(
      base,
      [
        {
          role: "user",
          content: [
            { type: "text", value: BILL_INSTRUCTIONS },
            { type: "image", value: image },
          ],
        },
      ],
      BILL_SCHEMA,
      IMAGE_TIMEOUT_MS,
      signal,
    )) as ImageAnswer;
  } catch {
    return unreadable(sha, format, "device_ai", "The on-device model could not read this bill.");
  }
  const { bill, dropped } = billFromAnswer(answer);
  const warnings = dropped ? [`${dropped} line${dropped === 1 ? "" : "s"} on the photo could not be read.`] : [];
  const out = reading(bill, sha, format, "device_ai", warnings);
  if (dropped) {
    out.status = "unreliable";
    out.sums_match = false;
  }
  return out;
}

// A scanned PDF has no text layer: draw its first page and read that picture instead.
async function renderFirstPage(bytes: Uint8Array): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    await doc.loadingTask.destroy();
  }
}

export async function readBill(
  file: Blob & { name?: string },
  opts: { signal?: AbortSignal } = {},
): Promise<LocalBillReading> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(bytes);
  if (isPdf(bytes)) {
    let text: string;
    try {
      text = linesToText((await pdfLines(bytes)).lines);
    } catch {
      return unreadable(sha, "pdf", "rule", "This PDF could not be opened.");
    }
    if (text.trim()) return fromText(text, sha, "pdf");
    const page = await renderFirstPage(bytes).catch(() => null);
    if (!page)
      return unreadable(
        sha,
        "pdf",
        "rule",
        "This PDF is a picture with no text, and it could not be read on this device.",
      );
    return fromImage(page, sha, "pdf", opts.signal);
  }
  if (isImage(file, bytes)) return fromImage(file, sha, "image", opts.signal);
  return fromText(new TextDecoder().decode(bytes), sha, "text");
}

export const billReader: LocalBillReader = {
  read: (file, opts) => readBill(file, opts),
};
