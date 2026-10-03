// Port of api/tend_api/classify.py: the merchant registry, keyword rules, ride linking and set-asides.
// Same inputs give the same outputs (tests/local/classify-parity.test.ts checks this against the
// Python module on the seed snapshots). The model only ever picks a label; it never sees amounts.
import { EXPENSES } from "../types";
import { capitalizeFirst, collapseSpaces, pyRegex, pySplit, pyStrip, pyStripChars } from "./pytext";

export const UNKNOWN = "unknown";
export const MODEL_LABELS: readonly string[] = [...EXPENSES, UNKNOWN];
export const MODEL_CONFIDENCE = 0.6; // self-reported model confidence is not calibrated, so it is not asked for
export const MAX_REASON_WORDS = 19;
export const CONFIRM_AT = 0.85;
export const PROMPT_VERSION = "classify-v3";

// Care a same-day ride can be travel to, and the word the ride's reason uses for it.
export const CARE_EXPENSES: Record<string, string> = {
  counseling: "counseling",
  medical: "medical",
  forensic_exam: "medical",
  dental: "dental",
  prescription: "prescription",
};

export type FactKind = "purchase" | "withdrawal" | "deposit" | "transfer" | "bill" | "bill_line";

// Everything the classifier may look at. There is no amount field on purpose.
export interface TxnFacts {
  ref: string;
  kind: FactKind;
  merchant_name: string;
  merchant_category: string;
  description: string;
  date: string; // used only to link rides to care on the same day
}

export type Method = "registry" | "keyword" | "model" | "link" | "income" | "transfer" | "unresolved" | "set_aside";

export interface Classification {
  ref: string;
  expense: string; // a member of EXPENSES, or "unknown"
  candidate: boolean; // offer it to the survivor as a possible recovery cost
  confidence: number;
  method: string;
  reason: string;
  confirmed: boolean; // where review starts; model picks and inferred links are always false
  linked_refs: string[];
  model?: string | null;
}

interface Rule {
  pattern: RegExp;
  expense: string | null; // null: ordinary spending, never offered
  confidence: number;
  reason: string;
}

const rule = (pattern: string, expense: string | null, confidence: number, reason: string): Rule => ({
  pattern: pyRegex(pattern, "i"),
  expense,
  confidence,
  reason,
});

// Known single-purpose merchants: the fictional demo providers. Multi-purpose stores go through keywords.
export const MERCHANT_REGISTRY = new Map<string, [string | null, string]>([
  ["clearwater counseling group", ["counseling", "Known counseling practice"]],
  ["riverbend general hospital", ["medical", "Known hospital"]],
  ["larkfield market", [null, "Grocery store"]],
  ["lumen streaming", [null, "Streaming subscription"]],
]);

// First match wins, so the narrow patterns sit above the broad ones ("security deposit" is a
// move-in cost, not home security; "new phone" beats "monthly plan").
export const KEYWORD_RULES: readonly Rule[] = [
  rule(
    String.raw`\bforensic (exam|examination)\b|\bsane exam\b|\bsexual assault (medical )?(forensic )?exam`,
    "forensic_exam",
    0.95,
    "Names a medical forensic exam",
  ),
  rule(
    String.raw`\bsecurity deposit\b|\bfirst month'?s rent\b|\butilit(y|ies) (setup|start|connection)\b`,
    "relocation",
    0.85,
    "Deposit or move-in cost for a new home",
  ),
  rule(
    String.raw`\btruck rental\b|\bmoving (truck|van|company|services?)\b|\bmovers\b`,
    "relocation",
    0.85,
    "Moving cost",
  ),
  rule(
    String.raw`\blocksmith|\brekey|\bdeadbolt|\block (&|and) (safe|key)\b|\balarm (system|install)|\bsecurity camera`,
    "security",
    0.85,
    "Lock or home security work",
  ),
  rule(
    String.raw`\bcounsel(ing|or|ling)\b|\btherap(y|ist)\b|\bpsycho(therapy|logist)\b|\b(behavioral|mental) health\b`,
    "counseling",
    0.9,
    "Counseling or therapy charge",
  ),
  rule(String.raw`\brx\b|\bprescription\b`, "prescription", 0.85, "Prescription charge"),
  rule(String.raw`\bdent(al|ist)\b|\borthodont`, "dental", 0.9, "Dental care"),
  rule(
    String.raw`\bhospital\b|\bmedical center\b|\burgent care\b|\bclinic\b|\bemergency (department|room)\b|` +
      String.raw`\blaboratory\b|\bambulance\b|\bphysician\b`,
    "medical",
    0.85,
    "Medical care",
  ),
  rule(String.raw`\bhotel\b|\bmotel\b|\blodging\b|\bextended stay\b`, "temporary_housing", 0.7, "Short-term lodging"),
  rule(String.raw`\bchild ?care\b|\bdaycare\b|\bbabysit`, "childcare", 0.85, "Child care"),
  rule(String.raw`\bfuneral\b|\bburial\b|\bcremation\b`, "funeral", 0.9, "Funeral cost"),
  rule(String.raw`\battorney\b|\blaw (office|firm)\b|\blegal (aid|services?)\b`, "legal", 0.85, "Legal services"),
  rule(String.raw`\btuition\b`, "tuition", 0.85, "Tuition"),
  rule(
    String.raw`\bnew (phone|laptop)\b|\bphone replacement\b|\bdevice purchase\b`,
    "property_replacement",
    0.85,
    "Replaces a phone or other personal property",
  ),
  rule(
    String.raw`\bbedding\b|\bcomforter\b|\bduvet\b|\bapparel\b|\bclothing\b`,
    "clothing_bedding",
    0.7,
    "Clothing or bedding",
  ),
  rule(
    String.raw`\brideshare\b|\brides?\b|\btaxi\b|\bcab\b|\btransit\b|\bbus fare\b|\bparking\b`,
    "transportation",
    0.8,
    "Ride or transit fare",
  ),
  rule(
    String.raw`\bgrocer(y|ies)\b|\bsupermarket\b|\bcoffee\b|\bcafe\b|\brestaurant\b|\btakeout\b|\bstreaming\b|` +
      String.raw`\bsubscription\b|\bmonthly plan\b|\batm\b`,
    null,
    0.9,
    "Everyday spending",
  ),
];

const TAG = pyRegex(String.raw`\[[a-z_]+:[^\]]*\]`, "gi");
// nessie.py's _ANY_TAG: what display_description removes.
const ANY_TAG = pyRegex(String.raw`\s*\[[a-z_]+:[^\]]*\]`, "gi");
const TEND_ACTION = pyRegex(String.raw`\[tend:[^\]]+\]`, "i");

export function norm(text: string | null | undefined): string {
  return pyStrip(collapseSpaces((text ?? "").replace(TAG, " "))).toLowerCase();
}

export function displayDescription(description: string): string {
  return pyStrip(description.replace(ANY_TAG, ""));
}

export function isTendPayment(description: string): boolean {
  return TEND_ACTION.test(description);
}

// The model sees the description without bracket tags such as [payee:...].
export function stripTags(description: string): string {
  return pyStrip(description.replace(TAG, ""));
}

function made(f: TxnFacts, expense: string | null, confidence: number, method: string, reason: string): Classification {
  if (expense === null)
    return {
      ref: f.ref,
      expense: UNKNOWN,
      candidate: false,
      confidence,
      method,
      reason,
      confirmed: false,
      linked_refs: [],
    };
  if (expense === "transportation") {
    // A ride is only a recovery cost when it is travel to care; linkCareRides decides.
    return { ref: f.ref, expense, candidate: false, confidence, method, reason, confirmed: false, linked_refs: [] };
  }
  return {
    ref: f.ref,
    expense,
    candidate: true,
    confidence,
    method,
    reason,
    confirmed: confidence >= CONFIRM_AT,
    linked_refs: [],
  };
}

export function classifyDeterministic(f: TxnFacts): Classification | null {
  if (f.kind === "deposit")
    return {
      ref: f.ref,
      expense: UNKNOWN,
      candidate: false,
      confidence: 0.95,
      method: "income",
      reason: "Money coming in, not a cost",
      confirmed: false,
      linked_refs: [],
    };
  if (f.kind === "transfer")
    return {
      ref: f.ref,
      expense: UNKNOWN,
      candidate: false,
      confidence: 0.95,
      method: "transfer",
      reason: "Money moved between accounts",
      confirmed: false,
      linked_refs: [],
    };
  const exam = KEYWORD_RULES[0];
  if (exam.pattern.test(norm(f.description))) {
    // Checked before the registry: an exam line on a hospital bill is not plain "medical".
    return made(f, exam.expense, exam.confidence, "keyword", exam.reason);
  }
  const known = MERCHANT_REGISTRY.get(norm(f.merchant_name));
  if (known && f.kind !== "bill_line") return made(f, known[0], 0.95, "registry", known[1]);
  let haystack = [f.merchant_name, f.description, f.merchant_category].map(norm).join(" | ");
  if (f.kind === "bill_line") haystack = norm(f.description); // each line says what it is
  for (const r of KEYWORD_RULES) {
    if (r.pattern.test(haystack)) return made(f, r.expense, r.confidence, "keyword", r.reason);
  }
  return null;
}

export const LABEL_TEXT: Record<string, string> = {
  medical: "medical care",
  forensic_exam: "a forensic exam",
  counseling: "counseling",
  lost_wages: "lost pay",
  transportation: "a ride or fare",
  relocation: "a moving cost",
  temporary_housing: "short-term lodging",
  security: "home security",
  crime_scene_cleanup: "cleanup",
  childcare: "child care",
  property_replacement: "replacement property",
  clothing_bedding: "clothing or bedding",
  prescription: "a prescription",
  dental: "dental care",
  funeral: "a funeral cost",
  legal: "legal help",
  tuition: "tuition",
  other: "a prescribed device",
  [UNKNOWN]: "ordinary spending",
};

const DASH = pyRegex("\\s*[\u2013\u2014]\\s*", "g");
const MONEYISH = /[0-9$\u20ac\u00a3]/u;
const COVERAGE_TALK = pyRegex(String.raw`\b(cover(ed|s|age)?|eligib\w*|qualif\w*|reimburs\w*|compensab\w*)\b`, "i");

// Model reasons are shown to people: under 20 words, no numbers, no dashes as punctuation, and no
// word on coverage, which only the law engine decides.
export function cleanReason(text: string | null | undefined, label: string): string {
  let t = (text ?? "").replace(DASH, ", ");
  t = t
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"');
  const words = pySplit(t).filter((w) => !MONEYISH.test(w));
  const out = pyStripChars(words.slice(0, MAX_REASON_WORDS).join(" "), " ,;:-.");
  if (!out || COVERAGE_TALK.test(out))
    return `Looks like ${Object.hasOwn(LABEL_TEXT, label) ? LABEL_TEXT[label] : "ordinary spending"}`;
  return capitalizeFirst(out);
}

// Python's Classifier._from_entry: a model answer becomes an unconfirmed pick.
export function fromModelAnswer(f: TxnFacts, expense: string, reason: string, model: string | null): Classification {
  const label = MODEL_LABELS.includes(expense) ? expense : UNKNOWN;
  const candidate = label !== UNKNOWN && label !== "transportation"; // rides wait for linkCareRides
  return {
    ref: f.ref,
    expense: label,
    candidate,
    confidence: MODEL_CONFIDENCE,
    method: "model",
    reason: cleanReason(reason, label),
    confirmed: false,
    linked_refs: [],
    model,
  };
}

export function unresolved(f: TxnFacts): Classification {
  return {
    ref: f.ref,
    expense: UNKNOWN,
    candidate: true,
    confidence: 0,
    method: "unresolved",
    reason: "Could not sort this one; review it by hand",
    confirmed: false,
    linked_refs: [],
  };
}

export interface Anchor {
  date: string;
  ref: string;
  expense: string;
}

// A ride counts only as travel to care: same day as a confident care charge. Extra anchors are
// care that is not a bank row, such as the service date on an itemized bill. Links are inferences,
// so they always come back unconfirmed.
export function linkCareRides(
  facts: TxnFacts[],
  results: Classification[],
  extraAnchors: Anchor[] = [],
): Classification[] {
  const byRef = new Map(results.map((r) => [r.ref, r]));
  const anchors = new Map<string, { ref: string; expense: string }[]>();
  const push = (date: string, ref: string, expense: string) => {
    const list = anchors.get(date) ?? [];
    list.push({ ref, expense });
    anchors.set(date, list);
  };
  for (const f of facts) {
    const r = byRef.get(f.ref)!;
    if (f.date && Object.hasOwn(CARE_EXPENSES, r.expense) && r.candidate && r.confidence >= CONFIRM_AT)
      push(f.date, f.ref, r.expense);
  }
  for (const a of extraAnchors) push(a.date, a.ref, a.expense);

  return facts.map((f) => {
    const r = byRef.get(f.ref)!;
    if (r.expense !== "transportation" || !f.date) return r;
    const hits = anchors.get(f.date) ?? [];
    if (hits.length) {
      const care = Object.hasOwn(CARE_EXPENSES, hits[0].expense) ? CARE_EXPENSES[hits[0].expense] : "care";
      return {
        ...r,
        candidate: true,
        confirmed: false,
        method: "link",
        confidence: 0.7,
        linked_refs: hits.map((h) => h.ref),
        reason: `Same day as a ${care} charge`,
      };
    }
    return { ...r, candidate: false, confirmed: false, linked_refs: [], reason: "Ride on a day with no care charge" };
  });
}

export const ITEMIZED_REASON = "Itemized statement on file, so its lines are reviewed one by one instead";
export const TEND_PAYMENT_REASON = "Payment made through Tend, so the bill lines it paid are reviewed instead";

export function setAside(r: Classification, reason: string): Classification {
  return { ...r, candidate: false, confirmed: false, linked_refs: [], reason };
}

// The rows the model is asked about, keyed so each distinct content is sent once.
export function contentKey(f: TxnFacts): string {
  return JSON.stringify([
    PROMPT_VERSION,
    f.kind,
    norm(f.merchant_name),
    norm(f.merchant_category),
    norm(f.description),
  ]);
}
