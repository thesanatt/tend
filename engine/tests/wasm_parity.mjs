// node tests/wasm_parity.mjs CORPUS_DIR [ENGINE_DIR]
// Runs every claim the difftest saved (refengine/difftest.py --corpus CORPUS_DIR) through the
// WebAssembly engine and checks that each result has the same sha256 as the native engine's.
// When ENGINE_DIR/laws holds the shipped image for a jurisdiction, it must also be the very
// image the difftest compiled.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [corpusDir, engineDir = resolve(import.meta.dirname, '..', '..', 'web', 'public', 'engine')] = process.argv.slice(2);
if (!corpusDir) {
  console.error('usage: node tests/wasm_parity.mjs CORPUS_DIR [ENGINE_DIR]');
  process.exit(2);
}
const { loadTend } = await import(pathToFileURL(resolve(engineDir, 'tend_engine.mjs')).href);
const tend = await loadTend();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let claims = 0, same = 0, laws = 0, shipped = 0;
const problems = [];
const t0 = performance.now();
for (const file of readdirSync(corpusDir).filter((f) => f.endsWith('.jsonl')).sort()) {
  const code = file.slice(0, -'.jsonl'.length);
  const image = new Uint8Array(readFileSync(join(corpusDir, 'laws', `${code}.tlaw`)));
  laws++;
  const shippedPath = join(engineDir, 'laws', `${code}.tlaw`);
  if (existsSync(shippedPath)) {
    shipped++;
    if (sha(readFileSync(shippedPath)) !== sha(image)) problems.push(`${code}: the shipped image differs from the one tested`);
  }
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    claims++;
    const out = tend.evaluateBytes(image, Buffer.from(entry.input, 'base64'));
    if (sha(out) === entry.sha256) same++;
    else if (problems.length < 20) problems.push(`${code} claim ${entry.index}: WASM result differs from native`);
  }
}
const seconds = (performance.now() - t0) / 1000;
for (const p of problems) console.error(`wasm_parity: ${p}`);
console.log(`wasm_parity: ${same} of ${claims} claims byte-identical to native across ${laws} laws ` +
  `(${shipped} shipped images checked) in ${seconds.toFixed(1)} s, ${tend.version()}`);
process.exit(problems.length ? 1 : 0);
