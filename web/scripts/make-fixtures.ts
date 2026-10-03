// Rebuilds the engine input/output fixtures from the Rowan scan fixture and the verified MI rules.
// usage: npx tsx scripts/make-fixtures.ts
// Outputs come from the preview evaluator, which tests/parity.test.ts holds to the reference engine.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toEngineInput } from "../lib/engine/index";
import { evaluatePreview } from "../lib/engine/preview";
import type { EngineInput, Jurisdiction, ScanResult, ShareView } from "../lib/types";

const web = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(web, p));
const write = (p: string, data: unknown) => writeFileSync(path.join(web, p), JSON.stringify(data, null, 2) + "\n");

const scan = JSON.parse(read("fixtures/rowan-mi.scan.json").toString()) as ScanResult;
const lawBytes = read("public/data/law/MI.json");
const law = JSON.parse(lawBytes.toString()) as Jurisdiction;
const sha = createHash("sha256").update(lawBytes).digest("hex");

const input: EngineInput = toEngineInput({
  jurisdiction: "MI",
  context: { incident_date: scan.incident_date, as_of_date: scan.as_of_date, police_report: "no", forensic_exam: true },
  items: scan.items,
});
write("fixtures/rowan-mi.input.json", input);
write("fixtures/rowan-mi.output.json", evaluatePreview(input, law, sha));

// The advocate view shows the claim after Rowan answered every question with yes.
const answered: EngineInput = {
  ...input,
  items: input.items.map((it) => ({ ...it, confirmed: it.confirmed || it.date >= input.context.incident_date })),
};
const share: ShareView = {
  token: "demo",
  created_at: "2026-10-03T16:20:00Z",
  expires_at: "2026-10-10T16:20:00Z",
  input: answered,
  output: evaluatePreview(answered, law, sha),
  engine: "preview",
};
write("fixtures/share-demo.json", share);
console.log("wrote rowan-mi.input.json, rowan-mi.output.json, share-demo.json");

// Stand-in for `tdis MI.tlaw` until engine/ ships. Rule comments follow the SPEC format.
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);
const pad = (s: string, n: number) => s.padEnd(n);
const comment = (id: string) => {
  const r = law.rules.find((x) => x.id === id)!;
  return `    ; ${pad(r.id, 13)}${pad(clip(r.pinpoint, 24), 29)}"${clip(r.quote, 56)}"`;
};
const byCat = (c: string) => law.rules.filter((r) => r.category === c).map((r) => r.id);
const expenseOf = (id: string) => {
  const r = law.rules.find((x) => x.id === id)!;
  return String(r.expense ?? r.params?.expense ?? "");
};
const listing: string[] = [
  "; tdis stand-in listing (fixture). The real listing comes from engine/ tdis.",
  `; TLAW v1  jurisdiction MI  rules ${law.rules.length}  sources ${law.sources.length}`,
  `; verified json sha256 ${sha}`,
  "",
  ".rules",
  ...law.rules.map((r, i) => `  r${String(i).padStart(2, "0")}  ${pad(r.id, 13)}${pad(r.category, 22)}${r.source_id}`),
  "",
  ".program item",
  "  window:",
  "    LOAD      item.date",
  "    CMP_LT    ctx.incident_date",
  "    JT        out_of_window",
  "    LOAD      item.date",
  "    CMP_GT    ctx.as_of_date",
  "    JT        out_of_window",
  "  exam_hold:",
  ...[...byCat("exam_no_bill"), ...byCat("exam_payment")].map(comment),
  "    EXP_EQ    forensic_exam",
  "    JF        exclusion",
  ...[...byCat("exam_no_bill"), ...byCat("exam_payment")].map((id) => `    PROOF     ${id}`),
  "    EMIT      held",
  "  exclusion:",
  ...byCat("excluded_expense")
    .filter((id) => expenseOf(id))
    .flatMap((id) => [comment(id), `    EXP_EQ    ${expenseOf(id)}`, `    JT_PROOF  excluded, ${id}`]),
  "  coverage:",
  "    COVERS    item.expense",
  "    JF        unknown_rule",
  "    LOAD      item.confirmed",
  "    JF        needs_confirmation",
  "  collateral:",
  ...byCat("collateral_source").slice(0, 1).map(comment),
  "    LOAD      item.amount_cents",
  "    SUB_SAT   item.insurance_paid_cents",
  "    STORE     line.allowed_cents",
  "    EMIT      eligible",
  "",
  ".program aggregate",
  "  caps:",
  ...law.rules
    .filter((r) => r.category === "expense_cap" && typeof r.params?.amount_cents === "number")
    .flatMap((r) => [
      comment(r.id),
      `    ${r.params?.per === "claim" ? "CAP_WALK " : "CAP_RATE "} ${pad(expenseOf(r.id), 16)}${r.params?.amount_cents}  per ${r.params?.per}`,
    ]),
  "  total_cap:",
  ...byCat("total_cap").map(comment),
  ...law.rules.filter((r) => r.category === "total_cap").map((r) => `    CAP_TOTAL ${r.params?.amount_cents}`),
  "  minimum_loss:",
  ...byCat("minimum_loss").map(comment),
  "    MIN_LOSS  20000",
  "  deadline:",
  ...byCat("filing_deadline").map(comment),
  "    DEADLINE  years 5",
  "  reporting:",
  ...byCat("reporting_requirement").map(comment),
  "    REPORT    alt forensic_exam",
  "    HALT",
];
write("fixtures/MI.asm.json", { jurisdiction: "MI", fixture: true, listing });
console.log(`wrote MI.asm.json (${listing.length} lines)`);
