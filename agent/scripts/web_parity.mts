// Runs the Tend app's own packet code (web/lib/packet, web/lib/share) on the agent's demo claim, so the agent's
// Python port can be checked against it (tests/test_packet_share.py).
//
//   cd web && npx tsx ../agent/scripts/web_parity.mts
//
// Writes agent/tests/fixtures/web_packet_parity.json: for each jurisdiction, the still-needed list and filing
// routes the app computes, with the sha256 of the verified rules it read. It also seals nothing and sends nothing.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LawBook } from "../../web/lib/packet/law";
import { stillNeeded } from "../../web/lib/packet/checklist";
import { filingRoutes } from "../../web/lib/packet/filing";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "tests", "fixtures");
const rules = path.join(here, "..", "..", "rules", "verified");
const scan = JSON.parse(readFileSync(path.join(fixtures, "scan_rowan_mi.json"), "utf8"));
const audit = JSON.parse(readFileSync(path.join(fixtures, "audit_rowan_mi.json"), "utf8"));
const output = JSON.parse(readFileSync(path.join(fixtures, "claim_rowan_mi.json"), "utf8"));
// The same input the agent builds (demo.confirmed_input): every cost confirmed, the bill read line by line.
const items = [
  ...scan.engine_input.items.filter((i: { is_bill?: boolean }) => !i.is_bill),
  ...audit.engine_items,
].map((i: object) => ({ ...i, confirmed: true }));
const input = { ...scan.engine_input, items };

const states: Record<string, unknown> = {};
for (const file of readdirSync(rules).filter((f) => f.endsWith(".json")).sort()) {
  const st = file.slice(0, -5);
  const raw = readFileSync(path.join(rules, file));
  const book = new LawBook(JSON.parse(raw.toString("utf8")));
  states[st] = {
    rules_sha256: createHash("sha256").update(raw).digest("hex"),
    needed: stillNeeded(book, { ...input, jurisdiction: st }, { ...output, jurisdiction: st }).map((i) => [i.rule_id, i.have_it, i.document]),
    filing: filingRoutes(book).map((r) => [r.method, r.rule_id]),
  };
}
writeFileSync(path.join(fixtures, "web_packet_parity.json"), JSON.stringify(states, null, 1) + "\n");
console.log(`wrote tests/fixtures/web_packet_parity.json (${Object.keys(states).length} jurisdictions)`);
