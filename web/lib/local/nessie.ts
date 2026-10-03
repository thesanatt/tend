// Capital One's Nessie (a mock bank) through the API relay: GET /api/bank/{persona}/transactions.
// The relay holds the key and stores nothing. It may answer with a seed snapshot
// (tend-bank-snapshot/1), a list of rows, or raw Nessie records; all become statement rows here.
// Nessie stores whole dollars; snapshots carry amount_cents. Money out is positive.
import { parseAmount, parseDate } from "./amounts";
import type { LocalTxn, NessieResult, TxnKind } from "./types";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function idOf(o: Obj): string {
  return str(o.id) || str(o._id) || str(o.item_id).replace(/^nessie:/, "");
}

// amount_cents when present; otherwise Nessie's dollars, read as text so no float rounding happens.
function centsOf(o: Obj, dollarsKey: string): number | null {
  const c = o.amount_cents ?? o.payment_amount_cents;
  if (typeof c === "number") return Number.isSafeInteger(c) ? c : null;
  const d = o[dollarsKey] ?? o.amount;
  if (typeof d !== "number" && typeof d !== "string") return null;
  const parsed = parseAmount(String(d));
  return parsed ? (parsed.negative ? -parsed.cents : parsed.cents) : null;
}

function kindOf(o: Obj): TxnKind | null {
  const k = str(o.kind).toLowerCase();
  if (k === "purchase" || k === "withdrawal" || k === "deposit" || k === "transfer" || k === "bill") return k;
  const type = str(o.type).toLowerCase();
  if (type === "merchant") return "purchase";
  if (type === "withdrawal" || type === "deposit") return type;
  if (type === "p2p" || type === "transfer") return "transfer";
  if ("payee" in o && ("payment_date" in o || "nickname" in o)) return "bill";
  if (o.merchant_id) return "purchase";
  return null;
}

interface Doc {
  bill_id: string;
  service_date: string | null;
}

export function fromNessieRelay(body: unknown): NessieResult {
  const warnings: string[] = [];
  const root: Obj = isObj(body) ? body : { transactions: Array.isArray(body) ? body : [] };
  const meta = isObj(root.meta) ? root.meta : {};
  const pickList = (...keys: string[]) => {
    for (const k of keys) if (Array.isArray(root[k])) return root[k] as unknown[];
    return [];
  };
  const rows = pickList("transactions", "rows", "items", "txns");
  const bills = pickList("bills");
  const merchants = new Map<string, Obj>();
  for (const m of pickList("merchants")) if (isObj(m)) merchants.set(idOf(m), m);

  const docList = (Array.isArray(meta.documents) ? meta.documents : Array.isArray(root.documents) ? root.documents : []) as unknown[];
  const docs = new Map<string, Doc>();
  for (const d of docList) {
    if (!isObj(d) || !str(d.bill_id)) continue;
    if (d.kind && d.kind !== "itemized_bill") continue;
    docs.set(str(d.bill_id), { bill_id: str(d.bill_id), service_date: parseDate(str(d.service_date)) });
  }

  // Accounts that belong to this person, so a transfer into one of them counts as money in.
  const own = new Set<string>();
  for (const a of pickList("accounts")) if (isObj(a)) own.add(idOf(a));
  const viewing = str(root.account_id);

  const txns: LocalTxn[] = [];
  const seen = new Set<string>();
  let cancelled = 0;
  const all = [...rows.map((r) => ({ r, bill: false })), ...bills.map((r) => ({ r, bill: true }))];
  all.forEach(({ r, bill }, i) => {
    const line = i + 1;
    if (!isObj(r)) {
      warnings.push(`Record ${line} skipped: not a bank record.`);
      return;
    }
    const id = idOf(r);
    const kind = bill ? "bill" : kindOf(r);
    if (!id || !kind) {
      warnings.push(`Record ${line} skipped: Tend could not tell what kind of record it is.`);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`Record ${line} skipped: the same record appears twice.`);
      return;
    }
    if (str(r.status).toLowerCase() === "cancelled") {
      cancelled++;
      return;
    }
    const doc = kind === "bill" ? docs.get(id) : undefined;
    const rawDate =
      kind === "bill"
        ? (doc?.service_date ?? (str(r.date) || str(r.creation_date) || str(r.payment_date) || str(r.upcoming_payment_date)))
        : str(r.date) || str(r.purchase_date) || str(r.transaction_date) || str(r.creation_date);
    const date = parseDate(rawDate);
    if (!date) {
      warnings.push(`Record ${line} skipped: no date Tend could read.`);
      return;
    }
    const cents = centsOf(r, kind === "bill" ? "payment_amount" : "amount");
    if (cents === null) {
      warnings.push(`Record ${line} skipped: the amount could not be read.`);
      return;
    }
    const merchantRef = r.merchant;
    const merchant = isObj(merchantRef) ? merchantRef : merchants.get(str(r.merchant_id));
    const merchantName = kind === "bill" ? str(r.payee) : str(merchant?.name) || str(r.merchant_name) || (typeof merchantRef === "string" ? merchantRef : "");
    const category = kind === "bill" ? "" : str(merchant?.category) || str(r.merchant_category);
    // Deposits, and transfers into this person's other account when listed from it, are money in.
    const payee = str(r.payee_account_id);
    const into = kind === "transfer" && viewing !== "" && payee === viewing && own.has(payee);
    const magnitude = Math.abs(cents);
    seen.add(id);
    txns.push({
      id: `nessie:${id}`,
      date,
      amount_cents: kind === "deposit" || into ? -magnitude : magnitude,
      description: kind === "bill" ? str(r.nickname) || str(r.description) : str(r.description),
      ...(merchantName ? { merchant: merchantName } : {}),
      origin: "nessie",
      kind,
      ...(category ? { category } : {}),
      ...(str(r.status) ? { status: str(r.status) } : {}),
      ...(doc ? { itemized: { service_date: doc.service_date } } : {}),
      line,
    });
  });
  if (cancelled) warnings.push(`${cancelled} cancelled record${cancelled === 1 ? " was" : "s were"} left out.`);
  const fictional = meta.fictional === true || root.fictional === true;
  const label = str(meta.notice) || str(root.label) || str(root.notice) || null;
  return {
    txns,
    warnings,
    format: "nessie",
    layout: str(root.format) || "nessie",
    fictional,
    label,
    source: str(root.source) || null,
  };
}

export interface NessieFetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// The demo bank connection. The relay keeps the API key; this browser never sees it.
export async function fetchNessie(persona: string, opts: NessieFetchOptions = {}): Promise<NessieResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await (opts.fetch ?? fetch)(`/api/bank/${encodeURIComponent(persona)}/transactions`, {
    headers: { accept: "application/json" },
    signal,
  });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("json")) throw new Error(`The bank relay answered ${res.status}.`);
  return fromNessieRelay(await res.json());
}
