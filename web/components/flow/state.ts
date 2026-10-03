// The survivor flow's state: plain data, one reducer, no React. It holds answers and costs, never a
// name or a story. FlowProvider keeps it in memory and, once the survivor saves, in the encrypted vault.
import type { BillReading, ClassifiedItem } from "@/lib/contracts";
import type { Lang } from "@/lib/i18n/format";
import type { AccountRef } from "@/lib/types";

export type YesNoUnsure = "yes" | "no" | "unsure";
export type PoliceAnswer = "yes" | "no" | "not_yet" | "unsure";

export interface CheckAnswers {
  st: string; // "" until chosen
  date: string; // ISO day, "" until given
  dateUnsure: boolean;
  exam: YesNoUnsure | null;
  police: PoliceAnswer | null;
}

export type ItemOrigin = "statement" | "bank" | "bill";

export interface FlowItem extends ClassifiedItem {
  origin: ItemOrigin;
  merchant?: string;
  // Lines of one bill share bill_id; a bank bill carries the bank's bill id.
  bill_id?: string;
  line_no?: number;
}

export interface SourceRecord {
  id: string;
  kind: "statement" | "bank";
  label: string;
  read: number; // transactions read
  found: number; // costs proposed
  warnings: string[];
  sample: boolean;
}

export interface BillRecord {
  id: string;
  label: string;
  reading: BillReading;
  // A bank bill this itemized bill explains; its lines stand in for it.
  replaces: string | null;
  choice: "pay" | "claim" | null;
  sample: boolean;
}

export interface LineLife {
  doc?: string; // name of the document the survivor attached; the file itself stays with them
  filed_at?: string;
  paid_at?: string;
}

export interface PaymentRecord {
  action_id: string;
  bill_id: string;
  item_ids: string[];
  amount_cents: number;
  payee: string;
  from: string;
  status: string; // "done" when the bank took it
  message?: string;
  nessie_id?: string | null;
  read_back_matches?: boolean | null;
  demo: boolean;
  at: string;
}

export interface ShareRecord {
  id: string;
  url: string;
  expires_at: string;
  once: boolean;
  revoked: boolean;
}

// What left the device, and only because the survivor acted (docs/PRIVACY.md).
export type SentKind = "payment" | "share" | "bank" | "server_engine";
export interface SentEvent {
  kind: SentKind;
  at: string;
  amount_cents?: number;
  to?: string;
}

export interface FlowState {
  v: 2;
  lang: Lang;
  check: CheckAnswers;
  sources: SourceRecord[];
  items: FlowItem[];
  bills: BillRecord[];
  answers: Record<string, YesNoUnsure>;
  life: Record<string, LineLife>;
  payments: PaymentRecord[];
  shares: ShareRecord[];
  have: Record<string, boolean>;
  sent: SentEvent[];
  serverConsent: boolean;
  account: AccountRef | null;
  filed_at: string | null;
}

export const EMPTY_CHECK: CheckAnswers = { st: "", date: "", dateUnsure: false, exam: null, police: null };

export function initialState(lang: Lang = "en"): FlowState {
  return {
    v: 2,
    lang,
    check: { ...EMPTY_CHECK },
    sources: [],
    items: [],
    bills: [],
    answers: {},
    life: {},
    payments: [],
    shares: [],
    have: {},
    sent: [],
    serverConsent: false,
    account: null,
    filed_at: null,
  };
}

export type Action =
  | { type: "check"; patch: Partial<CheckAnswers> }
  | { type: "addSource"; source: SourceRecord; items: FlowItem[]; account?: AccountRef | null }
  | { type: "addBill"; bill: BillRecord; items: FlowItem[] }
  | { type: "answer"; ids: string[]; value: YesNoUnsure | null }
  | { type: "billChoice"; billId: string; choice: BillRecord["choice"] }
  | { type: "life"; ids: string[]; patch: Partial<LineLife> | null }
  | { type: "payment"; record: PaymentRecord }
  | { type: "share"; record: ShareRecord }
  | { type: "revokeShare"; id: string }
  | { type: "have"; key: string; value: boolean }
  | { type: "sent"; event: SentEvent }
  | { type: "serverConsent" }
  | { type: "filed"; at: string | null }
  | { type: "lang"; lang: Lang }
  | { type: "restore"; state: FlowState }
  | { type: "reset"; lang: Lang };

// New items never replace ones already gathered: the first reading of a cost wins.
function mergeItems(existing: FlowItem[], incoming: FlowItem[]): FlowItem[] {
  const seen = new Set(existing.map((i) => i.item_id));
  const out = [...existing];
  for (const it of incoming) {
    if (seen.has(it.item_id)) continue;
    seen.add(it.item_id);
    out.push(it);
  }
  return out;
}

// An itemized bill explains a bank bill when the totals match exactly and the bank bill is not
// already explained.
export function findReplaced(state: FlowState, reading: BillReading): string | null {
  if (reading.status !== "ok" || reading.total_cents === null) return null;
  const taken = new Set(state.bills.map((b) => b.replaces).filter(Boolean));
  const match = state.items.find(
    (it) => it.is_bill && it.origin !== "bill" && it.amount_cents === reading.total_cents && !taken.has(it.item_id),
  );
  return match?.item_id ?? null;
}

export function reducer(state: FlowState, action: Action): FlowState {
  switch (action.type) {
    case "check": {
      const check = { ...state.check, ...action.patch };
      if (action.patch.dateUnsure) check.date = "";
      if (action.patch.date) check.dateUnsure = false;
      return { ...state, check };
    }
    case "addSource":
      return {
        ...state,
        sources: [...state.sources.filter((s) => s.id !== action.source.id), action.source],
        items: mergeItems(state.items, action.items),
        account: action.account ?? state.account,
      };
    case "addBill": {
      if (state.bills.some((b) => b.id === action.bill.id)) return state;
      const replaces = action.bill.replaces ?? findReplaced(state, action.bill.reading);
      return {
        ...state,
        bills: [...state.bills, { ...action.bill, replaces }],
        items: mergeItems(state.items, action.items),
      };
    }
    case "answer": {
      const answers = { ...state.answers };
      for (const id of action.ids) {
        if (action.value) answers[id] = action.value;
        else delete answers[id];
      }
      return { ...state, answers };
    }
    case "billChoice":
      return {
        ...state,
        bills: state.bills.map((b) => (b.id === action.billId ? { ...b, choice: action.choice } : b)),
      };
    case "life": {
      const life = { ...state.life };
      for (const id of action.ids) {
        if (action.patch === null) delete life[id];
        else {
          const next = { ...life[id], ...action.patch };
          for (const k of Object.keys(next) as (keyof LineLife)[]) if (next[k] === undefined) delete next[k];
          if (Object.keys(next).length) life[id] = next;
          else delete life[id];
        }
      }
      return { ...state, life };
    }
    case "payment":
      return { ...state, payments: [...state.payments, action.record] };
    case "share":
      return { ...state, shares: [...state.shares, action.record] };
    case "revokeShare":
      return { ...state, shares: state.shares.map((s) => (s.id === action.id ? { ...s, revoked: true } : s)) };
    case "have":
      return { ...state, have: { ...state.have, [action.key]: action.value } };
    case "sent":
      return { ...state, sent: [...state.sent, action.event] };
    case "serverConsent":
      return { ...state, serverConsent: true };
    case "filed":
      return { ...state, filed_at: action.at };
    case "lang":
      return { ...state, lang: action.lang };
    case "restore":
      return action.state;
    case "reset":
      return initialState(action.lang);
  }
}

// Saved states are data from disk: accept only the shape this version writes.
export function isFlowState(value: unknown): value is FlowState {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<FlowState>;
  return (
    s.v === 2 &&
    (s.lang === "en" || s.lang === "es") &&
    typeof s.check === "object" &&
    s.check !== null &&
    Array.isArray(s.items) &&
    Array.isArray(s.bills) &&
    Array.isArray(s.sources) &&
    Array.isArray(s.payments) &&
    Array.isArray(s.shares) &&
    Array.isArray(s.sent) &&
    typeof s.answers === "object" &&
    typeof s.life === "object"
  );
}

export function hasProgress(state: FlowState): boolean {
  return Boolean(state.check.st || state.items.length || state.bills.length);
}
