// Types for the on-device layer. They extend the shared contracts (lib/contracts.ts) with what a
// parser or model could tell beyond them; every extra field is optional for callers.
import type {
  BillLine,
  BillReader,
  BillReading,
  ClassifiedItem,
  Classifier,
  DeviceAi,
  StatementParser,
  StatementTxn,
} from "../contracts";
import type { Classification } from "./rules";

export type TxnKind = "purchase" | "withdrawal" | "deposit" | "transfer" | "bill";

export interface LocalTxn extends StatementTxn {
  kind?: TxnKind;
  category?: string; // the bank's or the merchant's category, when the source has one
  status?: string;
  // A bank bill that an itemized document explains: its lines are reviewed instead of the bill.
  itemized?: { service_date: string | null };
  line?: number; // 1-based line or row in the source file
}

export interface StatementResult {
  txns: LocalTxn[];
  warnings: string[];
  format: "csv" | "ofx" | "pdf" | "nessie";
  layout: string; // which export the parser recognized, e.g. "chase_checking"
}

export interface NessieResult extends StatementResult {
  fictional: boolean;
  label: string | null;
  source: string | null; // "live" or "snapshot" when the relay says
}

export interface ClassifyContext {
  st: string;
  incident_date: string;
}

export interface ClassifyOptions {
  // The survivor agreed, on a consent screen, to send unsorted descriptions to cloud Gemini.
  cloudConsent?: boolean;
  // Use Gemini Nano when it is ready on this device (default true). Never starts a download.
  deviceAi?: boolean;
  // Infer lost pay from paychecks that dropped after the date (default true).
  payDips?: boolean;
  // Time limit for each on-device prompt (default 5000 ms).
  deviceTimeoutMs?: number;
  // Give Gemini Nano the worked examples (default true); false is for measuring without them.
  deviceExamples?: boolean;
  // Care days that are not bank rows, such as an itemized bill's service date.
  anchors?: { date: string; ref: string; expense: string }[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface LocalClassifiedItem extends ClassifiedItem {
  method: string;
  linked_item_ids: string[];
}

export interface ClassifyReport {
  items: LocalClassifiedItem[];
  // Every row's classification, including ordinary spending that is not offered.
  all: Classification[];
  counts: {
    rows: number;
    items: number;
    rule: number;
    device_ai: number;
    cloud_ai: number;
    unresolved: number;
    pay_dips: number;
  };
  device: { status: DeviceAi; used: boolean; batches: number; ms: number; errors: string[] };
  cloud: { used: boolean; batches: number; ms: number; errors: string[] };
  warnings: string[];
}

export interface LocalBillLine extends BillLine {
  date: string | null;
  columns_cents: number[];
}

export interface LocalBillReading extends BillReading {
  lines: LocalBillLine[];
  format: "pdf" | "image" | "text";
  sha256: string;
  statement_date: string | null;
  service_date: string | null;
  amount_due_cents: number | null;
  adjustments: { label: string; amount_cents: number }[];
  lines_sum_cents: number;
  fictional: boolean;
  checks: { name: string; ok: boolean }[];
  warnings: string[];
}

// The shared contracts, widened: Blob as well as File, and the richer results above.
export interface LocalStatementParser extends StatementParser {
  parse(file: File | Blob): Promise<StatementResult>;
  parseText(text: string): StatementResult;
  parseBytes(bytes: Uint8Array): Promise<StatementResult>;
  fromNessie(body: unknown): NessieResult;
  fetchNessie(
    persona: string,
    opts?: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<NessieResult>;
}

export interface LocalClassifier extends Classifier {
  classify(txns: StatementTxn[], ctx: ClassifyContext, opts?: ClassifyOptions): Promise<LocalClassifiedItem[]>;
  classifyDetailed(txns: StatementTxn[], ctx: ClassifyContext, opts?: ClassifyOptions): Promise<ClassifyReport>;
  // Loads the on-device model ahead of time. Never downloads.
  prewarm(): Promise<DeviceAi>;
}

export interface LocalBillReader extends BillReader {
  read(file: File | Blob, opts?: { signal?: AbortSignal }): Promise<LocalBillReading>;
}
