// Statement rows to engine items, on the device. Order: the rules ported from the API (registry,
// keywords), then Gemini Nano on this device for what is left, then cloud Gemini only when the
// caller passes the survivor's consent. Then rides are linked to same-day care and lost pay is
// inferred from paychecks. Models only pick a label from a fixed list and never see amounts;
// eligibility, caps and totals belong to the law engine.
import type { Source, StatementTxn, Unit } from "../contracts";
import { daysBetween, isIsoDay } from "../dates";
import type { ItemExpense } from "../types";
import { CLOUD_LIMITS, cloudClassify, type ModelAnswer, type ModelRow } from "./cloud";
import { baseSession, deviceAiStatus, DeviceAiTimeout, forgetSessions, promptJson, type Turn } from "./deviceai";
import { inferPay } from "./paydip";
import {
  classifyDeterministic,
  norm,
  contentKey,
  displayDescription,
  fromModelAnswer,
  isTendPayment,
  ITEMIZED_REASON,
  linkCareRides,
  MODEL_LABELS,
  setAside,
  stripTags,
  TEND_PAYMENT_REASON,
  UNKNOWN,
  unresolved,
  type Anchor,
  type Classification,
  type FactKind,
  type TxnFacts,
} from "./rules";
import type {
  ClassifyContext,
  ClassifyOptions,
  ClassifyReport,
  LocalClassifiedItem,
  LocalClassifier,
  LocalTxn,
} from "./types";

export const DEVICE_BATCH = 6;
export const DEVICE_TIMEOUT_MS = 5000;
export const CLOUD_BATCH = 100; // the API takes up to 500 rows a request
export const DEVICE_MODEL = "gemini-nano";

// api/tend_api/classify.py SYSTEM_PROMPT, word for word, so device, cloud and server agree.
export const SYSTEM_PROMPT = `You sort bank transactions for a tool that helps crime survivors find costs their state's
victim compensation program may cover. For each transaction choose the one expense type it most likely is.
Choose "unknown" for ordinary spending (food, household basics, entertainment) and whenever you cannot tell.
Judge only from the merchant, its category, and the description. Do not mention amounts or numbers.
Give a plain reason under 20 words that says what the purchase is. Never say whether it is covered,
eligible, or reimbursable; the program's rules decide that, not you.

Expense types:
medical: hospital, clinic, doctor, ambulance, or lab charges
forensic_exam: a sexual assault medical forensic exam
counseling: therapy, counseling, or other mental health care
lost_wages: pay lost from missed work (never a purchase)
transportation: rides, transit, parking, or mileage
relocation: moving costs, or a deposit or first month's rent on a new home
temporary_housing: hotel or other short-term lodging
security: locks, door hardware, alarms, cameras, or lighting that makes a home safer
crime_scene_cleanup: cleaning a home or vehicle after a crime
childcare: child care or babysitting
property_replacement: replacing personal property such as a phone, laptop, or purse
clothing_bedding: replacement clothing, sheets, pillows, or other bedding
prescription: prescription medicine (over-the-counter items are not prescriptions)
dental: dentist or dental care
funeral: funeral or burial
legal: attorney or legal services
tuition: school tuition or fees
other: eyeglasses, hearing aids, or other prescribed devices
unknown: everyday spending, or not clear`;

// Worked examples for Gemini Nano, which over-reads ordinary purchases (cold medicine as a
// prescription, paint as home security). Chosen from the error kinds on one held-out set
// (tests/local/fixtures/device-eval.json) and checked on a second set written before them.
const EXAMPLE_ROWS: [ModelRow, string, string][] = [
  [
    { ref: "t1", kind: "purchase", merchant: "Oak Street Drug", category: "pharmacy", description: "cold medicine" },
    "unknown",
    "Over-the-counter medicine",
  ],
  [
    { ref: "t2", kind: "purchase", merchant: "Oak Street Drug", category: "pharmacy", description: "refill pickup" },
    "prescription",
    "Prescription refill",
  ],
  [
    { ref: "t3", kind: "purchase", merchant: "Tool Barn", category: "hardware", description: "lumber, nails" },
    "unknown",
    "Household building supplies",
  ],
  [
    {
      ref: "t4",
      kind: "purchase",
      merchant: "Tool Barn",
      category: "hardware",
      description: "chain lock, motion light",
    },
    "security",
    "Door lock and outdoor light",
  ],
  [
    { ref: "t5", kind: "purchase", merchant: "Tech Depot", category: "electronics", description: "bluetooth speaker" },
    "unknown",
    "Everyday electronics",
  ],
  [
    { ref: "t6", kind: "purchase", merchant: "Glow Nail Salon", category: "personal care", description: "manicure" },
    "unknown",
    "Personal care",
  ],
  [
    { ref: "t7", kind: "purchase", merchant: "Bayside Dental Group", category: "health care", description: "exam" },
    "dental",
    "Dental exam",
  ],
  [
    { ref: "t8", kind: "purchase", merchant: "Bed Haven", category: "home goods", description: "blanket" },
    "clothing_bedding",
    "Bedding",
  ],
  [
    { ref: "t9", kind: "purchase", merchant: "Clarity Optical", category: "optometry", description: "contact lenses" },
    "other",
    "Prescribed vision device",
  ],
  [
    { ref: "t10", kind: "purchase", merchant: "Sparkle Car Wash", category: "auto service", description: "wash" },
    "unknown",
    "Car wash",
  ],
];

const batchPrompt = (rows: ModelRow[]) =>
  `Sort each of these bank transactions. Answer with one result per ref.\n${JSON.stringify(rows)}`;

export const DEVICE_EXAMPLES: Turn[] = [
  { role: "user", content: batchPrompt(EXAMPLE_ROWS.map(([row]) => row)) },
  {
    role: "assistant",
    content: JSON.stringify({
      results: EXAMPLE_ROWS.map(([row, expense, reason]) => ({ ref: row.ref, expense, reason })),
    }),
  },
];

export function responseSchema(refs: string[]): object {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", enum: refs },
            expense: { type: "string", enum: [...MODEL_LABELS] },
            reason: { type: "string" },
          },
          required: ["ref", "expense", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

const FACT_KINDS = new Set<FactKind>(["purchase", "withdrawal", "deposit", "transfer", "bill"]);

// What the rules may look at. Rows from a file carry no merchant, so the description does the work.
export function toFacts(t: LocalTxn): TxnFacts {
  const kind: FactKind = t.kind && FACT_KINDS.has(t.kind) ? t.kind : t.amount_cents < 0 ? "deposit" : "purchase";
  return {
    ref: t.id,
    kind,
    merchant_name: t.merchant ?? "",
    merchant_category: t.category ?? "",
    description: displayDescription(t.description ?? ""),
    // A bank bill's dates are bookkeeping, so it never anchors a ride (classify.py does the same).
    date: kind === "bill" ? "" : t.date,
  };
}

// The keyword table of rules/tools/normalize.py, read the same way (words inside the padded text),
// so an excluded rule's tags and an item's tags meet.
const TAG_WORDS: [string[], string][] = [
  [["cell phone", "mobile phone", "phone"], "phone"],
  [["purse", "wallet", "handbag"], "purse"],
  [["jewelry", "jewellery"], "jewelry"],
  [["cash", "money"], "cash"],
  [["vehicle", "car "], "vehicle"],
  [["pain and suffering"], "pain_suffering"],
];
const NIGHTS = /\b(\d{1,2})\s*-?\s*(?:nights?|days?)\b/i;

export function tagsFor(text: string): string[] {
  const padded = ` ${norm(text)} `;
  return TAG_WORDS.filter(([words]) => words.some((w) => padded.includes(w)))
    .map(([, tag]) => tag)
    .sort();
}

// SPEC v1.2's typed unit for an item: a counseling charge is one session, lodging counts the
// nights it names, lost pay counts weeks, a ride has no unit. Tags go only on replaced property,
// so a rule that excludes phones does not catch a phone plan.
export function itemShape(
  expense: string,
  kind: string,
  text: string,
): { unit: Unit | null; units: number; tags: string[] } {
  if (expense === "counseling")
    return { unit: "session", units: kind === "purchase" || kind === "withdrawal" ? 1 : 0, tags: [] };
  if (expense === "temporary_housing") {
    const nights = NIGHTS.exec(text);
    return { unit: "day", units: nights ? Number(nights[1]) : 0, tags: [] };
  }
  if (expense === "lost_wages") return { unit: "week", units: 0, tags: [] };
  if (expense === "property_replacement") return { unit: null, units: 0, tags: tagsFor(text) };
  return { unit: null, units: 0, tags: [] };
}

const slice200 = (s: string) => Array.from(s).slice(0, 200).join("");

// A model's label is the model's; anything a rule decided last, including a ride linked to care,
// is the rules'.
function sourceOf(c: Classification, modelSource: Map<string, Source>): Source {
  return c.method === "model" ? (modelSource.get(c.ref) ?? "device_ai") : "rule";
}

export function toItem(t: LocalTxn, c: Classification, source: Source): LocalClassifiedItem | null {
  if (!c.candidate || t.amount_cents < 0) return null;
  const isBill = t.kind === "bill";
  const text = isBill ? (t.merchant ?? t.description) : [t.merchant, t.description].filter(Boolean).join(" ");
  const shape = itemShape(c.expense, toFacts(t).kind, [t.merchant, t.description].filter(Boolean).join(" "));
  return {
    item_id: t.id,
    date: t.date,
    amount_cents: t.amount_cents,
    expense: c.expense as ItemExpense,
    confirmed: c.confirmed,
    insurance_paid_cents: 0,
    is_bill: isBill,
    ...shape,
    description: slice200(text),
    source,
    reason: c.reason,
    confidence: c.confidence,
    method: c.method,
    linked_item_ids: [...c.linked_refs],
  };
}

// Two labels a model may suggest but code never takes from it (this goes further than the API's
// classifier, on purpose). A forensic exam is named only by the words on the row, because the law
// engine holds an exam line and tells the survivor not to pay it: that must never rest on a guess,
// as the bill reader already ensures. Lost pay comes only from paychecks, and a model only ever
// sees money going out, so its "lost_wages" is always wrong. Its reason is dropped with the label.
export function modelLabel(expense: string): string {
  if (expense === "forensic_exam") return "medical";
  if (expense === "lost_wages") return UNKNOWN;
  return expense;
}

export const REFUND_REASON = "The same amount came back later, so check whether it was refunded";
const REFUND_WORDS = /\b(refunds?|returns?|returned|credits?|reversals?|reversed|adjustments?)\b/g;
const refundKey = (t: LocalTxn) =>
  norm(t.merchant || t.description || "")
    .replace(REFUND_WORDS, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();

// Purchases matched one to one with a later deposit of the same amount from the same merchant,
// within 90 days; each deposit matches the latest such purchase before it. Paychecks, transfers
// and bank bills never match.
export function refundedPurchases(txns: LocalTxn[]): Set<string> {
  const out = new Set<string>();
  const spent = txns
    .filter((t) => t.amount_cents > 0 && t.kind !== "transfer" && t.kind !== "bill")
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const m of txns) {
    if (m.amount_cents >= 0 || (m.kind && m.kind !== "deposit")) continue;
    const key = refundKey(m);
    if (!key) continue;
    const hit = spent.find(
      (s) =>
        !out.has(s.id) &&
        s.amount_cents === -m.amount_cents &&
        s.date <= m.date &&
        daysBetween(s.date, m.date) <= 90 &&
        refundKey(s) === key,
    );
    if (hit) out.add(hit.id);
  }
  return out;
}

// A row as a model sees it, cut to the API's field limits so one very long description cannot
// fill Gemini Nano's context (which would end device sorting for every batch after it).
const cut = (text: string, max: number) => Array.from(text).slice(0, max).join("");

function modelRow(ref: string, f: TxnFacts): ModelRow {
  return {
    ref,
    kind: f.kind,
    merchant: cut(f.merchant_name, CLOUD_LIMITS.merchant),
    category: cut(f.merchant_category, CLOUD_LIMITS.category),
    description: cut(stripTags(f.description), CLOUD_LIMITS.description),
  };
}

type Answers = Map<string, { expense: string; reason: string; model: string; source: Source }>;

function takeAnswers(
  answers: ModelAnswer[],
  refs: Map<string, string>,
  into: Answers,
  model: string,
  source: Source,
): number {
  let n = 0;
  for (const a of answers) {
    const key = refs.get(String(a?.ref));
    if (key === undefined || into.has(key) || !MODEL_LABELS.includes(String(a.expense))) continue;
    into.set(key, { expense: String(a.expense), reason: String(a.reason ?? ""), model, source });
    n++;
  }
  return n;
}

async function askDevice(
  pending: Map<string, TxnFacts>,
  answers: Answers,
  report: ClassifyReport,
  opts: ClassifyOptions,
) {
  const signal = opts.signal;
  const started = Date.now();
  let base;
  try {
    base = await baseSession(SYSTEM_PROMPT, "text", opts.deviceExamples === false ? [] : DEVICE_EXAMPLES);
  } catch (err) {
    report.device.errors.push(`start: ${(err as Error).message}`);
    return;
  }
  const keys = [...pending.keys()];
  let timeouts = 0;
  for (let start = 0; start < keys.length; start += DEVICE_BATCH) {
    if (signal?.aborted) break;
    const batch = keys.slice(start, start + DEVICE_BATCH);
    const refs = new Map(batch.map((key, i) => [`t${i + 1}`, key]));
    const rows = [...refs].map(([ref, key]) => modelRow(ref, pending.get(key)!));
    const prompt = batchPrompt(rows);
    report.device.batches++;
    try {
      const timeout = opts.deviceTimeoutMs ?? DEVICE_TIMEOUT_MS;
      const out = (await promptJson(base, prompt, responseSchema([...refs.keys()]), timeout, signal)) as {
        results?: ModelAnswer[];
      };
      takeAnswers(Array.isArray(out?.results) ? out.results : [], refs, answers, DEVICE_MODEL, "device_ai");
      timeouts = 0;
    } catch (err) {
      report.device.errors.push(
        err instanceof DeviceAiTimeout
          ? `batch ${report.device.batches}: timed out`
          : `batch ${report.device.batches}: ${(err as Error).message}`,
      );
      if (err instanceof DeviceAiTimeout) {
        // Two slow batches in a row means the device is busy; leave the rest for review or cloud.
        if (++timeouts >= 2) break;
      } else if (!(err instanceof SyntaxError)) {
        forgetSessions();
        break;
      }
    }
  }
  report.device.used = true;
  report.device.ms += Date.now() - started;
}

async function askCloud(
  pending: Map<string, TxnFacts>,
  answers: Answers,
  report: ClassifyReport,
  opts: ClassifyOptions,
  canCount: (key: string) => boolean,
) {
  const started = Date.now();
  const keys = [...pending.keys()].filter((k) => !answers.has(k) && canCount(k));
  if (!keys.length) return;
  for (let start = 0; start < keys.length; start += CLOUD_BATCH) {
    const batch = keys.slice(start, start + CLOUD_BATCH);
    const refs = new Map(batch.map((key, i) => [`t${i + 1}`, key]));
    const rows = [...refs].map(([ref, key]) => modelRow(ref, pending.get(key)!));
    report.cloud.batches++;
    try {
      const { answers: got, model, note } = await cloudClassify(rows, { fetch: opts.fetch, signal: opts.signal });
      takeAnswers(got, refs, answers, model ?? "cloud", "cloud_ai");
      if (note) report.cloud.errors.push(note);
    } catch (err) {
      report.cloud.errors.push((err as Error).message);
      break;
    }
  }
  report.cloud.used = true;
  report.cloud.ms += Date.now() - started;
}

export async function classifyDetailed(
  input: StatementTxn[],
  ctx: ClassifyContext,
  opts: ClassifyOptions = {},
): Promise<ClassifyReport> {
  if (!isIsoDay(ctx.incident_date)) throw new Error(`incident_date must be YYYY-MM-DD, got ${ctx.incident_date}`);
  const report: ClassifyReport = {
    items: [],
    all: [],
    counts: { rows: input.length, items: 0, rule: 0, device_ai: 0, cloud_ai: 0, unresolved: 0, pay_dips: 0 },
    device: { status: "unavailable", used: false, batches: 0, ms: 0, errors: [] },
    cloud: { used: false, batches: 0, ms: 0, errors: [] },
    warnings: [],
  };

  // One row per id; a repeated id is the same record listed twice.
  const txns: LocalTxn[] = [];
  const ids = new Set<string>();
  for (const t of input as LocalTxn[]) {
    if (ids.has(t.id)) {
      report.warnings.push(`A record was listed twice and counted once.`);
      continue;
    }
    ids.add(t.id);
    txns.push(t);
  }
  const facts = txns.map(toFacts);

  // 1. Rules.
  const done = new Map<string, Classification>();
  const pending = new Map<string, TxnFacts>(); // content key -> first row with that content
  for (const f of facts) {
    const hit = classifyDeterministic(f);
    if (hit) done.set(f.ref, hit);
    else if (!pending.has(contentKey(f))) pending.set(contentKey(f), f);
  }

  // 2. Gemini Nano on this device, when it is ready. 3. Cloud Gemini, only with consent, and only
  // for rows from the date it happened on: earlier costs can never count, so they stay here.
  const answers: Answers = new Map();
  if (pending.size && opts.deviceAi !== false) {
    report.device.status = await deviceAiStatus("text");
    if (report.device.status === "available") await askDevice(pending, answers, report, opts);
  }
  if (pending.size > answers.size && opts.cloudConsent === true) {
    const lastSeen = new Map<string, string>();
    txns.forEach((t, i) => {
      const key = contentKey(facts[i]);
      if (pending.has(key) && t.date > (lastSeen.get(key) ?? "")) lastSeen.set(key, t.date);
    });
    await askCloud(pending, answers, report, opts, (key) => (lastSeen.get(key) ?? "") >= ctx.incident_date);
  }

  const modelSource = new Map<string, Source>();
  let results = facts.map((f) => {
    const hit = done.get(f.ref);
    if (hit) return hit;
    const a = answers.get(contentKey(f));
    if (!a) return unresolved(f);
    modelSource.set(f.ref, a.source);
    const allowed = modelLabel(a.expense);
    return fromModelAnswer(f, allowed, allowed === a.expense ? a.reason : "", a.model);
  });

  // Rows whose dollars are offered another way: a bank bill with an itemized statement (its
  // lines are read instead) and a payment Tend made (it paid lines that are already offered).
  const byRef = new Map(txns.map((t) => [t.id, t]));
  results = results.map((r) => {
    const t = byRef.get(r.ref)!;
    if (t.itemized) return setAside(r, ITEMIZED_REASON);
    if (t.tend_payment || isTendPayment(t.description ?? "")) return setAside(r, TEND_PAYMENT_REASON);
    return r;
  });

  // The itemized bill's service date is care on that day, so a ride then is travel to care.
  const anchors: Anchor[] = [...(opts.anchors ?? [])];
  const known = new Set(anchors.map((a) => `${a.date}|${a.ref}`));
  for (const t of txns) {
    const day = t.itemized?.service_date;
    if (day && !known.has(`${day}|${t.id}`)) anchors.push({ date: day, ref: t.id, expense: "medical" });
  }
  results = linkCareRides(facts, results, anchors);

  // A cost whose same amount later came back from the same place may have been refunded, so it is
  // asked about instead of starting checked. Nothing is removed: a wrong match costs one tap.
  const refunded = refundedPurchases(txns);
  results = results.map((r) =>
    refunded.has(r.ref) && r.candidate ? { ...r, confirmed: false, reason: REFUND_REASON } : r,
  );

  // A paycheck that came in short after the date becomes lost pay on its own id, as the API's
  // wage gaps do; checks that never came are new lines.
  const pay = opts.payDips === false ? { dips: new Map(), missed: [] } : inferPay(txns, ctx.incident_date);
  results = results.map((r) => {
    const dip = pay.dips.get(r.ref);
    if (!dip) return r;
    return {
      ...r,
      expense: "lost_wages",
      candidate: true,
      confirmed: false,
      confidence: dip.confidence,
      method: "inference",
      reason: dip.reason,
      linked_refs: [],
    };
  });
  report.all = results;

  for (const r of results) {
    const source = sourceOf(r, modelSource);
    if (r.method === "unresolved") report.counts.unresolved++;
    else if (source === "rule") report.counts.rule++;
    else report.counts[source === "cloud_ai" ? "cloud_ai" : "device_ai"]++;
    const item = pay.dips.get(r.ref) ?? toItem(byRef.get(r.ref)!, r, source);
    if (item) report.items.push(item);
  }
  const missed = pay.missed.filter((m: LocalClassifiedItem) => !ids.has(m.item_id));
  report.items.push(...missed);
  report.counts.pay_dips = pay.dips.size + missed.length;
  report.counts.items = report.items.length;
  if (report.device.errors.length && report.device.used)
    report.warnings.push("The on-device model could not sort some rows, so they are left for you to check.");
  if (report.cloud.errors.length)
    report.warnings.push("Cloud sorting did not answer, so some rows are left for you to check.");
  report.warnings = [...new Set(report.warnings)];
  return report;
}

export const classifier: LocalClassifier = {
  deviceAi: () => deviceAiStatus("text"),
  async classify(txns: StatementTxn[], ctx: ClassifyContext, opts?: ClassifyOptions) {
    return (await classifyDetailed(txns, ctx, opts)).items;
  },
  classifyDetailed,
  // The first load of the model can take several seconds, so a screen can start it early.
  async prewarm() {
    const status = await deviceAiStatus("text");
    if (status === "available") await baseSession(SYSTEM_PROMPT, "text", DEVICE_EXAMPLES).catch(() => undefined);
    return status;
  },
};
