// Shapes from docs/SPEC.md (engine input/output) and rules/SCHEMA.md (verified rules).
// Money is always integer cents.

export const EXPENSES = [
  "medical",
  "forensic_exam",
  "counseling",
  "lost_wages",
  "transportation",
  "relocation",
  "temporary_housing",
  "security",
  "crime_scene_cleanup",
  "childcare",
  "property_replacement",
  "clothing_bedding",
  "prescription",
  "dental",
  "funeral",
  "legal",
  "tuition",
  "other",
] as const;

export type Expense = (typeof EXPENSES)[number];
export type ItemExpense = Expense | "unknown";
export type PoliceReport = "yes" | "no" | "unknown";

export interface EngineContext {
  incident_date: string;
  as_of_date: string;
  police_report: PoliceReport;
  forensic_exam: boolean;
}

export interface EngineItem {
  item_id: string;
  date: string;
  amount_cents: number;
  expense: ItemExpense;
  confirmed: boolean;
  insurance_paid_cents: number;
  is_bill: boolean;
  units: number;
  description: string;
}

export interface EngineInput {
  jurisdiction: string;
  context: EngineContext;
  items: EngineItem[];
}

export type LineStatus = "out_of_window" | "held" | "excluded" | "unknown_rule" | "needs_confirmation" | "eligible";

export interface EngineLine {
  item_id: string;
  expense: ItemExpense;
  status: LineStatus;
  requested_cents: number;
  allowed_cents: number;
  rule_ids: string[];
  cap_rule_id: string | null;
  flags: string[];
}

export interface EngineTotals {
  requested_cents: number;
  allowed_cents: number;
  held_cents: number;
  by_expense: Partial<Record<ItemExpense, number>>;
}

export interface DeadlineCheck {
  status: "ok" | "late" | "unknown";
  deadline_date: string | null;
  rule_ids: string[];
}

export interface MinimumLossCheck {
  // may_be_waived comes from engines built to SPEC v1.1 (discretionary waivers).
  status: "met" | "not_met" | "waived" | "may_be_waived" | "unknown";
  rule_ids: string[];
}

export interface ReportingCheck {
  // not_required comes from engines built to SPEC v1.1.
  status: "satisfied" | "required" | "not_required" | "unknown";
  rule_ids: string[];
}

export interface EngineChecks {
  deadline: DeadlineCheck;
  minimum_loss: MinimumLossCheck;
  reporting: ReportingCheck;
}

export interface TraceEntry {
  op: string;
  item_id?: string | null;
  rule_id?: string | null;
  delta_cents?: number;
}

export interface EngineOutput {
  jurisdiction: string;
  law_image_sha256: string;
  lines: EngineLine[];
  totals: EngineTotals;
  checks: EngineChecks;
  info_rule_ids: string[];
  trace: TraceEntry[];
  claim_id?: string;
}

// rules/SCHEMA.md

export type RuleCategory =
  | "exam_no_bill"
  | "exam_payment"
  | "total_cap"
  | "expense_cap"
  | "covered_expense"
  | "excluded_expense"
  | "filing_deadline"
  | "reporting_requirement"
  | "minimum_loss"
  | "collateral_source"
  | "conduct_reduction"
  | "emergency_award"
  | "eligible_crime"
  | "residency"
  | "submission"
  | "required_document"
  | "processing_time"
  | "address_confidentiality"
  | "record_confidentiality";

export interface RuleParams {
  expense?: string;
  item?: string;
  amount_cents?: number;
  per?: string;
  count_limit?: number;
  years?: number;
  days?: number;
  from?: string;
  extension?: string;
  required?: boolean;
  within_days?: number;
  alternatives?: string[] | string;
  days_lost?: number;
  waived_for?: string[] | string;
  insurance_billing?: string;
  payer?: string;
  rule?: string;
  [key: string]: unknown;
}

export interface Rule {
  id: string;
  category: RuleCategory;
  expense?: string | null;
  params?: RuleParams | null;
  summary: string;
  quote: string;
  source_id: string;
  pinpoint: string;
  fragment_url?: string;
}

export interface Source {
  id: string;
  title: string;
  url: string;
  kind: string;
  retrieved_at: string;
  raw_path?: string;
  text_path?: string;
  sha256: string;
}

export interface Program {
  program_name: string;
  agency: string;
  website: string;
  apply_url?: string | null;
  application_pdf_url?: string | null;
  phone?: string | null;
  phone_source_id?: string | null;
  statute_citation?: string | null;
}

export interface Jurisdiction {
  jurisdiction: string;
  name: string;
  program: Program;
  sources: Source[];
  rules: Rule[];
  coverage: { found: string[]; not_found: string[]; notes?: string };
  confidence: "high" | "medium" | "low" | string;
  researcher_notes?: string;
}

export interface JurisdictionSummary {
  st: string;
  name: string;
  rules: number;
  sources: number;
  program?: string | null;
  confidence?: string | null;
  verified_at?: string | null;
  sha256?: string;
}

// API shapes the web app relies on (docs/SPEC.md "API" section).

export interface AccountRef {
  id: string;
  nickname: string;
  mask?: string;
}

export interface ScanItem extends EngineItem {
  merchant?: string;
  confidence?: number;
  source?: "purchase" | "bill" | "deposit" | "receipt" | string;
  bill_id?: string;
}

export interface ScanResult {
  persona_id?: string;
  customer_id?: string;
  st: string;
  incident_date: string;
  as_of_date: string;
  account?: AccountRef;
  read_count?: number;
  items: ScanItem[];
}

export interface BillLine {
  line_no: number;
  item_id: string;
  description: string;
  amount_cents: number;
  expense: ItemExpense;
}

export interface BillAudit {
  bill_id: string;
  provider: string;
  statement_date: string;
  service_date: string;
  account_ref?: string;
  total_cents: number;
  lines: BillLine[];
  lines_sum_cents: number;
  holds: { item_id: string; amount_cents: number; rule_ids: string[] }[];
}

export interface ActionProposal {
  action_id: string;
  amount_cents: number;
  from: string | AccountRef;
  payee: string;
  confirm_code: string;
  expires_at: string;
}

export interface ActionResult {
  action_id: string;
  status: "done" | "failed" | "expired" | "not_sent" | string;
  amount_cents: number;
  nessie_id?: string | null;
  read_back_matches?: boolean | null;
  audit_id?: string | null;
  message?: string;
  at: string;
}

export interface ShareLink {
  token: string;
  url: string;
  expires_at: string;
}

export interface ShareView {
  token: string;
  created_at: string;
  expires_at: string;
  input: EngineInput;
  output: EngineOutput;
  engine?: string;
}
