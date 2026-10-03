// The WebAssembly law engine in Node, through the browser's own loader class (lib/engine/wasm.ts).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WasmEngine, type TendFactory } from "../lib/engine/wasm";

// tsx can hand back the ES module default wrapped once more, so unwrap it before calling.
export async function nodeEngine(dir: string): Promise<WasmEngine> {
  const imported = (await import(pathToFileURL(path.join(dir, "tend.js")).href)) as { default: unknown };
  const inner = imported.default as TendFactory | { default: TendFactory };
  const factory = typeof inner === "function" ? inner : inner.default;
  const mod = await factory({ locateFile: (file) => path.join(dir, file) });
  return new WasmEngine(mod, dir, fetch);
}
