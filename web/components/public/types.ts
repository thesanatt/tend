// Shapes of the files scripts/sync-rules.mjs and scripts/build-asm.mjs write to public/data.

// public/data/ir/ST.json: rules/ir/ST.json (docs/SPEC.md v1.1 and v1.2) without the program block.
export interface IrRule {
  id: string;
  kind: string;
  category?: string;
  expense?: string;
  cap_cents?: number;
  per?: string;
  unit?: string;
  count_limit?: number;
  alt_rule_ids?: string[];
  tags?: string[];
  days?: number;
  from?: string;
  required?: boolean;
  alternatives?: string[];
  within_days?: number;
  waiver?: string;
  waiver_for_sexual_assault?: boolean;
  days_lost?: number;
  [key: string]: unknown;
}

export interface IrSkip {
  id: string;
  category?: string;
  reason: string;
}

export interface IrSummary {
  ir_version: number | null;
  jurisdiction: string;
  source_sha256: string | null;
  ir_sha256: string;
  fresh: boolean;
  rules: IrRule[];
  skipped: IrSkip[];
}

// public/data/asm/index.json, one entry per jurisdiction.
export interface AsmEntry {
  via: "tdis" | "api";
  image_dir?: string;
  engine?: string | null;
  image_bytes?: number | null;
  ir_fresh: boolean | null;
  ir_sha256?: string | null;
  format: string | null;
  compiler: string | null;
  image_sha256: string | null;
  rules_sha256: string | null;
  rules_fresh: boolean;
  kind_changes: string[] | null;
  lines: number;
  bytes: number;
  sha256: string;
  generated_at: string;
}

export interface Asm {
  text: string;
  meta: AsmEntry | null;
}
