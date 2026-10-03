// In-browser preview of the law engine, following docs/SPEC.md "Law engine semantics" step by step.
// Used only when neither the WebAssembly engine nor the API is reachable; the UI labels it as a preview.
//
// Where the SPEC leaves room it makes the same readings as the Python reference (refengine/README.md,
// "Readings where the SPEC leaves room"), which the C++ VM is held to by difftest, so a claim gives the
// same lines, totals, checks, and trace whichever backend ran it. tests/parity.test.ts replays
// reference outputs for every jurisdiction to keep it that way.
import { addDays, addYears, isIsoDay } from "../dates";
import { EXPENSES } from "../types";
import type {
  EngineChecks,
  EngineInput,
  EngineLine,
  EngineOutput,
  ItemExpense,
  Jurisdiction,
  LineStatus,
  Rule,
  TraceEntry,
} from "../types";

const INFO = new Set(["collateral_source", "conduct_reduction", "emergency_award", "eligible_crime", "residency"]);
const UNIT_PERS = new Set(["week", "session", "hour", "mile", "day"]);
const KNOWN_EXPENSES = new Set<string>(EXPENSES);

interface Item {
  item_id: string;
  date: string;
  amount_cents: number;
  expense: ItemExpense;
  confirmed: boolean;
  insurance_paid_cents: number;
  units: number;
}

interface Cap {
  ruleId: string;
  expense: string | null;
  amount: number;
  per: string;
}

interface Line extends EngineLine {
  item: Item;
}

// rule.expense wins over params.expense; a non-string names nothing.
function ruleExpense(rule: Rule): string | null {
  for (const v of [rule.expense, rule.params?.expense]) if (typeof v === "string" && v) return v;
  return null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function wholeCents(value: unknown, where: string): number {
  const n = count(value);
  if (n === null) throw new Error(`${where} must be whole cents from 0 to 2^53 - 1, got ${String(value)}`);
  return n;
}

// Code point order, which is UTF-8 byte order: what the C++ and Python engines sort by.
function compareIds(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

function parseItems(input: EngineInput): Item[] {
  const seen = new Set<string>();
  let sum = 0;
  const items = (input.items ?? []).map((raw, n) => {
    const where = `items[${n}]`;
    if (typeof raw.item_id !== "string" || !raw.item_id) throw new Error(`${where}.item_id must be a non-empty string`);
    if (seen.has(raw.item_id)) throw new Error(`duplicate item_id ${raw.item_id}`);
    seen.add(raw.item_id);
    if (typeof raw.date !== "string" || !isIsoDay(raw.date)) throw new Error(`${where}.date must be a YYYY-MM-DD date`);
    const item: Item = {
      item_id: raw.item_id,
      date: raw.date,
      amount_cents: wholeCents(raw.amount_cents, `${where}.amount_cents`),
      expense: KNOWN_EXPENSES.has(raw.expense) ? raw.expense : "unknown",
      confirmed: raw.confirmed === true,
      insurance_paid_cents: wholeCents(raw.insurance_paid_cents ?? 0, `${where}.insurance_paid_cents`),
      units: wholeCents(raw.units ?? 0, `${where}.units`),
    };
    sum += item.amount_cents;
    return item;
  });
  if (!Number.isSafeInteger(sum)) throw new Error("the amounts add up to more than 2^53 - 1 cents");
  return items.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : compareIds(a.item_id, b.item_id)));
}

export function evaluatePreview(input: EngineInput, law: Jurisdiction, lawSha256: string): EngineOutput {
  const { incident_date, as_of_date, forensic_exam } = input.context;
  const police_report = input.context.police_report ?? "unknown";
  if (!isIsoDay(incident_date) || !isIsoDay(as_of_date)) throw new Error("context dates must be YYYY-MM-DD");
  const rules = law.rules;
  const params = (r: Rule) => r.params ?? {};
  const ofCategory = (category: string) => rules.filter((r) => r.category === category);
  const ids = (list: Rule[]) => list.map((r) => r.id);

  const holdIds = [...ids(ofCategory("exam_no_bill")), ...ids(ofCategory("exam_payment"))];
  const collateralIds = ids(ofCategory("collateral_source"));
  const excluded = new Map<string, string[]>();
  const coverage = new Map<string, string[]>();
  for (const r of rules) {
    const expense = ruleExpense(r);
    if (!expense) continue;
    const into =
      r.category === "excluded_expense"
        ? excluded
        : r.category === "covered_expense" || r.category === "expense_cap"
          ? coverage
          : null;
    if (into) into.set(expense, [...(into.get(expense) ?? []), r.id]);
  }

  const lineCaps: Cap[] = [];
  const claimCaps: Cap[] = [];
  for (const r of ofCategory("expense_cap")) {
    const expense = ruleExpense(r);
    const amount = count(params(r).amount_cents);
    if (!expense || amount === null) continue;
    const per = typeof params(r).per === "string" ? (params(r).per as string) : "claim";
    (per === "claim" ? claimCaps : lineCaps).push({ ruleId: r.id, expense, amount, per });
  }
  let totalCap: Cap | null = null;
  for (const r of ofCategory("total_cap")) {
    const amount = count(params(r).amount_cents);
    if (amount !== null && (totalCap === null || amount < totalCap.amount)) {
      totalCap = { ruleId: r.id, expense: null, amount, per: "claim" };
    }
  }

  const trace: TraceEntry[] = [];
  const log = (op: string, item_id: string | null, rule_id: string | null, delta_cents = 0) =>
    trace.push({ op, item_id, rule_id, delta_cents });

  // Steps 1-6: the first matching step decides.
  const lines: Line[] = parseItems(input).map((item) => {
    const line: Line = {
      item,
      item_id: item.item_id,
      expense: item.expense,
      status: "eligible",
      requested_cents: item.amount_cents,
      allowed_cents: 0,
      rule_ids: [],
      cap_rule_id: null,
      flags: [],
    };
    const settle = (status: LineStatus, ruleIds: string[], delta = 0) => {
      line.status = status;
      line.rule_ids = [...ruleIds];
      log(status, item.item_id, ruleIds[0] ?? null, delta);
      return line;
    };

    if (item.date < incident_date || item.date > as_of_date) return settle("out_of_window", []);
    if (line.expense === "forensic_exam") {
      if (holdIds.length) return settle("held", holdIds);
      line.expense = "medical";
    }
    const excludedBy = excluded.get(line.expense);
    if (excludedBy) return settle("excluded", excludedBy);
    const coveredBy = coverage.get(line.expense);
    if (!coveredBy) return settle("unknown_rule", []);
    if (!item.confirmed) return settle("needs_confirmation", coveredBy);

    line.allowed_cents = item.amount_cents;
    settle("eligible", [...coveredBy, ...collateralIds], item.amount_cents);
    if (collateralIds.length) {
      const after = Math.max(0, line.allowed_cents - item.insurance_paid_cents);
      if (after !== line.allowed_cents) {
        log("collateral", item.item_id, collateralIds[0], after - line.allowed_cents);
        line.allowed_cents = after;
      }
    }
    return line;
  });

  const eligible = lines.filter((l) => l.status === "eligible");
  const cut = (line: Line, cap: Cap, value: number, op: string) => {
    log(op, line.item_id, cap.ruleId, value - line.allowed_cents);
    line.allowed_cents = value;
    line.cap_rule_id = cap.ruleId;
  };
  // The crossing line is cut to what is left; every later line goes to 0 and records the cap.
  const walk = (subset: Line[], cap: Cap, op: string) => {
    let used = 0;
    let crossed = false;
    for (const line of subset) {
      if (crossed) cut(line, cap, 0, op);
      else if (used + line.allowed_cents > cap.amount) {
        cut(line, cap, cap.amount - used, op);
        crossed = true;
      } else used += line.allowed_cents;
    }
  };

  // 7a. Unit caps, and caps per something the engine cannot measure (residence, month, ...),
  // which flag every line of their expense and cut nothing.
  for (const cap of lineCaps) {
    for (const line of eligible) {
      if (line.expense !== cap.expense) continue;
      if (UNIT_PERS.has(cap.per) && line.item.units > 0) {
        const limit = cap.amount * line.item.units;
        if (line.allowed_cents > limit) cut(line, cap, limit, "unit_cap");
      } else {
        line.flags.push(`rate_unverified:${cap.ruleId}`);
        log("rate_unverified", line.item_id, cap.ruleId);
      }
    }
  }
  // 7b. Claim caps, then 8. the smallest total cap.
  for (const cap of claimCaps)
    walk(
      eligible.filter((l) => l.expense === cap.expense),
      cap,
      "expense_cap",
    );
  if (totalCap) walk(eligible, totalCap, "total_cap");

  const byExpense: Record<string, number> = {};
  for (const l of eligible) byExpense[l.expense] = (byExpense[l.expense] ?? 0) + l.allowed_cents;
  const totals = {
    requested_cents: eligible.reduce((s, l) => s + l.requested_cents, 0),
    allowed_cents: eligible.reduce((s, l) => s + l.allowed_cents, 0),
    held_cents: lines.filter((l) => l.status === "held").reduce((s, l) => s + l.requested_cents, 0),
    by_expense: Object.fromEntries(Object.entries(byExpense).sort(([a], [b]) => (a < b ? -1 : 1))),
  };

  const check = <S extends string>(op: string, list: Rule[], status: S) => {
    log(op, null, list[0]?.id ?? null);
    return { status, rule_ids: ids(list) };
  };

  // 9. Minimum loss: any unwaived shortfall is not_met, else any waived one is waived.
  const minRules = ofCategory("minimum_loss");
  const withAmount = minRules.filter((r) => count(params(r).amount_cents) !== null);
  let minStatus: EngineChecks["minimum_loss"]["status"] = "met";
  if (!withAmount.length) {
    if (minRules.some((r) => count(params(r).days_lost) !== null)) minStatus = "unknown";
  } else {
    for (const r of withAmount) {
      if (totals.allowed_cents >= count(params(r).amount_cents)!) continue;
      const waivedFor = params(r).waived_for as unknown;
      const waivable =
        (typeof waivedFor === "string" && waivedFor.includes("sexual_assault")) ||
        (Array.isArray(waivedFor) && waivedFor.includes("sexual_assault"));
      if (forensic_exam && waivable) minStatus = minStatus === "met" ? "waived" : minStatus;
      else minStatus = "not_met";
    }
  }
  const minimum_loss = check("minimum_loss", minRules, minStatus);

  // 10. Deadline: years win over days on one rule; the latest date wins.
  const deadlineRules = ofCategory("filing_deadline");
  let latest: string | null = null;
  for (const r of deadlineRules) {
    const years = count(params(r).years);
    const days = count(params(r).days);
    const date = years !== null ? addYears(incident_date, years) : days !== null ? addDays(incident_date, days) : null;
    if (date && (latest === null || date > latest)) latest = date;
  }
  const deadlineCheck = check(
    "deadline",
    deadlineRules,
    latest === null ? ("unknown" as const) : as_of_date <= latest ? ("ok" as const) : ("late" as const),
  );

  // 11. Reporting. "No alternative applies" holds only when every listed alternative is the exam,
  // the one the engine can rule out; an advocate or protective order might still apply.
  const reportRules = ofCategory("reporting_requirement");
  let reportStatus: EngineChecks["reporting"]["status"] = "satisfied";
  if (reportRules.length) {
    let examAlt = false;
    let otherAlt = false;
    let required = false;
    for (const r of reportRules) {
      const p = params(r);
      required ||= p.required !== false;
      const alts = p.alternatives as unknown;
      if (typeof alts === "string") {
        examAlt ||= alts.includes("forensic_exam");
        otherAlt ||= alts !== "" && alts !== "forensic_exam";
      } else if (Array.isArray(alts)) {
        for (const alt of alts) {
          examAlt ||= alt === "forensic_exam";
          otherAlt ||= alt !== "forensic_exam";
        }
      }
    }
    if (police_report === "yes" || (forensic_exam && examAlt)) reportStatus = "satisfied";
    else if (police_report === "no" && required && !otherAlt) reportStatus = "required";
    else reportStatus = "unknown";
  }
  const reporting = check("reporting", reportRules, reportStatus);

  return {
    jurisdiction: law.jurisdiction,
    law_image_sha256: lawSha256,
    lines: lines.map((l) => ({
      item_id: l.item_id,
      expense: l.expense,
      status: l.status,
      requested_cents: l.requested_cents,
      allowed_cents: l.allowed_cents,
      rule_ids: l.rule_ids,
      cap_rule_id: l.cap_rule_id,
      flags: l.flags,
    })),
    totals,
    checks: {
      deadline: { status: deadlineCheck.status, deadline_date: latest, rule_ids: deadlineCheck.rule_ids },
      minimum_loss,
      reporting,
    },
    info_rule_ids: rules.filter((r) => INFO.has(r.category)).map((r) => r.id),
    trace,
  };
}
