// Joins scan items with engine lines for display. Money totals come from the engine output; this
// file only groups and labels.
import { expenseRank } from "./expenses";
import type { EngineLine, EngineOutput, LineStatus, ScanItem } from "./types";

export type Answer = "yes" | "no" | "unsure";

export type RowStatus = LineStatus | "declined" | "checking";

export interface Row {
  item: ScanItem;
  line: EngineLine | null;
  answer: Answer | undefined;
  status: RowStatus;
  bed: string;
}

export interface Bed {
  expense: string;
  rows: Row[];
  allowedCents: number;
  heldCents: number;
}

export function buildRows(items: ScanItem[], answers: Record<string, Answer>, output: EngineOutput | null): Row[] {
  const lines = new Map(output?.lines.map((l) => [l.item_id, l]));
  return [...items]
    .sort((a, b) => (a.date === b.date ? a.item_id.localeCompare(b.item_id) : a.date < b.date ? -1 : 1))
    .map((item) => {
      const answer = answers[item.item_id];
      if (answer === "no") return { item, line: null, answer, status: "declined" as const, bed: item.expense };
      const line = lines.get(item.item_id) ?? null;
      return { item, line, answer, status: line?.status ?? "checking", bed: line?.expense ?? item.expense };
    });
}

export function groupBeds(rows: Row[], output: EngineOutput | null): Bed[] {
  const beds = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.status === "out_of_window") continue;
    beds.set(row.bed, [...(beds.get(row.bed) ?? []), row]);
  }
  return [...beds.entries()]
    .map(([expense, list]) => ({
      expense,
      rows: list,
      allowedCents: output?.totals.by_expense[expense as keyof EngineOutput["totals"]["by_expense"]] ?? 0,
      heldCents: list.filter((r) => r.status === "held").reduce((s, r) => s + (r.line?.requested_cents ?? 0), 0),
    }))
    .sort((a, b) => expenseRank(a.expense) - expenseRank(b.expense));
}

export function openQuestions(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === "needs_confirmation");
}

export function earlierRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === "out_of_window");
}

export function notCounted(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === "excluded" || r.status === "unknown_rule");
}
