// The demo bank behind Track: Capital One's Nessie mock bank, through the Tend API, for the fictional
// persona whose account the flow connected. Only that persona: nothing here ever runs on records a survivor
// uploaded. The server refuses anything that is not a fictional demo persona too (api/tend_api/payout.py,
// api/tend_api/nessie_activity.py).
import { ROWAN_ACCOUNT } from "@/components/flow/samples";
import type { FlowState, PaymentRecord } from "@/components/flow/state";
import { dataMode, type DataMode } from "@/lib/api";

// The demo accounts the flow can connect (components/flow/samples), by Nessie account id.
export const DEMO_PERSONAS: Readonly<Record<string, string>> = { [ROWAN_ACCOUNT.id]: "rowan-mi" };

// The persona behind the flow's bank connection, or null when the flow did not use the demo bank.
export function demoPersona(state: Pick<FlowState, "account" | "sources">): string | null {
  if (!state.account || !state.sources.some((s) => s.kind === "bank")) return null;
  return DEMO_PERSONAS[state.account.id] ?? null;
}

// Wi-Fi off: the cached data mode still says live, so the bank pieces ask the browser first.
export const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

// A demo payment is kept in the flow's payment list, so it saves and locks with everything else.
export const PAYOUT_PREFIX = "payout:";
export const PAYOUT_DONE = "demo_payout";
export const PAYOUT_UNDONE = "demo_payout_undone";

export function lastPayout(payments: PaymentRecord[]): PaymentRecord | null {
  const mine = payments.filter((p) => p.action_id.startsWith(PAYOUT_PREFIX));
  return mine.at(-1) ?? null;
}

export function activePayout(payments: PaymentRecord[]): PaymentRecord | null {
  const last = lastPayout(payments);
  return last?.status === PAYOUT_DONE ? last : null;
}

// The plants the demo payment bloomed (and so carry a demo note instead of a paid date).
export function demoPaid(state: Pick<FlowState, "payments">, itemId: string): boolean {
  return activePayout(state.payments)?.item_ids.includes(itemId) ?? false;
}

export interface PayoutResult {
  deposit_id: string;
  amount_cents: number;
  requested_cents: number;
  program: string;
  st: string;
  account: { id: string; nickname: string; mask: string | null };
  date: string | null;
  dry_run: boolean;
  read_back_matches: boolean;
  replayed: boolean;
  fictional: true;
  message: string;
}

export type TermKey = "deposits" | "purchases" | "withdrawals" | "transfers_out" | "transfers_in";
export type RecordKind = "purchase" | "deposit" | "withdrawal" | "transfer";

export interface ActivityRecord {
  id: string;
  kind: RecordKind;
  account: string | null;
  date: string;
  amount_cents: number;
  status: string;
  description: string | null;
  merchant: string | null;
  to: string | null;
  source: "seed" | "tend";
  changed: boolean;
  tend?: {
    what: "payment" | "demo_payout";
    payee?: string | null;
    action_id?: string;
    bill_id?: string | null;
    bill_lines?: number[];
    program?: string;
    st?: string;
  };
}

export interface ActivityAccount {
  id: string;
  type: string;
  nickname: string;
  mask: string | null;
  nessie_balance_cents: number;
  ledger: {
    opening_cents: number;
    terms: { key: TermKey; sign: 1 | -1; count: number; cents: number }[];
    not_counted: number;
    computed_cents: number;
    reconciled: boolean;
  };
  not_shown: number;
}

export interface ActivityBill {
  id: string;
  payee: string;
  account_id: string;
  status: string | null;
  amount_cents: number | null;
  nickname: string | null;
  nickname_changed: boolean;
  due_date: string | null;
  itemized_total_cents: number;
  payments: { withdrawal_id: string; date: string; amount_cents: number; action_id: string; lines: number[] }[];
  paid_cents: number;
  expected_cents: number;
  held: { cents: number; rule_ids: string[]; note: string | null } | null;
  in_bank: boolean;
  reconciled: boolean;
}

export interface Activity {
  persona_id: string;
  fictional: true;
  notice: string | null;
  source: "live" | "snapshot";
  source_error: string | null;
  read_at: string;
  bank_mode: string;
  customer: { id: string };
  accounts: ActivityAccount[];
  bills: ActivityBill[];
  tend_writes: ActivityRecord[];
  records: Record<RecordKind, ActivityRecord[]>;
  hidden_count: number;
  dry_run_writes: {
    id: string;
    kind: string;
    account_id: string;
    date: string | null;
    amount_cents: number | null;
    status: string | null;
  }[];
  calls: { method: string; path: string; status: number | null; ms: number; count: number | null }[];
}

export class BankApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json().catch(() => null)) as (T & { detail?: unknown }) | null;
  if (!res.ok || body === null) {
    const detail = body && typeof body.detail === "string" ? body.detail : `${res.status}`;
    throw new BankApiError(detail, res.status);
  }
  return body;
}

export interface BankApi {
  mode(): Promise<DataMode>;
  payout(persona: string, body: { st: string; amount_cents: number }): Promise<PayoutResult>;
  undoPayout(persona: string): Promise<{ deleted: string[] }>;
  activity(persona: string): Promise<Activity>;
}

const at = (persona: string, rest: string) => `/api/bank/${encodeURIComponent(persona)}/${rest}`;

export const bankApi: BankApi = {
  mode: dataMode,
  payout: (persona, body) => call<PayoutResult>(at(persona, "payout"), { method: "POST", body: JSON.stringify(body) }),
  undoPayout: (persona) => call<{ deleted: string[] }>(at(persona, "payout"), { method: "DELETE" }),
  async activity(persona) {
    const body = await call<Activity>(at(persona, "activity"));
    // Shown only when the server says every record is fictional demo data.
    if (body.fictional !== true) throw new BankApiError("not demo data", 403);
    return body;
  },
};
