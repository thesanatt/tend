// Client for the Tend API (docs/SPEC.md, prefix /api). next.config.ts proxies /api/* to TEND_API_URL.
// One probe decides the mode: "live" talks to the API and surfaces its errors; "fixtures" serves
// web/fixtures and never pretends that money moved.
import { addDays, todayIso } from "./dates";
import { assertCents } from "./money";
import type {
  ActionProposal,
  ActionResult,
  BillAudit,
  EngineInput,
  EngineOutput,
  Jurisdiction,
  JurisdictionSummary,
  ScanResult,
  ShareLink,
  ShareView,
} from "./types";

export type DataMode = "live" | "fixtures";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("json")) {
    let detail = `${res.status} ${res.statusText}`;
    if (type.includes("json")) {
      const body = await res.json().catch(() => null);
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

let modePromise: Promise<DataMode> | null = null;

export function dataMode(): Promise<DataMode> {
  // next.config.ts sets this to "0" when no TEND_API_URL is configured, so there is nothing to probe.
  if (process.env.NEXT_PUBLIC_TEND_API === "0") return Promise.resolve("fixtures");
  modePromise ??= request<unknown>("/api/jurisdictions", {}, 2500)
    .then((body) => (normalizeSummaries(body).length ? ("live" as const) : ("fixtures" as const)))
    .catch(() => "fixtures" as const);
  return modePromise;
}

export function resetDataModeForTests() {
  modePromise = null;
}

// The API may name counts differently; accept the obvious spellings.
export function normalizeSummaries(body: unknown): JurisdictionSummary[] {
  const list = Array.isArray(body) ? body : (body as { jurisdictions?: unknown[] })?.jurisdictions;
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const st = String(r.st ?? r.jurisdiction ?? r.code ?? "").toUpperCase();
      const num = (...keys: string[]) => {
        for (const k of keys) if (typeof r[k] === "number") return r[k] as number;
        return 0;
      };
      return {
        st,
        name: String(r.name ?? st),
        rules: num("rules", "rule_count", "n_rules"),
        sources: num("sources", "source_count", "n_sources"),
        program: (r.program_name ?? r.program ?? null) as string | null,
        confidence: (r.confidence ?? null) as string | null,
        verified_at: (r.verified_at ?? null) as string | null,
      };
    })
    .filter((s) => /^[A-Z]{2}$/.test(s.st));
}

export async function fetchJurisdictions(): Promise<JurisdictionSummary[]> {
  if ((await dataMode()) === "live") {
    const live = normalizeSummaries(await request<unknown>("/api/jurisdictions").catch(() => null));
    if (live.length) return live;
  }
  return request<JurisdictionSummary[]>("/data/jurisdictions.json");
}

const laws = new Map<string, Promise<{ law: Jurisdiction; sha256: string } | null>>();

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The verified corpus copy served from public/data/law (see scripts/sync-rules.mjs).
export function fetchLaw(st: string): Promise<{ law: Jurisdiction; sha256: string } | null> {
  const key = st.toUpperCase();
  let pending = laws.get(key);
  if (!pending) {
    pending = fetch(`/data/law/${key}.json`)
      .then(async (res) => {
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        return { law: JSON.parse(new TextDecoder().decode(bytes)) as Jurisdiction, sha256: await sha256Hex(bytes) };
      })
      .catch(() => null);
    laws.set(key, pending);
  }
  return pending;
}

export async function fetchAsmFromApi(st: string): Promise<string | null> {
  if ((await dataMode()) !== "live") return null;
  const res = await fetch(`/api/jurisdictions/${st}/asm`).catch(() => null);
  if (!res?.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    const body = await res.json();
    return typeof body === "string" ? body : (body.asm ?? body.listing ?? null);
  }
  return type.includes("html") ? null : res.text();
}

export async function fetchAsmFixture(st: string): Promise<string | null> {
  if (st.toUpperCase() !== "MI") return null;
  const fixture = (await import("@/fixtures/MI.asm.json")).default as { listing: string[] };
  return fixture.listing.join("\n");
}

export interface ScanRequest {
  persona_id: string;
  st: string;
  incident_date: string;
}

export async function scan(req: ScanRequest): Promise<ScanResult> {
  if ((await dataMode()) === "live") return post<ScanResult>("/api/scan", req);
  const fixture = (await import("@/fixtures/rowan-mi.scan.json")).default as ScanResult;
  return { ...structuredClone(fixture), st: req.st, incident_date: req.incident_date, as_of_date: todayIso() };
}

export async function auditBill(billId: string, personaId: string): Promise<BillAudit> {
  if ((await dataMode()) === "live")
    return post<BillAudit>("/api/bill/audit", { bill_id: billId, persona_id: personaId });
  return structuredClone((await import("@/fixtures/riverbend-bill.json")).default as BillAudit);
}

export async function claimFromApi(input: EngineInput): Promise<{ output: EngineOutput; engine: string } | null> {
  if ((await dataMode()) !== "live") return null;
  const res = await fetch("/api/claim", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new ApiError(`claim failed: ${res.status}`, res.status);
  const engine = res.headers.get("x-tend-engine") ?? res.headers.get("x-engine") ?? "native";
  return { output: (await res.json()) as EngineOutput, engine };
}

export interface PayRequest {
  bill_id: string;
  item_ids: string[];
  amount_cents: number;
  from_account_id: string;
  payee: string;
}

// Demo proposals stay in memory only; their codes never leave this tab.
const demoProposals = new Map<string, ActionProposal>();

function demoCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

export async function proposePayment(req: PayRequest, fromLabel: string): Promise<ActionProposal & { demo: boolean }> {
  assertCents(req.amount_cents);
  if ((await dataMode()) === "live") {
    const p = await post<ActionProposal>("/api/actions/propose", { kind: "pay_bill", ...req });
    return { ...p, demo: false };
  }
  const proposal: ActionProposal = {
    action_id: `demo-${crypto.randomUUID()}`,
    amount_cents: req.amount_cents,
    from: fromLabel,
    payee: req.payee,
    confirm_code: demoCode(),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  demoProposals.set(proposal.action_id, proposal);
  return { ...proposal, demo: true };
}

export async function confirmPayment(actionId: string, code: string): Promise<ActionResult> {
  if (!actionId.startsWith("demo-")) {
    return post<ActionResult>("/api/actions/confirm", { action_id: actionId, confirm_code: code });
  }
  const p = demoProposals.get(actionId);
  if (!p) throw new ApiError("This confirmation was already used or has expired.", 410);
  if (Date.parse(p.expires_at) < Date.now()) {
    demoProposals.delete(actionId);
    throw new ApiError("This code has expired. Start again to get a new one.", 410);
  }
  if (p.confirm_code !== code) throw new ApiError("That code does not match. Check the six digits and try again.", 400);
  demoProposals.delete(actionId);
  return {
    action_id: actionId,
    status: "not_sent",
    amount_cents: p.amount_cents,
    message: "Demo mode: Tend is not connected to the bank, so no money moved.",
    at: new Date().toISOString(),
  };
}

export async function createShare(input: EngineInput, output: EngineOutput): Promise<ShareLink & { demo: boolean }> {
  if ((await dataMode()) === "live") {
    const s = await post<Partial<ShareLink> & { token: string; expires_at: string }>("/api/share", { input, output });
    return { token: s.token, url: s.url ?? `/share/${s.token}`, expires_at: s.expires_at, demo: false };
  }
  return { token: "demo", url: "/share/demo", expires_at: `${addDays(todayIso(), 7)}T23:59:00Z`, demo: true };
}

export async function fetchShare(token: string): Promise<ShareView | null> {
  if ((await dataMode()) === "live") {
    try {
      return await request<ShareView>(`/api/share/${encodeURIComponent(token)}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  }
  if (token !== "demo") return null;
  return structuredClone((await import("@/fixtures/share-demo.json")).default as unknown as ShareView);
}

export function packetUrl(claimId: string | undefined, mode: DataMode): string | null {
  return mode === "live" && claimId ? `/api/packet/${encodeURIComponent(claimId)}.pdf` : null;
}
