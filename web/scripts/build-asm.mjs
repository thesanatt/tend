// Writes the compiled law listing for each jurisdiction to public/data/asm/ST.txt, plus
// public/data/asm/index.json, so the "How Tend decides" pages render it at build time.
//
// usage: node scripts/build-asm.mjs [--tdis PATH] [--laws DIR] [--api URL] [--only MI,NY] [--strict] [--quiet]
//                                    [--data DIR]   (default public/data; listings go to DIR/asm)
//
// Per jurisdiction, the first that works:
//   1. tdis on the law image. tdis: --tdis, $TEND_TDIS, or ../engine/build/tdis. Image: --laws or
//      $TEND_LAWS_DIR, else public/engine/laws/ST.tlaw, else ../engine/build/laws/ST.tlaw.
//   2. the API, when tdis is absent: GET <api>/api/jurisdictions/ST/asm (--api or $TEND_API_URL).
//   3. the listing already in public/data/asm, kept as it is.
// It never fails a build unless --strict is given and a listing is missing.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(webDir, "..");

export function parseArgs(argv) {
  const opts = { tdis: null, laws: null, api: null, only: null, data: null, strict: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") opts.strict = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (["--tdis", "--laws", "--api", "--only", "--data"].includes(a) && i + 1 < argv.length) {
      opts[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The listing opens with comment lines: jurisdiction, format and compiler, the sha256 of the
// verified rules it was compiled from, the image sha256, and counts.
export function parseHeader(text) {
  const head = {};
  for (const line of text.split("\n").slice(0, 12)) {
    if (!line.startsWith(";")) break;
    const body = line.slice(1).trim();
    let m;
    if ((m = body.match(/^format ([\d.]+), compiled by (.+)$/))) {
      head.format = m[1];
      head.compiler = m[2];
    } else if ((m = body.match(/^source sha256\s+([0-9a-f]{64})$/))) head.rules_sha256 = m[1];
    else if ((m = body.match(/^image sha256\s+([0-9a-f]{64})$/))) head.image_sha256 = m[1];
    else if ((m = body.match(/^(\d+) rules, (\d+) sources/))) {
      head.rules = Number(m[1]);
      head.sources = Number(m[2]);
    }
  }
  return head;
}

// The .rules table names how the compiler treated each rule:
//   R6    MI-CAP-3    expense_cap   counseling   per session   MCL 18.361(6)
export function listedKinds(text) {
  const kinds = new Map();
  let inRules = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(".")) {
      inRules = line.trim() === ".rules";
      continue;
    }
    const m = inRules && line.match(/^\s+R\d+\s+(\S+)\s+(\S+)/);
    if (m) kinds.set(m[1], m[2]);
  }
  return kinds;
}

// Rules whose kind in the listing differs from the current IR (set-aside rules count as "skipped").
export function kindChanges(text, ir) {
  if (!ir) return null;
  const listed = listedKinds(text);
  const now = new Map([...ir.rules.map((r) => [r.id, r.kind]), ...ir.skipped.map((s) => [s.id, "skipped"])]);
  const ids = new Set([...listed.keys(), ...now.keys()]);
  return [...ids].filter((id) => listed.get(id) !== now.get(id)).sort();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function fromApi(api, st) {
  const res = await fetch(`${api}/api/jurisdictions/${st}/asm`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body?.listing !== "string" || !body.listing.trim()) throw new Error("no listing in the response");
  return body;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (...a) => opts.quiet || console.log(...a);
  const dataDir = path.resolve(opts.data || path.join(webDir, "public", "data"));
  const outDir = path.join(dataDir, "asm");
  const states = JSON.parse(readFileSync(path.join(webDir, "lib", "states.json"), "utf8")).map((s) => s.st);
  const only = opts.only
    ? new Set(
        opts.only
          .toUpperCase()
          .split(/[\s,]+/)
          .filter(Boolean),
      )
    : null;

  const tdis = path.resolve(opts.tdis || process.env.TEND_TDIS || path.join(repoDir, "engine", "build", "tdis"));
  const haveTdis = existsSync(tdis) && executable(tdis);
  const lawDirs = [
    opts.laws || process.env.TEND_LAWS_DIR,
    path.join(webDir, "public", "engine", "laws"),
    path.join(repoDir, "engine", "build", "laws"),
  ].filter(Boolean);
  const api = (opts.api || process.env.TEND_API_URL || "").replace(/\/$/, "") || null;
  let apiUp = Boolean(api);

  mkdirSync(outDir, { recursive: true });
  const indexFile = path.join(outDir, "index.json");
  const previous = readJson(indexFile, { states: {} }).states ?? {};
  const index = {};
  const counts = { tdis: 0, api: 0, kept: 0, missing: 0 };
  const missing = [];
  const lawShas = new Map(readJson(path.join(dataDir, "jurisdictions.json"), []).map((j) => [j.st, j.sha256]));

  for (const st of states) {
    const target = path.join(outDir, `${st}.txt`);
    const lawSha = lawShas.get(st);
    const ir = readJson(path.join(dataDir, "ir", `${st}.json`), null);
    if (only && !only.has(st)) {
      if (previous[st]) index[st] = previous[st];
      continue;
    }

    let text = null;
    let entry = null;
    const image = lawDirs.map((d) => path.join(d, `${st}.tlaw`)).find((f) => existsSync(f));

    if (haveTdis && image) {
      try {
        const bytes = readFileSync(image);
        text = execFileSync(tdis, [image], { encoding: "utf8", maxBuffer: 64 << 20 });
        const rel = path.relative(repoDir, path.dirname(image));
        entry = {
          via: "tdis",
          // Only repo paths are recorded; a path outside the repo would leak this machine's layout.
          image_dir: rel.startsWith("..") || path.isAbsolute(rel) ? "outside the repository" : rel,
          image_bytes: bytes.length,
          // The compiler writes the IR's sha256 into the image's META section.
          ir_fresh: ir?.ir_sha256 ? bytes.includes(Buffer.from(ir.ir_sha256)) : null,
          ir_sha256: ir?.ir_sha256 ?? null,
        };
      } catch (err) {
        log(`${st}: tdis failed (${String(err.message).split("\n")[0]})`);
        text = null;
      }
    }

    if (!text && !haveTdis && apiUp) {
      try {
        const body = await fromApi(api, st);
        text = body.listing.endsWith("\n") ? body.listing : `${body.listing}\n`;
        entry = {
          via: "api",
          engine: body.engine_version ?? null,
          image_bytes: body.image_bytes ?? null,
          ir_fresh: null,
        };
      } catch (err) {
        log(`${st}: API listing unavailable (${err.message})`);
        // A refused connection will not recover for the next state.
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(String(err.cause?.code ?? err.message))) apiUp = false;
      }
    }

    if (text) {
      const head = parseHeader(text);
      const old = previous[st];
      const textSha = sha256(text);
      index[st] = {
        ...entry,
        format: head.format ?? null,
        compiler: head.compiler ?? null,
        image_sha256: head.image_sha256 ?? null,
        rules_sha256: head.rules_sha256 ?? null,
        rules_fresh: Boolean(lawSha && head.rules_sha256 === lawSha),
        kind_changes: kindChanges(text, ir),
        lines: text.split("\n").length - 1,
        bytes: Buffer.byteLength(text),
        sha256: textSha,
        // Unchanged listings keep their date, so a rerun leaves the tree clean.
        generated_at: old?.sha256 === textSha && old.generated_at ? old.generated_at : new Date().toISOString(),
      };
      writeFileSync(target, text);
      counts[entry.via] += 1;
    } else if (existsSync(target) && previous[st]) {
      const kept = readFileSync(target, "utf8");
      const head = parseHeader(kept);
      index[st] = {
        ...previous[st],
        via: previous[st].via,
        // Fresh only while the IR is the one the image was checked against.
        ir_fresh: previous[st].ir_fresh === true && previous[st].ir_sha256 === ir?.ir_sha256,
        rules_fresh: Boolean(lawSha && head.rules_sha256 === lawSha),
        kind_changes: kindChanges(kept, ir),
      };
      counts.kept += 1;
    } else {
      counts.missing += 1;
      missing.push(st);
    }
  }

  const ordered = Object.fromEntries(
    Object.keys(index)
      .sort()
      .map((k) => [k, index[k]]),
  );
  writeFileSync(indexFile, JSON.stringify({ states: ordered }, null, 1) + "\n");
  // The summary prints even with --quiet, so a build log shows where the listings came from.
  console.log(
    `build-asm: ${counts.tdis} listings from tdis, ${counts.api} from the API, ${counts.kept} kept, ` +
      `${counts.missing} missing` +
      (!haveTdis
        ? ` (no tdis at ${path.relative(repoDir, tdis) || tdis})`
        : counts.tdis === 0
          ? " (tdis is here, but no law images were found)"
          : ""),
  );
  if (missing.length) console.log(`build-asm: missing ${missing.join(", ")}`);
  if (opts.strict && missing.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`build-asm: ${err.message}`);
    process.exit(process.argv.includes("--strict") ? 1 : 0);
  });
}
