// Cloud Gemini, only after the survivor says yes on a consent screen (docs/PRIVACY.md, item 3).
// What is sent: kind, merchant, category, and description for rows the rules and the device could
// not sort, under short refs. Never amounts, dates, account numbers, or record ids.
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

export const CLOUD_PATH = "/api/ai/classify";

export async function cloudClassify(
  rows: ModelRow[],
  opts: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; promptVersion: string },
): Promise<{ answers: ModelAnswer[]; model: string | null }> {
  const timer = AbortSignal.timeout(opts.timeoutMs ?? 20000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;
  const res = await (opts.fetch ?? fetch)(CLOUD_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ rows, prompt_version: opts.promptVersion }),
    signal,
  });
  if (!res.ok) throw new Error(`cloud classification answered ${res.status}`);
  const body = (await res.json()) as { results?: unknown; model?: unknown };
  const answers = (Array.isArray(body?.results) ? body.results : []).filter(
    (r): r is ModelAnswer => typeof r === "object" && r !== null && typeof (r as ModelAnswer).ref === "string",
  );
  return { answers, model: typeof body?.model === "string" ? body.model : null };
}
