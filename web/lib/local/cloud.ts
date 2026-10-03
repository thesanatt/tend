// Cloud Gemini, only after the survivor says yes on a consent screen (docs/PRIVACY.md, item 3).
// Classification sends, for rows the rules and the device could not sort, only kind, merchant,
// category, and description under short refs: never amounts, dates, account numbers, or record
// ids, and scrubForCloud takes those out of the text too. A bill goes as the file itself,
// because reading it is the point.
import { isPdf } from "./pdf";

export interface ModelRow {
  ref: string;
  kind: string;
  merchant: string;
  category: string;
  description: string;
}

export interface ModelAnswer {
  ref: string;
  expense: string;
  reason: string;
}

export const CLOUD_CLASSIFY_PATH = "/api/ai/classify";
export const CLOUD_BILL_PATH = "/api/ai/bill";

interface CloudOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// What a bank description can carry beyond the merchant: card and reference numbers, dates,
// amounts, phone numbers, emails, the account holder's own name on an ACH line, and the person on
// the other end of a payment app. None of it helps pick a category, so it is removed before a row
// leaves the device.
const PAY_APP = String.raw`zelle|venmo|cash ?app|apple cash|paypal|p2p`;
const PERSON_APP = String.raw`zelle|venmo|cash ?app|apple cash`; // "PAYPAL *NAME" is usually a shop
const SCRUB: [RegExp, string][] = [
  // "Zelle payment to Jane Doe", "ZELLE FROM DOE JANE ON 06/14 REF # PP0ABC"
  [new RegExp(String.raw`\b(${PAY_APP})\b(.*?)\b(to|from)\s+.*$`, "i"), "$1$2$3 a person"],
  // "CASH APP*JANE DOE*OAKLAND CA", "Venmo *jdoe"
  [new RegExp(String.raw`\b(${PERSON_APP})\s*\*.*$`, "i"), "$1 payment"],
  // "Zelle Transfer Conf# T0ABC; Jane Doe"
  [new RegExp(String.raw`\b(${PERSON_APP})\b([^;]*);.*$`, "i"), "$1$2"],
  // ACH lines name the account holder: "IND NAME:JANE DOE", "INDN:JANE DOE CO ID:123"
  [/\b(?:indn|ind(?:ividual)?\s*(?:name|id))\s*:.*$/i, " "],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, " "],
  [/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, " "],
  [/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " "],
  [/\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d{2}\b/g, " "],
  // A labeled code: "Conf# T0ABC", "REF # PP0ABC", "WEB ID: 3264681992", "TRACE#:123"
  [/\b(?:conf(?:irmation)?|ref(?:erence)?|trace|trn|txn|id)\s*(?:#\s*:?|:|no\.?\s|number\s)\s*\S+/gi, " "],
  [/(?:\b[x*#]+|\b(?:card|acct|account|ref|conf|id|no)\s*[:#.]?\s*)[x*]*\d{2,}\w*/gi, " "],
  [/(?<![a-z])[x*#]+\d{2,}\w*/gi, " "],
  [/\b[\w-]*\d{4,}[\w-]*/g, " "],
];

// The API's limits for each field (AiTxn in api/tend_api/models.py). Python counts characters,
// so the cut is by code point; a longer field would get the whole batch refused.
export const CLOUD_LIMITS = { merchant: 120, category: 80, description: 200 } as const;

export function scrubForCloud(text: string, max: number = CLOUD_LIMITS.description): string {
  let t = text ?? "";
  for (const [pattern, to] of SCRUB) t = t.replace(pattern, to);
  return Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}

async function post(path: string, body: unknown, opts: CloudOptions): Promise<Record<string, unknown>> {
  const timer = AbortSignal.timeout(opts.timeoutMs ?? 20000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;
  const res = await (opts.fetch ?? fetch)(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`cloud ${path.split("/").pop()} answered ${res.status}`);
  const parsed = (await res.json()) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("cloud answer was not an object");
  return parsed as Record<string, unknown>;
}

// POST /api/ai/classify {consent, txns}. The server runs the same rules first, then its model; only
// the model's labels are taken here. An older {results: [{ref, expense, reason}]} answer also reads.
export async function cloudClassify(
  rows: ModelRow[],
  opts: CloudOptions,
): Promise<{ answers: ModelAnswer[]; model: string | null; note: string | null }> {
  const body = await post(
    CLOUD_CLASSIFY_PATH,
    {
      consent: true,
      txns: rows.map((r) => ({
        id: r.ref,
        kind: r.kind,
        merchant: scrubForCloud(r.merchant, CLOUD_LIMITS.merchant) || null,
        category: scrubForCloud(r.category, CLOUD_LIMITS.category) || null,
        description: scrubForCloud(r.description),
      })),
    },
    opts,
  );
  const answers: ModelAnswer[] = [];
  if (Array.isArray(body.labels)) {
    for (const l of body.labels as Record<string, unknown>[]) {
      if (l && l.method === "model" && typeof l.id === "string")
        answers.push({ ref: l.id, expense: String(l.expense), reason: String(l.reason ?? "") });
    }
  } else if (Array.isArray(body.results)) {
    for (const r of body.results as Record<string, unknown>[]) {
      if (r && typeof r.ref === "string")
        answers.push({ ref: r.ref, expense: String(r.expense), reason: String(r.reason ?? "") });
    }
  }
  const failed = body.model_ok === false;
  return {
    answers,
    model: typeof body.model === "string" ? body.model : null,
    note: failed ? (typeof body.note === "string" ? body.note : "cloud model did not answer") : null,
  };
}

export interface CloudBill {
  status: string;
  provider: string | null;
  total_cents: number | null;
  lines: { line_id: string; description: string; amount_cents: number; expense: string }[];
  adjustments: { label: string; amount_cents: number }[];
  dropped: number; // lines or adjustments that were not objects
  sums_match: boolean;
  source: string;
  sha256: string | null;
}

// What the cloud bill reader takes (AiBillRequest in api/tend_api/models.py): about 10 MB of file,
// as a PDF or a PNG, JPEG, WEBP, or HEIC picture.
export const CLOUD_BILL_MAX_BYTES = 10 * 1024 * 1024;

// The file's type from its first bytes, so a renamed or mislabeled file is sent as what it is.
// null: a type the cloud reader does not take.
export function cloudBillMime(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (isPdf(bytes)) return "application/pdf";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return "image/heic";
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// POST /api/ai/bill {consent, file, mime}: the server reads a text layer itself, and only a picture
// goes to its model.
export async function cloudReadBill(bytes: Uint8Array, mime: string, opts: CloudOptions): Promise<CloudBill> {
  const body = await post(CLOUD_BILL_PATH, { consent: true, file: base64(bytes), mime }, { timeoutMs: 45000, ...opts });
  // Untrusted shapes: anything that is not an object with the right field types is dropped
  // here, and bill.ts then refuses a bill whose lines do not all survive.
  const objects = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter(
      (x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x),
    );
  const rawLines: unknown[] = Array.isArray(body.lines) ? body.lines : [];
  const rawAdjustments: unknown[] = Array.isArray(body.adjustments) ? body.adjustments : [];
  const lines = objects(rawLines).map((l) => ({
    line_id: typeof l.line_id === "string" ? l.line_id : "",
    description: typeof l.description === "string" ? l.description : "",
    amount_cents: typeof l.amount_cents === "number" ? l.amount_cents : NaN,
    expense: typeof l.expense === "string" ? l.expense : "unknown",
  }));
  const adjustments = objects(rawAdjustments).map((a) => ({
    label: typeof a.label === "string" ? a.label : "",
    amount_cents: typeof a.amount_cents === "number" ? a.amount_cents : NaN,
  }));
  const dropped = rawLines.length - lines.length + rawAdjustments.length - adjustments.length;
  return {
    status: String(body.status ?? "unreliable"),
    provider: typeof body.provider === "string" ? body.provider : null,
    total_cents: typeof body.total_cents === "number" ? body.total_cents : null,
    lines,
    adjustments,
    dropped,
    sums_match: body.sums_match === true,
    source: String(body.source ?? "cloud_ai"),
    sha256: typeof body.sha256 === "string" ? body.sha256 : null,
  };
}
