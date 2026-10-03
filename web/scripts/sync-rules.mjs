// Copies the verified rules corpus and the law IR summaries into public/data, so the web app and
// its public pages build without the API.
// usage: node scripts/sync-rules.mjs [path/to/rules] [--out DIR]
//   rules default: ../rules, or $TEND_RULES_DIR. Output default: public/data.
//
// Writes:
//   public/data/law/ST.json        byte-for-byte copy of rules/verified/ST.json (its sha256 matches the corpus)
//   public/data/ir/ST.json         rules/ir/ST.json without the program block, plus the IR file's sha256
//   public/data/jurisdictions.json all 51 as {st, name, rules, sources, ..., decision_rules, set_aside}
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outArg = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const rulesDir = path.resolve(args[0] || process.env.TEND_RULES_DIR || path.join(webDir, "..", "rules"));
const verifiedDir = path.join(rulesDir, "verified");
const irDir = path.join(rulesDir, "ir");

if (!existsSync(verifiedDir)) {
  console.error(`No verified rules at ${verifiedDir}. Pass the rules directory as the first argument.`);
  process.exit(1);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const states = JSON.parse(readFileSync(path.join(webDir, "lib", "states.json"), "utf8"));
const outDir = path.resolve(outArg || path.join(webDir, "public", "data"));
const lawDir = path.join(outDir, "law");
const irOut = path.join(outDir, "ir");
mkdirSync(lawDir, { recursive: true });
mkdirSync(irOut, { recursive: true });

// The IR summary keeps what the public law page needs: how each rule compiled, and what was set aside.
function irSummary(raw, verifiedSha) {
  const ir = JSON.parse(raw.toString("utf8"));
  const rules = Array.isArray(ir.rules) ? ir.rules : [];
  const skipped = Array.isArray(ir.skipped) ? ir.skipped : [];
  return {
    ir_version: ir.ir_version ?? null,
    jurisdiction: ir.jurisdiction,
    source_sha256: ir.source_sha256 ?? null,
    ir_sha256: sha256(raw),
    // false when rules/tools/normalize.py has not been rerun since the verified file changed
    fresh: ir.source_sha256 === verifiedSha,
    rules,
    skipped,
  };
}

const summary = [];
let totalRules = 0;
let totalSources = 0;
let verified = 0;
let withIr = 0;
let setAside = 0;
const stale = [];

for (const { st, name } of states) {
  const file = path.join(verifiedDir, `${st}.json`);
  const target = path.join(lawDir, `${st}.json`);
  const irTarget = path.join(irOut, `${st}.json`);
  if (!existsSync(file)) {
    rmSync(target, { force: true });
    rmSync(irTarget, { force: true });
    summary.push({ st, name, rules: 0, sources: 0 });
    continue;
  }
  const raw = readFileSync(file);
  const data = JSON.parse(raw.toString("utf8"));
  const retrieved = (data.sources || [])
    .map((s) => s.retrieved_at)
    .filter(Boolean)
    .sort();
  const entry = {
    st,
    name,
    rules: (data.rules || []).length,
    sources: (data.sources || []).length,
    program: data.program?.program_name ?? null,
    confidence: data.confidence ?? null,
    verified_at: retrieved.at(-1) ?? null,
    sha256: sha256(raw),
  };
  writeFileSync(target, raw);

  const irFile = path.join(irDir, `${st}.json`);
  if (existsSync(irFile)) {
    const ir = irSummary(readFileSync(irFile), entry.sha256);
    writeFileSync(irTarget, JSON.stringify(ir, null, 1) + "\n");
    entry.ir_version = ir.ir_version;
    entry.ir_sha256 = ir.ir_sha256;
    entry.ir_fresh = ir.fresh;
    entry.decision_rules = ir.rules.filter((r) => r.kind !== "info").length;
    entry.info_rules = ir.rules.filter((r) => r.kind === "info").length;
    entry.set_aside = ir.skipped.length;
    withIr += 1;
    setAside += ir.skipped.length;
    if (!ir.fresh) stale.push(st);
  } else {
    rmSync(irTarget, { force: true });
  }

  summary.push(entry);
  totalRules += entry.rules;
  totalSources += entry.sources;
  verified += 1;
}

for (const dir of [lawDir, irOut]) {
  for (const f of readdirSync(dir)) {
    if (!states.some((s) => `${s.st}.json` === f)) rmSync(path.join(dir, f));
  }
}

writeFileSync(path.join(outDir, "jurisdictions.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(`${verified} of ${states.length} jurisdictions verified, ${totalRules} rules, ${totalSources} sources`);
console.log(`${withIr} IR summaries, ${setAside} rules set aside by the normalizer`);
if (stale.length) {
  console.warn(`IR is older than the verified rules for ${stale.join(", ")}: rerun python3 rules/tools/normalize.py`);
}
