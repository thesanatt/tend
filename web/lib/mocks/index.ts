// Thin stand-ins for the local-first modules in lib/contracts.ts. Tests use them; until the real
// modules merge, the placeholder files at lib/local, lib/vault, lib/share, and lib/packet re-export
// them so this branch runs end to end. They are simple on purpose and never leave the device.
import type {
  BillReader,
  BillReading,
  ChecklistItem,
  ClassifiedItem,
  Classifier,
  DeviceAi,
  FilingRoute,
  Letter,
  Packet,
  PacketBuilder,
  Share,
  SharedPacket,
  StatementParser,
  StatementTxn,
  Vault,
} from "../contracts";
import type { EngineInput, EngineOutput, ItemExpense, Jurisdiction } from "../types";

async function fileText(file: Blob): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new TextDecoder().decode(await new Response(file).arrayBuffer());
}

async function fileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(
    typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Response(file).arrayBuffer(),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- statement parser: CSV with a header row; dates as MM/DD/YYYY or YYYY-MM-DD ----

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function isoDay(text: string): string | null {
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}

function cents(text: string): number | null {
  const m = text.replace(/[$,\s]/g, "").match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const value = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -value : value;
}

export const mockStatementParser: StatementParser = {
  async parse(file) {
    const name = (file as File).name ?? "statement";
    if (!/\.csv$/i.test(name) && !/^date,/i.test((await fileText(file)).slice(0, 5))) {
      return { txns: [], warnings: [`unsupported:${name}`] };
    }
    const lines = (await fileText(file)).split(/\r?\n/).filter((l) => l.trim());
    const head = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const iDate = col(/date/);
    const iDesc = col(/desc|memo|payee/);
    const iAmount = col(/^amount$/);
    const iMerchant = col(/merchant/);
    const txns: StatementTxn[] = [];
    const warnings: string[] = [];
    lines.slice(1).forEach((line, n) => {
      const cells = splitCsvLine(line);
      const date = isoDay(cells[iDate] ?? "");
      const amount = cents(cells[iAmount] ?? "");
      if (!date || amount === null) {
        warnings.push(`row ${n + 2}`);
        return;
      }
      txns.push({
        id: `csv:${n + 1}`,
        date,
        // Statements show money out as negative; the contract wants it positive.
        amount_cents: -amount,
        description: cells[iDesc] ?? "",
        merchant: iMerchant >= 0 ? cells[iMerchant] || undefined : undefined,
        origin: "csv",
      });
    });
    return { txns, warnings };
  },
};

// ---- classifier: merchant and keyword rules, then rides on a care day, then pay dips ----

interface KeywordRule {
  re: RegExp;
  expense: ItemExpense;
  direct: boolean;
  reason: string;
  unit?: ClassifiedItem["unit"];
  tags?: string[];
}

const RULES: KeywordRule[] = [
  { re: /forensic|sane exam/i, expense: "forensic_exam", direct: true, reason: "A forensic exam charge" },
  {
    re: /counsel|therap|psycholog/i,
    expense: "counseling",
    direct: true,
    reason: "A counseling provider charge",
    unit: "session",
  },
  { re: /\brx\b|prescription/i, expense: "prescription", direct: true, reason: "A prescription copay" },
  {
    re: /hospital|emergency|clinic|urgent care|medical/i,
    expense: "medical",
    direct: true,
    reason: "A medical provider charge",
  },
  {
    re: /lock|deadbolt|rekey|door chain|motion sensor|security system/i,
    expense: "security",
    direct: false,
    reason: "Home security after the date",
  },
  {
    re: /security deposit|truck rental|moving|movers/i,
    expense: "relocation",
    direct: false,
    reason: "A moving cost after the date",
  },
  {
    re: /new phone|replacement phone/i,
    expense: "property_replacement",
    direct: false,
    reason: "A replaced phone",
    tags: ["phone"],
  },
  { re: /sheet set|bedding|pillow/i, expense: "clothing_bedding", direct: false, reason: "Replaced bedding" },
  { re: /\btrip\b|ride|taxi|cab\b/i, expense: "transportation", direct: false, reason: "A ride" },
];

function classifyOne(t: StatementTxn): ClassifiedItem | null {
  const text = `${t.merchant ?? ""} ${t.description}`;
  const rule = RULES.find((r) => r.re.test(text));
  if (!rule || t.amount_cents <= 0) return null;
  return {
    item_id: `${t.origin}:${t.id}`,
    date: t.date,
    amount_cents: t.amount_cents,
    expense: rule.expense,
    confirmed: rule.direct,
    insurance_paid_cents: 0,
    is_bill: false,
    units: rule.unit === "session" ? 1 : 0,
    unit: rule.unit ?? null,
    tags: rule.tags ?? [],
    description: t.merchant ? `${t.merchant} - ${t.description}` : t.description,
    source: "rule",
    reason: rule.reason,
    confidence: rule.direct ? 0.95 : 0.7,
  };
}

const CARE: ItemExpense[] = ["counseling", "medical", "forensic_exam", "prescription", "dental"];

export const mockClassifier: Classifier = {
  async deviceAi(): Promise<DeviceAi> {
    return "unavailable";
  },
  async classify(txns, ctx) {
    const after = txns.filter((t) => t.date >= ctx.incident_date);
    const items = after.map(classifyOne).filter((i): i is ClassifiedItem => i !== null);
    const careDays = new Set(items.filter((i) => CARE.includes(i.expense)).map((i) => i.date));
    for (const it of items) {
      if (it.expense === "transportation") {
        it.reason = careDays.has(it.date) || it.date === ctx.incident_date ? "A ride on a day with care" : "A ride";
        it.confidence = careDays.has(it.date) ? 0.8 : 0.5;
      }
    }
    // Paychecks from the same payer that came in smaller than before the date.
    const pay = txns.filter((t) => t.amount_cents < 0 && /payroll|paycheck|salary/i.test(t.description));
    const before = pay
      .filter((t) => t.date < ctx.incident_date)
      .map((t) => -t.amount_cents)
      .sort((a, b) => a - b);
    const usual = before.length ? before[Math.floor(before.length / 2)] : 0;
    let prev: string | null = before.length ? pay.filter((t) => t.date < ctx.incident_date).at(-1)!.date : null;
    for (const t of pay.filter((p) => p.date >= ctx.incident_date)) {
      const got = -t.amount_cents;
      const days = prev ? Math.round((Date.parse(t.date) - Date.parse(prev)) / 86_400_000) : 14;
      prev = t.date;
      if (!usual || got >= usual * 0.9) continue;
      items.push({
        item_id: `${t.origin}:${t.id}:pay`,
        date: t.date,
        amount_cents: usual - got,
        expense: "lost_wages",
        confirmed: false,
        insurance_paid_cents: 0,
        is_bill: false,
        units: Math.max(1, Math.round(days / 7)),
        unit: "week",
        tags: [],
        description: t.description,
        source: "rule",
        reason: "A paycheck smaller than usual",
        confidence: 0.6,
      });
    }
    return items.sort((a, b) => (a.date === b.date ? a.item_id.localeCompare(b.item_id) : a.date < b.date ? -1 : 1));
  },
};

// ---- bill reader: knows the fictional sample bill; anything else is "couldn't read reliably" ----

export const SAMPLE_BILL_READING: BillReading = {
  status: "ok",
  provider: "Riverbend General Hospital",
  total_cents: 44300,
  lines: [
    { line_id: "1", description: "Emergency department visit, copay", amount_cents: 7500, expense: "medical" },
    {
      line_id: "2",
      description: "Medical forensic exam, deductible applied",
      amount_cents: 32500,
      expense: "forensic_exam",
    },
    { line_id: "3", description: "Laboratory services, coinsurance", amount_cents: 4300, expense: "medical" },
  ],
  sums_match: true,
  source: "rule",
};

export function mockBillReader(known: Record<string, BillReading> = {}): BillReader {
  return {
    async read(file) {
      const sha = await sha256Hex(await fileBytes(file));
      const hit = known[sha] ?? (/riverbend/i.test((file as File).name ?? "") ? SAMPLE_BILL_READING : null);
      return (
        hit ?? { status: "unreliable", provider: null, total_cents: null, lines: [], sums_match: false, source: "rule" }
      );
    },
  };
}

// ---- vault: in memory only, so nothing survives a reload ----

export function mockVault(): Vault & { snapshot(): Map<string, unknown> } {
  const data = new Map<string, unknown>();
  let secret: string | null = null;
  let created = false;
  let open = false;
  return {
    async exists() {
      return created;
    },
    async create(opts) {
      secret = opts.passkey ? "passkey" : (opts.passphrase ?? null);
      if (!secret) throw new Error("choose a passkey or a passphrase");
      created = true;
      open = true;
    },
    async unlock(opts) {
      if (!created) return false;
      open = (opts.passkey ? "passkey" : opts.passphrase) === secret;
      return open;
    },
    lock() {
      open = false;
    },
    isUnlocked() {
      return open;
    },
    async get<T>(key: string) {
      if (!open) throw new Error("vault is locked");
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      if (!open) throw new Error("vault is locked");
      data.set(key, structuredClone(value));
    },
    async destroy() {
      data.clear();
      created = false;
      open = false;
      secret = null;
    },
    snapshot: () => data,
  };
}

// ---- share: sealed packets kept in memory; the key would travel only in the fragment ----

export function mockShare(origin = "https://tend.example"): Share & { sealed: Map<string, SharedPacket> } {
  const sealed = new Map<string, SharedPacket>();
  return {
    sealed,
    async seal(packet) {
      const id = crypto.randomUUID().slice(0, 8);
      sealed.set(id, structuredClone(packet));
      return { id, url: `${origin}/share/${id}#k=${crypto.randomUUID().replace(/-/g, "")}` };
    },
    async open(url) {
      const id = new URL(url).pathname.split("/").pop() ?? "";
      const p = sealed.get(id);
      if (!p) throw new Error("not found");
      return structuredClone(p);
    },
    async revoke(id) {
      sealed.delete(id);
    },
  };
}

// ---- packet builder: plain letters and a one-page summary; the real one fills the state's form ----

async function summaryPdf(st: string, output: EngineOutput): Promise<Blob> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    `Crime victim compensation claim summary, ${st}. Prepared on this device.`,
    `Amount you can ask for: $${(output.totals.allowed_cents / 100).toFixed(2)}. The program decides.`,
    ...output.lines
      .filter((l) => l.status === "eligible")
      .map((l) => `${l.item_id}  ${l.expense}  $${(l.allowed_cents / 100).toFixed(2)}  ${l.rule_ids.join(" ")}`),
  ];
  lines.forEach((text, i) => page.drawText(text.slice(0, 95), { x: 48, y: 740 - i * 16, size: 10, font }));
  return new Blob([(await doc.save()) as BlobPart], { type: "application/pdf" });
}

// The billing letter is left to the flow's own rule-quoting fallback, so both paths stay exercised.
function letters(input: EngineInput, output: EngineOutput): Letter[] {
  const has = (e: string) => output.lines.some((l) => l.status === "eligible" && l.expense === e);
  const out: Letter[] = [];
  if (has("lost_wages"))
    out.push({
      kind: "employer_wages",
      title: "Letter to your employer about missed work",
      body: "To my employer:\n\nPlease write a short letter that lists the dates I missed work, my usual pay, and the pay I did not receive. I need it for a state program. Please do not include anything else.\n\nThank you.",
      rule_ids: [],
    });
  if (has("counseling"))
    out.push({
      kind: "provider_statement",
      title: "Request to your counseling provider",
      body: "To my counseling provider:\n\nPlease send a statement of my session dates and charges, and what I paid. I need it for a state program.\n\nThank you.",
      rule_ids: [],
    });
  if (input.items.some((i) => i.is_bill))
    out.push({
      kind: "itemized_bill_request",
      title: "Request for an itemized bill",
      body: "To the billing office:\n\nPlease send me an itemized bill for my account, with each service, its date, and its charge.\n\nThank you.",
      rule_ids: [],
    });
  return out;
}

const METHODS = new Set(["mail", "online", "email", "fax", "in_person"]);

// With a law loader, the checklist and filing routes come from the state's verified rules.
export function mockPacketBuilder(loadLaw?: (st: string) => Promise<Jurisdiction | null>): PacketBuilder {
  return {
    async build(st, input, output): Promise<Packet> {
      const law = loadLaw ? await loadLaw(st) : null;
      const rules = law?.rules ?? [];
      const seen = new Set<string>();
      const stillNeeded: ChecklistItem[] = rules
        .filter((r) => r.category === "required_document" && typeof r.params?.document === "string")
        .filter((r) => r.params?.document !== "other" && r.params?.document !== "police_report")
        .filter((r) => !seen.has(String(r.params?.document)) && Boolean(seen.add(String(r.params?.document))))
        .map((r) => ({
          document: String(r.params?.document),
          rule_id: r.id,
          quote: r.quote,
          have_it: r.params?.document === "itemized_bill" && input.items.some((i) => i.is_bill),
        }));
      const filing: FilingRoute[] = rules
        .filter((r) => r.category === "submission" && METHODS.has(String(r.params?.method)))
        .map((r) => ({
          method: r.params?.method as FilingRoute["method"],
          target: String(r.params?.target ?? ""),
          rule_id: r.id,
        }));
      return {
        summaryPdf: await summaryPdf(st, output),
        formPdf: null,
        letters: letters(input, output),
        stillNeeded,
        filing,
      };
    },
  };
}
