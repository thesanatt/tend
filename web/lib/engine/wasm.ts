// Loads the Emscripten build of the law engine from /engine/tend.js when it exists.
//
// Contract with engine/ (docs/SPEC.md C ABI):
//   web/public/engine/tend.js + tend.wasm, built with -sMODULARIZE=1 -sEXPORT_NAME=createTendModule
//   (an ES module build with -sEXPORT_ES6=1 works too), exporting
//   _tend_eval_json, _tend_disasm, _tend_version, _tend_free, _malloc, _free, and HEAPU8.
//   Law images live at web/public/engine/laws/<ST>.tlaw.
// Strings go through the heap, not ccall's stack, so large claims cannot overflow the wasm stack.
import type { EngineInput, EngineOutput } from "../types";

export interface TendModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _tend_eval_json(img: number, imgLen: number, input: number): number;
  _tend_disasm(img: number, imgLen: number): number;
  _tend_version(): number;
  _tend_free(ptr: number): void;
}

export type TendFactory = (options?: { locateFile?: (file: string) => string }) => Promise<TendModule>;

export interface WasmDeps {
  fetch: typeof fetch;
  importModule: (url: string) => Promise<{ default?: TendFactory }>;
  loadScript: (url: string, globalName: string) => Promise<TendFactory | null>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readCString(mod: TendModule, ptr: number): string {
  const heap = mod.HEAPU8;
  let end = ptr;
  while (heap[end] !== 0) end++;
  return decoder.decode(heap.subarray(ptr, end));
}

function copyIn(mod: TendModule, bytes: Uint8Array): number {
  const ptr = mod._malloc(bytes.length);
  if (!ptr) throw new Error("engine out of memory");
  mod.HEAPU8.set(bytes, ptr); // read HEAPU8 after malloc: memory growth replaces the view
  return ptr;
}

export class WasmEngine {
  private images = new Map<string, Promise<Uint8Array | null>>();

  constructor(
    private mod: TendModule,
    private base: string,
    private fetcher: typeof fetch,
  ) {}

  get version(): string {
    return readCString(this.mod, this.mod._tend_version());
  }

  lawImage(st: string): Promise<Uint8Array | null> {
    const key = st.toUpperCase();
    let pending = this.images.get(key);
    if (!pending) {
      pending = this.fetcher(`${this.base}/laws/${key}.tlaw`)
        .then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
        .catch(() => null);
      this.images.set(key, pending);
    }
    return pending;
  }

  private withImage<T>(image: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = copyIn(this.mod, image);
    try {
      return fn(ptr);
    } finally {
      this.mod._free(ptr);
    }
  }

  private takeString(ptr: number, what: string): string {
    if (!ptr) throw new Error(`${what} returned nothing`);
    try {
      return readCString(this.mod, ptr);
    } finally {
      this.mod._tend_free(ptr);
    }
  }

  evaluate(image: Uint8Array, input: EngineInput): EngineOutput {
    return this.withImage(image, (imgPtr) => {
      const inPtr = copyIn(this.mod, encoder.encode(JSON.stringify(input) + "\0"));
      try {
        const text = this.takeString(this.mod._tend_eval_json(imgPtr, image.length, inPtr), "tend_eval_json");
        const out = JSON.parse(text);
        if (out && typeof out === "object" && "error" in out && !("lines" in out)) {
          throw new Error(`engine error: ${String(out.error)}`);
        }
        return out as EngineOutput;
      } finally {
        this.mod._free(inPtr);
      }
    });
  }

  disasm(image: Uint8Array): string {
    return this.withImage(image, (imgPtr) =>
      this.takeString(this.mod._tend_disasm(imgPtr, image.length), "tend_disasm"),
    );
  }
}

const browserDeps = (): WasmDeps => ({
  fetch: (...args) => fetch(...args),
  importModule: (url) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url),
  loadScript: (url, globalName) =>
    new Promise((resolve) => {
      const el = document.createElement("script");
      el.src = url;
      el.async = true;
      el.onload = () => resolve(((window as unknown as Record<string, unknown>)[globalName] as TendFactory) ?? null);
      el.onerror = () => resolve(null);
      document.head.appendChild(el);
    }),
});

export async function loadWasmEngine(base = "/engine", deps: WasmDeps = browserDeps()): Promise<WasmEngine | null> {
  const res = await deps.fetch(`${base}/tend.js`, { cache: "no-cache" }).catch(() => null);
  if (!res || !res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) return null;
  const source = await res.text();

  const factory = /\bexport\s+default\b/.test(source)
    ? ((await deps.importModule(`${base}/tend.js`)).default ?? null)
    : await deps.loadScript(`${base}/tend.js`, "createTendModule");
  if (typeof factory !== "function") return null;

  const mod = await factory({ locateFile: (file) => `${base}/${file}` });
  for (const fn of ["_tend_eval_json", "_tend_version", "_tend_free", "_malloc", "_free"] as const) {
    if (typeof mod[fn] !== "function") throw new Error(`engine build is missing ${fn}`);
  }
  if (!(mod.HEAPU8 instanceof Uint8Array)) throw new Error("engine build does not export HEAPU8");
  return new WasmEngine(mod, base, deps.fetch);
}
