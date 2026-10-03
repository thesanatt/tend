// A stand-in law engine for flow tests. It follows the shape of docs/SPEC.md and a small slice of its
// semantics (window, exam hold, a phone exclusion, coverage, confirmation, a counseling rate cap),
// enough to drive screens. Real decisions come only from the WebAssembly or native engine.
import type { Evaluation } from "../engine";
import type { EngineInput, EngineLine, EngineOutput, ItemExpense } from "../types";

const COVERED: ItemExpense[] = [
  "medical",
  "counseling",
  "prescription",
  "transportation",
  "lost_wages",
  "relocation",
  "security",
  "clothing_bedding",
];

export function mockEngineOutput(input: EngineInput): EngineOutput {
  const { context } = input;
  const lines: EngineLine[] = [...input.items]
    .sort((a, b) => (a.date === b.date ? a.item_id.localeCompare(b.item_id) : a.date < b.date ? -1 : 1))
    .map((it) => {
      const tags = (it as { tags?: string[] }).tags ?? [];
      const base = { item_id: it.item_id, expense: it.expense, requested_cents: it.amount_cents, cap_rule_id: null, flags: [] };
      if (it.date < context.incident_date || it.date > context.as_of_date)
        return { ...base, status: "out_of_window" as const, allowed_cents: 0, rule_ids: [] };
      if (it.expense === "forensic_exam")
        return { ...base, status: "held" as const, allowed_cents: 0, rule_ids: ["ZZ-EXAM-1", "ZZ-EXAM-2"] };
      if (it.expense === "property_replacement" && tags.includes("phone"))
        return { ...base, status: "excluded" as const, allowed_cents: 0, rule_ids: ["ZZ-EXCL-1"] };
      if (!COVERED.includes(it.expense))
        return { ...base, status: "unknown_rule" as const, allowed_cents: 0, rule_ids: [] };
      const rule = `ZZ-COV-${it.expense}`;
      if (!it.confirmed) return { ...base, status: "needs_confirmation" as const, allowed_cents: 0, rule_ids: [rule] };
      const capped = it.expense === "counseling" && it.amount_cents > 12500;
      return {
        ...base,
        status: "eligible" as const,
        allowed_cents: capped ? 12500 : it.amount_cents,
        cap_rule_id: capped ? "ZZ-CAP-1" : null,
        rule_ids: [rule],
      };
    });
  const eligible = lines.filter((l) => l.status === "eligible");
  const by_expense: Partial<Record<ItemExpense, number>> = {};
  for (const l of eligible) by_expense[l.expense] = (by_expense[l.expense] ?? 0) + l.allowed_cents;
  const [y, m, d] = context.incident_date.split("-");
  const deadline = `${Number(y) + 5}-${m}-${d}`;
  return {
    jurisdiction: input.jurisdiction,
    law_image_sha256: "0".repeat(64),
    lines,
    totals: {
      requested_cents: eligible.reduce((s, l) => s + l.requested_cents, 0),
      allowed_cents: eligible.reduce((s, l) => s + l.allowed_cents, 0),
      held_cents: lines.filter((l) => l.status === "held").reduce((s, l) => s + l.requested_cents, 0),
      by_expense,
    },
    checks: {
      deadline: {
        status: context.as_of_date <= deadline ? "ok" : "late",
        deadline_date: deadline,
        rule_ids: ["ZZ-FILE-1"],
      },
      minimum_loss: { status: "met", rule_ids: [] },
      reporting: {
        status: context.police_report === "yes" || context.forensic_exam ? "satisfied" : "required",
        rule_ids: ["ZZ-REPORT-1"],
      },
    },
    info_rule_ids: [],
    trace: [],
  };
}

export async function mockEvaluate(input: EngineInput): Promise<Evaluation> {
  return { output: mockEngineOutput(input), backend: "wasm", detail: "mock engine" };
}
