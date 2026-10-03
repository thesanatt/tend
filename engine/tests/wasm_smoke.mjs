// node tests/wasm_smoke.mjs OUT_DIR LAW.tlaw CLAIM.json EXPECTED.json
// The WASM engine must produce exactly the bytes the native engine produced.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [outDir, lawPath, claimPath, expectedPath] = process.argv.slice(2);
const { loadTend } = await import(pathToFileURL(resolve(outDir, 'tend_engine.mjs')).href);
const tend = await loadTend();

const image = new Uint8Array(readFileSync(lawPath));
const claim = readFileSync(claimPath, 'utf8');
const expected = readFileSync(expectedPath, 'utf8').replace(/\n$/, '');

const got = tend.evaluateRaw(image, claim);
if (got !== expected) {
  console.error('wasm_smoke: WASM output differs from the native golden output');
  process.exit(1);
}
const listing = tend.disassemble(image);
if (!listing.startsWith('; tend law image ZZ')) {
  console.error('wasm_smoke: unexpected disassembly');
  process.exit(1);
}
const bad = tend.evaluate(image.slice(0, 50), claim);
if (bad.error?.code !== 'bad_image') {
  console.error('wasm_smoke: a truncated image was not rejected');
  process.exit(1);
}
const info = tend.inspect(image);
const t0 = performance.now();
for (let i = 0; i < 200; i++) tend.evaluateRaw(image, claim);
const ms = (performance.now() - t0) / 200;
const items = JSON.parse(claim).items.length;
console.log(`wasm_smoke: ok (${tend.version()}, ${info.rules.length} rules, ${ms.toFixed(3)} ms per ${items}-item claim)`);
