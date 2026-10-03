// Cloud Gemini, only after the survivor says yes on a consent screen (docs/PRIVACY.md, item 3).
// Classification sends, for rows the rules and the device could not sort, only kind, merchant,
// category, and description under short refs: never amounts, dates, account numbers, or record
// ids. A bill goes as the file itself, because reading it is the point.
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
        merchant: r.merchant || null,
        category: r.category || null,
        description: r.description.slice(0, 200),
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
  sums_match: boolean;
  source: string;
  sha256: string | null;
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
  const lines = Array.isArray(body.lines) ? (body.lines as CloudBill["lines"]) : [];
  return {
    status: String(body.status ?? "unreliable"),
    provider: typeof body.provider === "string" ? body.provider : null,
    total_cents: typeof body.total_cents === "number" ? body.total_cents : null,
    lines,
    adjustments: Array.isArray(body.adjustments) ? (body.adjustments as CloudBill["adjustments"]) : [],
    sums_match: body.sums_match === true,
    source: String(body.source ?? "cloud_ai"),
    sha256: typeof body.sha256 === "string" ? body.sha256 : null,
  };
}
