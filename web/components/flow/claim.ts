// Pure joins between the flow state and the law engine. Money totals always come from the engine
// output; this file only decides what goes in and how lines are grouped and labeled.
import { sumCents } from "@/lib/money";
import type { EngineInput, EngineLine, EngineOutput, ItemExpense, LineStatus, PoliceReport } from "@/lib/types";
import type { BillRecord, FlowItem, FlowState, PoliceAnswer, YesNoUnsure } from "./state";

export function policeForEngine(answer: PoliceAnswer | null): PoliceReport {
  if (answer === "yes") return "yes";
  if (answer === "no" || answer === "not_yet") return "no";
  return "unknown";
}

// A direct match starts checked; an inferred line waits for an answer.
export function effectiveAnswer(state: Pick<FlowState, "answers">, item: FlowItem): YesNoUnsure | undefined {
  return state.answers[item.item_id] ?? (item.confirmed ? "yes" : undefined);
}

export function replacedIds(bills: BillRecord[]): Set<string> {
  return new Set(bills.map((b) => b.replaces).filter((id): id is string => Boolean(id)));
}

// The date the engine counts from. Without a date, every gathered cost counts from the earliest one,
// and the screens never show a deadline date computed from that stand-in.
export function countingDate(state: FlowState, asOf: string): string {
  const { date, dateUnsure } = state.check;
  if (date && !dateUnsure) return date;
  const dates = state.items.map((i) => i.date).filter((d) => d <= asOf);
  return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : asOf;
}

export function knowsDate(state: FlowState): boolean {
  return Boolean(state.check.date) && !state.check.dateUnsure;
}

export function buildEngineInput(state: FlowState, asOf: string): EngineInput | null {
  if (!state.check.st) return null;
  const replaced = replacedIds(state.bills);
  const items = state.items
    .filter((it) => !replaced.has(it.item_id))
    .filter((it) => effectiveAnswer(state, it) !== "no")
    .map((it) => ({
      item_id: it.item_id,
      date: it.date,
      amount_cents: it.amount_cents,
      expense: it.expense,
      confirmed: effectiveAnswer(state, it) === "yes",
      insurance_paid_cents: it.insurance_paid_cents ?? 0,
      is_bill: it.is_bill,
      units: it.units ?? 0,
      unit: it.unit ?? null,
      tags: it.tags ?? [],
      description: it.description.slice(0, 200),
    }));
  return {
    jurisdiction: state.check.st,
    context: {
      incident_date: countingDate(state, asOf),
      as_of_date: asOf,
      police_report: policeForEngine(state.check.police),
      forensic_exam: state.check.exam === "yes",
    },
    items,
  };
}

// The five groups from docs/UX.md, plus one for anything else.
export type Group = "care" | "counseling" | "travel" | "home" | "work" | "other";
export const GROUPS: Group[] = ["care", "counseling", "travel", "home", "work", "other"];

const GROUP_OF: Partial<Record<ItemExpense, Group>> = {
  medical: "care",
  forensic_exam: "care",
  prescription: "care",
  dental: "care",
  counseling: "counseling",
  transportation: "travel",
  relocation: "home",
  temporary_housing: "home",
  security: "home",
  crime_scene_cleanup: "home",
  clothing_bedding: "home",
  property_replacement: "home",
  lost_wages: "work",
  childcare: "work",
};

export function groupOf(expense: string): Group {
  return GROUP_OF[expense as ItemExpense] ?? "other";
}

export type RowStatus = LineStatus | "declined" | "checking" | "replaced";

export interface Row {
  item: FlowItem;
  line: EngineLine | null;
  answer: YesNoUnsure | undefined;
  status: RowStatus;
  // A direct match is pre-checked; an inferred line is a question.
  kind: "direct" | "inferred";
  group: Group;
}

export function buildRows(state: FlowState, output: EngineOutput | null): Row[] {
  const lines = new Map(output?.lines.map((l) => [l.item_id, l]));
  const replaced = replacedIds(state.bills);
  return [...state.items]
    .sort((a, b) => (a.date === b.date ? a.item_id.localeCompare(b.item_id) : a.date < b.date ? -1 : 1))
    .map((item) => {
      const answer = effectiveAnswer(state, item);
      const kind = item.confirmed ? "direct" : "inferred";
      const group = groupOf(item.expense);
      if (replaced.has(item.item_id)) return { item, line: null, answer, status: "replaced" as const, kind, group };
      if (answer === "no") return { item, line: null, answer, status: "declined" as const, kind, group };
      const line = lines.get(item.item_id) ?? null;
      return { item, line, answer, status: line?.status ?? ("checking" as const), kind, group: groupOf(line?.expense ?? item.expense) };
    });
}

export interface GroupView {
  group: Group;
  rows: Row[];
  allowedCents: number;
  heldCents: number;
  // Unanswered inferred lines of one kind of cost, offered as "Confirm all".
  batch: { expense: string; ids: string[] } | null;
}

const SHOWN: RowStatus[] = ["eligible", "needs_confirmation", "held", "declined", "checking"];

export function groupRows(rows: Row[]): GroupView[] {
  return GROUPS.map((group) => {
    const inGroup = rows.filter((r) => r.group === group && SHOWN.includes(r.status));
    const open = inGroup.filter((r) => r.kind === "inferred" && r.answer === undefined && r.status !== "held");
    const byExpense = new Map<string, string[]>();
    for (const r of open) byExpense.set(r.item.expense, [...(byExpense.get(r.item.expense) ?? []), r.item.item_id]);
    const [expense, ids] = [...byExpense.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? ["", []];
    return {
      group,
      rows: inGroup,
      allowedCents: sumCents(inGroup.map((r) => (r.status === "eligible" ? (r.line?.allowed_cents ?? 0) : 0))),
      heldCents: sumCents(inGroup.map((r) => (r.status === "held" ? (r.line?.requested_cents ?? 0) : 0))),
      batch: ids.length >= 2 ? { expense, ids } : null,
    };
  }).filter((g) => g.rows.length > 0);
}

export const notCovered = (rows: Row[]) => rows.filter((r) => r.status === "excluded" || r.status === "unknown_rule");
export const beforeDate = (rows: Row[]) => rows.filter((r) => r.status === "out_of_window");
export const questions = (rows: Row[]) =>
  rows.filter((r) => r.status === "needs_confirmation" && r.answer !== "unsure");

export interface BillPlan {
  decided: boolean;
  held: FlowItem[];
  rest: FlowItem[];
  heldCents: number;
  restCents: number;
  // Lines of the rest the program can repay, paid or not.
  repayable: FlowItem[];
  heldRuleIds: string[];
}

export function billItems(state: FlowState, bill: BillRecord): FlowItem[] {
  return state.items.filter((i) => i.origin === "bill" && i.bill_id === bill.id);
}

// Nothing is payable until the engine has decided every line: before that, a held exam line would
// look like an ordinary charge.
export function billPlan(state: FlowState, bill: BillRecord, output: EngineOutput | null): BillPlan {
  const items = billItems(state, bill);
  const lines = new Map(output?.lines.map((l) => [l.item_id, l]));
  const decided = output !== null && items.length > 0 && items.every((i) => lines.has(i.item_id));
  const held = decided ? items.filter((i) => lines.get(i.item_id)?.status === "held") : [];
  const rest = decided ? items.filter((i) => lines.get(i.item_id)?.status !== "held") : [];
  return {
    decided,
    held,
    rest,
    heldCents: sumCents(held.map((i) => i.amount_cents)),
    restCents: sumCents(rest.map((i) => i.amount_cents)),
    repayable: rest.filter((i) => lines.get(i.item_id)?.status === "eligible"),
    heldRuleIds: [...new Set(held.flatMap((i) => lines.get(i.item_id)?.rule_ids ?? []))],
  };
}

export type Stage = "sprout" | "leaf" | "bud" | "bloom";

export interface PlantView {
  item: FlowItem;
  line: EngineLine;
  stage: Stage;
}

// One plant per claim line the program can pay. Stage is real status (docs/UX.md, Track).
export function plants(state: FlowState, output: EngineOutput | null): PlantView[] {
  if (!output) return [];
  const items = new Map(state.items.map((i) => [i.item_id, i]));
  return output.lines
    .filter((l) => l.status === "eligible" && l.allowed_cents > 0 && items.has(l.item_id))
    .map((line) => {
      const life = state.life[line.item_id];
      const stage: Stage = life?.paid_at
        ? "bloom"
        : life?.filed_at || state.filed_at
          ? "bud"
          : life?.doc
            ? "leaf"
            : "sprout";
      return { item: items.get(line.item_id)!, line, stage };
    });
}
