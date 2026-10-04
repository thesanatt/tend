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
  already?: number; // costs another record already had, so they count once
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
  // The server recorded it without sending it to the bank (TEND_BANK=dry_run).
  dry_run?: boolean;
  at: string;
}

export interface ShareRecord {
  id: string;
  url: string;
  expires_at: string;
  once: boolean;
  revoked: boolean;
}

// What left the device, and only because the survivor acted (docs/PRIVACY.md). lib/netlog sees every
// request the page makes, so this list also holds sends no screen announced ("other").
// "payment_setup": asking the bank service for a confirm code sends the amount, account, and payee,
// even if the survivor then stops.
export type SentKind =
  | "payment"
  | "payment_setup"
  | "share"
  | "bank"
  | "server_engine"
  | "cloud_rows"
  | "cloud_bill"
  | "other";
export interface SentEvent {
  kind: SentKind;
  at: string;
  amount_cents?: number;
  to?: string;
  action_id?: string;
  // The same send reported twice (by a screen and by lib/netlog) is kept once.
  ref?: string;
  // A payment the server recorded without sending it to the bank.
  dry_run?: boolean;
  // Where an unexpected request went.
  path?: string;
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
  // A second reading of a record, after the survivor agreed to cloud AI: rows still unsorted take
  // the new label, and costs the new labels add (a ride to newly sorted care) join.
  | { type: "resort"; items: FlowItem[] }
  // A bill read again (with cloud AI) replaces its earlier, unreliable reading.
  | { type: "rereadBill"; bill: BillRecord; items: FlowItem[] }
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

// Which record a cost was read from: "stmt:<file hash>", "nessie", or "bill:<file hash>".
export function recordOf(item: FlowItem): string {
  if (item.origin === "bank") return "nessie";
  return item.item_id.split(":").slice(0, 2).join(":");
}

const merchantKey = (m: string | undefined) => (m ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Words a bank adds to a description that say nothing about who was paid.
const NOISE = new Set([
  "pos",
  "debit",
  "credit",
  "card",
  "purchase",
  "payment",
  "ach",
  "web",
  "ppd",
  "ccd",
  "online",
  "recurring",
  "checkcard",
  "visa",
  "the",
  "and",
  "for",
  "from",
]);

// The words of a cost's description, as a CSV, an OFX, a PDF, or the bank writes it: lowercase
// letters only, bracket tags and short or noise words dropped.
export function descriptionWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !NOISE.has(w));
  return new Set(words);
}

// Two readings of one bank transaction: the same day and amount, from different records, with
// descriptions that share a word (the same payee written two ways, such as "Wayfare Rides - trip" in
// a CSV and "WAYFARE RIDES TRIP ANN ARBOR" in an OFX). When one side has no words to compare, the
// kind of cost decides. Merchants, when both name one, must agree.
export function sameCost(a: FlowItem, b: FlowItem): boolean {
  if (a.date !== b.date || a.amount_cents !== b.amount_cents || recordOf(a) === recordOf(b)) return false;
  if (a.merchant && b.merchant && merchantKey(a.merchant) !== merchantKey(b.merchant)) return false;
  const wa = descriptionWords(a.description);
  const wb = descriptionWords(b.description);
  if (!wa.size || !wb.size) return a.expense === b.expense;
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

// The same account can arrive twice: a statement and the demo bank, or a CSV and an OFX of the same
// month. A cost another record already holds (sameCost: day, amount, and description) is left out,
// even when the two formats sorted it differently: the first reading wins. Each gathered cost can
// stand for one new one only, so two real charges on one day still count twice, and costs inside
// one record are never folded together.
export function newCosts(existing: FlowItem[], incoming: FlowItem[]): { fresh: FlowItem[]; already: number } {
  const key = (i: FlowItem) => `${i.date}|${i.amount_cents}`;
  const open = new Map<string, FlowItem[]>();
  for (const it of existing) {
    if (it.origin === "bill") continue;
    open.set(key(it), [...(open.get(key(it)) ?? []), it]);
  }
  const ids = new Set(existing.map((i) => i.item_id));
  const fresh: FlowItem[] = [];
  let already = 0;
  for (const it of incoming) {
    if (ids.has(it.item_id)) continue;
    const pool = open.get(key(it)) ?? [];
    const at = it.origin === "bill" ? -1 : pool.findIndex((e) => sameCost(e, it));
    if (at >= 0) {
      pool.splice(at, 1);
      already += 1;
      continue;
    }
    fresh.push(it);
  }
  return { fresh, already };
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
    case "resort": {
      const byId = new Map(action.items.map((i) => [i.item_id, i]));
      const items = state.items.map((it) => {
        const next = byId.get(it.item_id);
        return next && it.expense === "unknown" && next.expense !== "unknown" ? next : it;
      });
      return { ...state, items: mergeItems(items, action.items) };
    }
    case "rereadBill": {
      if (!state.bills.some((b) => b.id === action.bill.id)) return state;
      const replaces = action.bill.replaces ?? findReplaced(state, action.bill.reading);
      return {
        ...state,
        bills: state.bills.map((b) => (b.id === action.bill.id ? { ...action.bill, replaces } : b)),
        items: mergeItems(
          state.items.filter((i) => !(i.origin === "bill" && i.bill_id === action.bill.id)),
          action.items,
        ),
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
    case "sent": {
      // One send seen twice (the screen that made it, and lib/netlog) stays one event; the second
      // report only fills in what the first did not know.
      const ref = action.event.ref;
      const at = ref ? state.sent.findIndex((e) => e.ref === ref) : -1;
      if (at < 0) return { ...state, sent: [...state.sent, action.event] };
      const first = state.sent[at];
      const merged = { ...first };
      for (const [k, v] of Object.entries(action.event) as [keyof SentEvent, unknown][]) {
        if (merged[k] === undefined && v !== undefined) (merged as Record<string, unknown>)[k] = v;
      }
      return { ...state, sent: state.sent.map((e, i) => (i === at ? merged : e)) };
    }
    case "serverConsent":
      return { ...state, serverConsent: true };
    case "filed":
      return { ...state, filed_at: action.at };
    case "lang":
      return { ...state, lang: action.lang };
    case "restore":
      // Saved data from an earlier build may lack newer fields; start those empty.
      return { ...initialState(action.state.lang), ...action.state };
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
