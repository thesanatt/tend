// Prints Rowan's claim under every verified state, all guesses confirmed. For checking the data.
// usage: npx tsx scripts/compare-states.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluatePreview } from "../lib/engine/preview";
import { formatCents } from "../lib/money";
import type { EngineInput, Jurisdiction } from "../lib/types";

const web = path.resolve(import.meta.dirname, "..");
const input = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.input.json"), "utf8")) as EngineInput;
const all = { ...input, items: input.items.map((i) => ({ ...i, confirmed: true })) };
const list = JSON.parse(readFileSync(path.join(web, "public/data/jurisdictions.json"), "utf8")) as { st: string }[];

for (const { st } of list) {
  const law = JSON.parse(readFileSync(path.join(web, "public/data/law", `${st}.json`), "utf8")) as Jurisdiction;
  const out = evaluatePreview({ ...all, jurisdiction: st }, law, "");
  const count = (s: string) => out.lines.filter((l) => l.status === s).length;
  console.log(
    `${st}  ask ${formatCents(out.totals.allowed_cents).padStart(10)}  held ${formatCents(out.totals.held_cents).padStart(8)}` +
      `  eligible ${count("eligible")}  excluded ${count("excluded")}  not named ${count("unknown_rule")}` +
      `  deadline ${out.checks.deadline.deadline_date ?? "none"}  min ${out.checks.minimum_loss.status}` +
      `  report ${out.checks.reporting.status}`,
  );
}
