// node scripts/laws_index.mjs LAWS_DIR > LAWS_DIR/index.json
// Lists each compiled law image with its rule count and hashes, read through
// the WASM engine's inspect call so the index always matches the images.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const { loadTend } = await import(pathToFileURL(resolve(dir, '..', 'tend_engine.mjs')).href);
const tend = await loadTend();

const laws = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.tlaw')).sort()) {
  const bytes = readFileSync(join(dir, file));
  const info = tend.inspect(new Uint8Array(bytes));
  if (info.error) throw new Error(`${file}: ${info.error.message}`);
  laws.push({
    jurisdiction: info.jurisdiction,
    name: info.meta.name ?? null,
    file,
    bytes: bytes.length,
    rules: info.rules.length,
    sources: info.sources.length,
    law_image_sha256: createHash('sha256').update(bytes).digest('hex'),
    source_sha256: info.source_sha256,
  });
}
process.stdout.write(JSON.stringify({ engine: tend.version(), laws }, null, 1) + '\n');
