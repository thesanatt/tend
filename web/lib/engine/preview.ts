// In-browser preview of the law engine, following docs/SPEC.md "Law engine semantics" step by step.
// Used only when neither the WebAssembly engine nor the API is reachable; the UI labels it as a preview.
// One ordering choice the spec leaves open: per-unit rate caps apply before per-claim caps, so a
// claim cap never counts dollars a rate cap would remove anyway.
import { addDays, addYears } from "../dates";
import { assertCents } from "../money";
import type {
  EngineChecks,
  EngineInput,
  EngineItem,
  EngineLine,
  EngineOutput,
  Jurisdiction,
  Rule,
  RuleCategory,
  TraceEntry,
} from "../types";

const INFO: RuleCategory[] = [
  "collateral_source",
  "conduct_reduction",
  "emergency_award",
  "eligible_crime",
  "residency",
];
const PER_CLAIM = new Set(["claim", undefined, null, ""]);

function ruleExpense(rule: Rule): string | null {
  if (rule.expense) return rule.expense;
  const p = rule.params?.expense;
  return typeof p === "string" ? p : null;
}

function amountOf(rule: Rule): number | null {
  const a = rule.params?.amount_cents;
  return typeof a === "number" && Number.isSafeInteger(a) ? a : null;
}

function byItemOrder(a: EngineItem, b: EngineItem): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

// Walks lines in order against a cumulative limit: the crossing line is cut, later lines go to zero.
function walkCap(lines: EngineLine[], limit: number, ruleId: string, op: string, trace: TraceEntry[]) {
  let used = 0;
  for (const line of lines) {
    const room = Math.max(0, limit - used);
    if (line.allowed_cents > room) {
      trace.push({ op, item_id: line.item_id, rule_id: ruleId, delta_cents: room - line.allowed_cents });
      line.allowed_cents = room;
      line.cap_rule_id = ruleId;
    } else if (room === 0) {
      line.cap_rule_id = ruleId;
    }
    used += line.allowed_cents;
  }
}

export function evaluatePreview(input: EngineInput, law: Jurisdiction, lawSha256: string): EngineOutput {
  const { incident_date, as_of_date, police_report, forensic_exam } = input.context;
  const rules = law.rules;
  const of = (category: RuleCategory) => rules.filter((r) => r.category === category);
  const ids = (list: Rule[]) => list.map((r) => r.id);
  const trace: TraceEntry[] = [];

  const items = [...input.items].sort(byItemOrder);
  const itemById = new Map(items.map((it) => [it.item_id, it]));
  const noBill = of("exam_no_bill");
  const examPay = of("exam_payment");
  const collateral = of("collateral_source");

  const lines: EngineLine[] = items.map((item) => {
    assertCents(item.amount_cents, `${item.item_id} amount_cents`);
    assertCents(item.insurance_paid_cents ?? 0, `${item.item_id} insurance_paid_cents`);
    const line: EngineLine = {
      item_id: item.item_id,
      expense: item.expense,
      status: "eligible",
      requested_cents: item.amount_cents,
      allowed_cents: 0,
      rule_ids: [],
      cap_rule_id: null,
      flags: [],
    };
    const decide = (status: EngineLine["status"], proof: Rule[], op: string) => {
      line.status = status;
      line.rule_ids = ids(proof);
      trace.push({ op, item_id: item.item_id, rule_id: proof[0]?.id ?? null, delta_cents: 0 });
      return line;
    };

    // 1. window
    if (item.date < incident_date || item.date > as_of_date) return decide("out_of_window", [], "window");

    // 2. exam hold
    let expense = item.expense;
    if (expense === "forensic_exam") {
      if (noBill.length || examPay.length) return decide("held", [...noBill, ...examPay], "hold");
      expense = "medical";
      line.expense = "medical";
      line.flags.push("exam_as_medical");
    }

    // 3. exclusion
    const excluded = rules.filter((r) => r.category === "excluded_expense" && ruleExpense(r) === expense);
    if (excluded.length) return decide("excluded", excluded, "exclude");

    // 4. coverage
    const named = rules.filter(
      (r) => (r.category === "covered_expense" || r.category === "expense_cap") && ruleExpense(r) === expense,
    );
    if (expense === "unknown" || !named.length) return decide("unknown_rule", [], "unknown_rule");

    // 5. confirmation
    if (!item.confirmed) return decide("needs_confirmation", named, "needs_confirmation");

    // 6. eligible, net of collateral sources
    line.status = "eligible";
    line.rule_ids = ids(named);
    line.allowed_cents = item.amount_cents;
    trace.push({ op: "eligible", item_id: item.item_id, rule_id: named[0].id, delta_cents: item.amount_cents });
    if (collateral.length) {
      const paid = item.insurance_paid_cents ?? 0;
      const next = Math.max(0, line.allowed_cents - paid);
      if (next !== line.allowed_cents) {
        trace.push({
          op: "collateral",
          item_id: item.item_id,
          rule_id: collateral[0].id,
          delta_cents: next - line.allowed_cents,
        });
      }
      line.allowed_cents = next;
      line.rule_ids.push(...ids(collateral));
    }
    return line;
  });

  const eligible = lines.filter((l) => l.status === "eligible");
  const caps = of("expense_cap").filter((r) => amountOf(r) !== null && ruleExpense(r));

  // 7a. per-unit caps (week, session, hour, mile, day, or any other non-claim unit)
  for (const cap of caps) {
    if (PER_CLAIM.has(cap.params?.per as string)) continue;
    const rate = amountOf(cap)!;
    for (const line of eligible.filter((l) => l.expense === ruleExpense(cap))) {
      const units = itemById.get(line.item_id)?.units ?? 0;
      if (units > 0) {
        const limit = rate * units;
        if (line.allowed_cents > limit) {
          trace.push({
            op: "rate_cap",
            item_id: line.item_id,
            rule_id: cap.id,
            delta_cents: limit - line.allowed_cents,
          });
          line.allowed_cents = limit;
          line.cap_rule_id = cap.id;
        }
      } else {
        line.flags.push(`rate_unverified:${cap.id}`);
      }
    }
  }

  // 7b. per-claim caps
  for (const cap of caps) {
    if (!PER_CLAIM.has(cap.params?.per as string)) continue;
    const matching = eligible.filter((l) => l.expense === ruleExpense(cap));
    walkCap(matching, amountOf(cap)!, cap.id, "expense_cap", trace);
  }

  // 8. total cap (the smallest one)
  const totalCaps = of("total_cap").filter((r) => amountOf(r) !== null);
  if (totalCaps.length) {
    const cap = totalCaps.reduce((a, b) => (amountOf(b)! < amountOf(a)! ? b : a));
    walkCap(eligible, amountOf(cap)!, cap.id, "total_cap", trace);
  }

  const allowed = eligible.reduce((s, l) => s + l.allowed_cents, 0);
  const requested = eligible.reduce((s, l) => s + l.requested_cents, 0);
  const held = lines.filter((l) => l.status === "held").reduce((s, l) => s + l.requested_cents, 0);
  const byExpense: Record<string, number> = {};
  for (const l of eligible) byExpense[l.expense] = (byExpense[l.expense] ?? 0) + l.allowed_cents;

  // 9. minimum loss
  const mins = of("minimum_loss");
  const minRule = mins.find((r) => amountOf(r) !== null);
  let minimum: EngineChecks["minimum_loss"] = { status: "met", rule_ids: ids(mins) };
  if (minRule) {
    const waivers = Array.isArray(minRule.params?.waived_for) ? minRule.params!.waived_for! : [];
    if (allowed < amountOf(minRule)!) {
      minimum = {
        status: forensic_exam && waivers.includes("sexual_assault") ? "waived" : "not_met",
        rule_ids: ids(mins),
      };
    }
  } else if (mins.length) {
    minimum = { status: "unknown", rule_ids: ids(mins) };
  }
  trace.push({ op: "minimum_loss", item_id: null, rule_id: minRule?.id ?? mins[0]?.id ?? null, delta_cents: 0 });

  // 10. deadline: the longest of the dated rules, listing all
  const deadlines = of("filing_deadline");
  const dates = deadlines.flatMap((r) => {
    const out: string[] = [];
    if (typeof r.params?.years === "number") out.push(addYears(incident_date, r.params.years));
    if (typeof r.params?.days === "number") out.push(addDays(incident_date, r.params.days));
    return out;
  });
  const deadlineDate = dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
  const deadline: EngineChecks["deadline"] = {
    status: deadlineDate === null ? "unknown" : as_of_date <= deadlineDate ? "ok" : "late",
    deadline_date: deadlineDate,
    rule_ids: ids(deadlines),
  };
  trace.push({ op: "deadline", item_id: null, rule_id: deadlines[0]?.id ?? null, delta_cents: 0 });

  // 11. reporting
  const reports = of("reporting_requirement");
  let reporting: EngineChecks["reporting"] = { status: "none", rule_ids: [] };
  if (reports.length) {
    const viaExam = forensic_exam
      ? reports.filter((r) => (r.params?.alternatives ?? []).includes("forensic_exam"))
      : [];
    if (police_report === "yes") reporting = { status: "satisfied", rule_ids: ids(reports) };
    else if (viaExam.length) reporting = { status: "satisfied", rule_ids: ids(viaExam) };
    else if (police_report === "no") reporting = { status: "required", rule_ids: ids(reports) };
    else reporting = { status: "unknown", rule_ids: ids(reports) };
  }
  trace.push({ op: "reporting", item_id: null, rule_id: reporting.rule_ids[0] ?? null, delta_cents: 0 });

  return {
    jurisdiction: input.jurisdiction,
    law_image_sha256: lawSha256,
    lines,
    totals: { requested_cents: requested, allowed_cents: allowed, held_cents: held, by_expense: byExpense },
    checks: { deadline, minimum_loss: minimum, reporting },
    info_rule_ids: rules.filter((r) => INFO.includes(r.category)).map((r) => r.id),
    trace,
  };
}
