// node scripts/wasm_bench.mjs ENGINE_DIR LAW.tlaw [ITEMS] [RUNS]
// End-to-end throughput of the WASM engine (claim JSON in, result JSON out).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, lawPath, itemsArg = '200000', runsArg = '5'] = process.argv.slice(2);
const { loadTend } = await import(pathToFileURL(resolve(dir, 'tend_engine.mjs')).href);
const tend = await loadTend();
const image = new Uint8Array(readFileSync(lawPath));
const n = Number(itemsArg);
const jurisdiction = tend.inspect(image).jurisdiction;

// Same mix as tendvm bench: dates in order, mostly in the window.
const mix = ['medical', 'medical', 'medical', 'medical', 'counseling', 'counseling', 'counseling', 'counseling',
  'lost_wages', 'lost_wages', 'transportation', 'transportation', 'relocation', 'forensic_exam',
  'property_replacement', 'prescription', 'security', 'other', 'dental', 'unknown'];
let x = 1n;
const rnd = () => {
  x = (x * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  return Number(x >> 33n);
};
const start = Date.UTC(2026, 5, 14) / 86400000 - 3;
const span = 117;
const items = [];
for (let i = 0; i < n; i++) {
  const day = new Date((start + Math.floor((i * span) / n)) * 86400000).toISOString().slice(0, 10);
  const amount = 1000 + (rnd() % 400000);
  items.push({
    item_id: `bench:${String(i).padStart(8, '0')}`, date: day, amount_cents: amount, expense: mix[rnd() % 20],
    confirmed: rnd() % 10 !== 0, insurance_paid_cents: rnd() % 5 === 0 ? Math.floor(amount / 4) : 0,
    is_bill: rnd() % 3 === 0, units: rnd() % 4 === 0 ? 0 : 1 + (rnd() % 8),
  });
}
const claim = JSON.stringify({
  jurisdiction, context: { incident_date: '2026-06-14', as_of_date: '2026-10-03', police_report: 'no', forensic_exam: true }, items,
});
const times = [];
let outLen = 0;
for (let r = 0; r < Number(runsArg); r++) {
  const t0 = performance.now();
  outLen = tend.evaluateRaw(image, claim).length;
  times.push((performance.now() - t0) / 1000);
}
times.sort((a, b) => a - b);
const best = times[0], median = times[Math.floor(times.length / 2)];
console.log(`wasm ${tend.version()} law ${jurisdiction}: ${n} items, best ${best.toFixed(3)} s (${(n / best / 1e6).toFixed(2)} M items/s), ` +
  `median ${median.toFixed(3)} s, in ${(claim.length / 1e6).toFixed(1)} MB, out ${(outLen / 1e6).toFixed(1)} MB`);
