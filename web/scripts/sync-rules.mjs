// Copies the verified rules corpus into public/data so the web app can run without the API.
// usage: node scripts/sync-rules.mjs [path/to/rules]   (default: ../rules, or $TEND_RULES_DIR)
//
// Writes public/data/jurisdictions.json (all 51, {st, name, rules, sources, ...}) and a byte-for-byte
// copy of each rules/verified/ST.json to public/data/law/ST.json, so its sha256 matches the corpus.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rulesDir = path.resolve(process.argv[2] || process.env.TEND_RULES_DIR || path.join(webDir, "..", "rules"));
const verifiedDir = path.join(rulesDir, "verified");

if (!existsSync(verifiedDir)) {
  console.error(`No verified rules at ${verifiedDir}. Pass the rules directory as the first argument.`);
  process.exit(1);
}

const states = JSON.parse(readFileSync(path.join(webDir, "lib", "states.json"), "utf8"));
const outDir = path.join(webDir, "public", "data");
const lawDir = path.join(outDir, "law");
mkdirSync(lawDir, { recursive: true });

const summary = [];
let totalRules = 0;
let totalSources = 0;
let verified = 0;

for (const { st, name } of states) {
  const file = path.join(verifiedDir, `${st}.json`);
  const target = path.join(lawDir, `${st}.json`);
  if (!existsSync(file)) {
    rmSync(target, { force: true });
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
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
  writeFileSync(target, raw);
  summary.push(entry);
  totalRules += entry.rules;
  totalSources += entry.sources;
  verified += 1;
}

for (const f of readdirSync(lawDir)) {
  if (!states.some((s) => `${s.st}.json` === f)) rmSync(path.join(lawDir, f));
}

writeFileSync(path.join(outDir, "jurisdictions.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(`${verified} of ${states.length} jurisdictions verified, ${totalRules} rules, ${totalSources} sources`);
