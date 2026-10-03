// Module contracts for the local-first build (docs/PRIVACY.md, docs/UX.md, docs/SPEC.md v1.2).
// Each module owns its directory; the flow UI codes against these types only.
import type { EngineInput, EngineItem, EngineOutput, ItemExpense } from "./types";

export type Unit = "session" | "week" | "hour" | "mile" | "day" | "month" | "item";

// Where a decision or reading came from. Shown to the survivor in plain words.
export type Source = "rule" | "device_ai" | "cloud_ai" | "survivor";

// lib/local/statement: parse a bank statement on the device.
export interface StatementTxn {
  id: string;
  date: string; // YYYY-MM-DD
  amount_cents: number; // money out is positive
  description: string;
  merchant?: string;
  origin: "csv" | "ofx" | "pdf" | "nessie";
}
export interface StatementParser {
  parse(file: File): Promise<{ txns: StatementTxn[]; warnings: string[] }>;
}

// lib/local/classify: transactions to engine items, on the device.
export interface ClassifiedItem extends EngineItem {
  unit: Unit | null;
  tags: string[];
  source: Source;
  reason: string; // plain words, at most 20
  confidence: number; // 0..1
}
export type DeviceAi = "available" | "downloadable" | "downloading" | "unavailable";
export interface Classifier {
  deviceAi(): Promise<DeviceAi>;
  classify(txns: StatementTxn[], ctx: { st: string; incident_date: string }): Promise<ClassifiedItem[]>;
}

// lib/local/bill: read a bill photo or PDF on the device.
export interface BillLine {
  line_id: string;
  description: string;
  amount_cents: number;
  expense: ItemExpense;
}
export interface BillReading {
  status: "ok" | "unreliable";
  provider: string | null;
  total_cents: number | null;
  lines: BillLine[];
  sums_match: boolean;
  source: Source;
}
export interface BillReader {
  read(file: File): Promise<BillReading>;
}

// lib/vault: encrypted storage on the device. The key exists only in memory while unlocked.
export interface Vault {
  exists(): Promise<boolean>;
  create(opts: { passphrase?: string; passkey?: boolean }): Promise<void>;
  unlock(opts: { passphrase?: string; passkey?: boolean }): Promise<boolean>;
  lock(): void;
  isUnlocked(): boolean;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  destroy(): Promise<void>;
}

// lib/share: end-to-end encrypted share links. The key travels only in the URL fragment.
export interface SharedPacket {
  st: string;
  created_at: string;
  input: EngineInput;
  output: EngineOutput;
  notes?: string;
}
export interface Share {
  seal(packet: SharedPacket, opts: { expires_hours: number; once: boolean }): Promise<{ url: string; id: string }>;
  open(url: string): Promise<SharedPacket>;
  revoke(id: string): Promise<void>;
}

// lib/packet: documents built on the device.
export type LetterKind = "billing_hold" | "employer_wages" | "provider_statement" | "itemized_bill_request";
export interface Letter {
  kind: LetterKind;
  title: string;
  body: string; // plain text with the law quoted
  rule_ids: string[];
}
export interface ChecklistItem {
  document: string;
  rule_id: string;
  quote: string;
  have_it: boolean;
}
export interface FilingRoute {
  method: "mail" | "online" | "email" | "fax" | "in_person";
  target: string;
  rule_id: string;
}
export interface Packet {
  summaryPdf: Blob;
  formPdf: Blob | null; // the state's own application, safe fields only, when it is fillable
  letters: Letter[];
  stillNeeded: ChecklistItem[];
  filing: FilingRoute[];
}
export interface PacketBuilder {
  build(st: string, input: EngineInput, output: EngineOutput): Promise<Packet>;
}
