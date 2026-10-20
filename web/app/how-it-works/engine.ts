// Sizes of the files a browser downloads to run the law, read when the site is built. Shared with /sources.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const ENGINE = path.join(process.cwd(), "public", "engine");

// tend.wasm holds the loader, the verifier, and the VM; the compiler is not in it. 1 KB is 1,000 bytes.
export function engineKb(): number | null {
  try {
    return Math.floor(statSync(path.join(ENGINE, "tend.wasm")).size / 1000);
  } catch {
    return null;
  }
}

// The smallest and largest compiled law (laws/ST.tlaw), widened to whole KB so every file falls inside.
export function lawKbRange(): { lo: number; hi: number } | null {
  try {
    const dir = path.join(ENGINE, "laws");
    const sizes = readdirSync(dir)
      .filter((name) => /^[A-Z]{2}\.tlaw$/.test(name))
      .map((name) => statSync(path.join(dir, name)).size);
    if (!sizes.length) return null;
    return { lo: Math.floor(Math.min(...sizes) / 1000), hi: Math.ceil(Math.max(...sizes) / 1000) };
  } catch {
    return null;
  }
}
