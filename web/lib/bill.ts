// Splits an audited bill into what the law holds and what is left to pay, from the engine output.
// Nothing is payable until the engine has decided every line: before that, a held exam line would
// look like an ordinary charge.
import { sumCents } from "./money";
import type { BillAudit, BillLine, EngineOutput, LineStatus } from "./types";

export interface BillPlan {
  decided: boolean;
  heldLines: BillLine[];
  payLines: BillLine[];
  heldCents: number;
  restCents: number;
  adds: boolean;
  // Every line left to pay is already counted in the claim.
  restClaimed: boolean;
}

export function billPlan(bill: BillAudit, output: EngineOutput | null): BillPlan {
  const status = new Map<string, LineStatus>(output?.lines.map((l) => [l.item_id, l.status]));
  const decided = output !== null && bill.lines.every((l) => status.has(l.item_id));
  const heldLines = decided ? bill.lines.filter((l) => status.get(l.item_id) === "held") : [];
  const payLines = decided ? bill.lines.filter((l) => status.get(l.item_id) !== "held") : [];
  return {
    decided,
    heldLines,
    payLines,
    heldCents: sumCents(heldLines.map((l) => l.amount_cents)),
    restCents: sumCents(payLines.map((l) => l.amount_cents)),
    adds:
      bill.lines_sum_cents === bill.total_cents && sumCents(bill.lines.map((l) => l.amount_cents)) === bill.total_cents,
    restClaimed: payLines.every((l) => status.get(l.item_id) === "eligible"),
  };
}
