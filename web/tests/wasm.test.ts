// Drives lib/engine/wasm.ts against a fake Emscripten module that follows the C ABI in docs/SPEC.md.
import { describe, expect, it, vi } from "vitest";
import { loadWasmEngine, type TendFactory, type TendModule, type WasmDeps } from "@/lib/engine/wasm";
import type { EngineInput } from "@/lib/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

function fakeModule() {
  let heap = new Uint8Array(256);
  let top = 8;
  const freed: number[] = [];
  const allocations = new Map<number, number>();
  const calls: { image: string; input: string }[] = [];

  const readC = (ptr: number) => {
    let end = ptr;
    while (heap[end] !== 0) end++;
    return dec.decode(heap.subarray(ptr, end));
  };
  const writeC = (s: string) => {
    const bytes = enc.encode(s + "\0");
    const p = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, p);
    return p;
  };

  const mod: TendModule & { freed: number[]; calls: typeof calls; allocations: Map<number, number> } = {
    get HEAPU8() {
      return heap;
    },
    _malloc(size: number) {
      // Grow the heap like ALLOW_MEMORY_GROWTH does: the old view is replaced.
      if (top + size > heap.length) {
        const next = new Uint8Array((top + size) * 2);
        next.set(heap);
        heap = next;
      }
      const p = top;
      top += size;
      allocations.set(p, size);
      return p;
    },
    _free(ptr: number) {
      freed.push(ptr);
    },
    _tend_eval_json(img: number, len: number, input: number) {
      const image = dec.decode(heap.subarray(img, img + len));
      const text = readC(input);
      calls.push({ image, input: text });
      const parsed = JSON.parse(text) as EngineInput;
      if (parsed.items.length === 0) return writeC(JSON.stringify({ error: "no items" }));
      return writeC(
        JSON.stringify({ jurisdiction: parsed.jurisdiction, law_image_sha256: image, lines: [], totals: {} }),
      );
    },
    _tend_disasm(img: number, len: number) {
      return writeC(`; listing of ${dec.decode(heap.subarray(img, img + len))}`);
    },
    _tend_version() {
      return writeC("1.0.0-test");
    },
    _tend_free(ptr: number) {
      freed.push(ptr);
    },
    freed,
    calls,
    allocations,
  };
  return mod;
}

function deps(
  mod: TendModule | null,
  script: string,
  contentType = "text/javascript",
): WasmDeps & { fetch: ReturnType<typeof vi.fn> } {
  const factory: TendFactory = async () => mod!;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/tend.js"))
      return new Response(script, { status: 200, headers: { "content-type": contentType } });
    if (url.endsWith("/laws/MI.tlaw")) return new Response(enc.encode("TLAW-MI"), { status: 200 });
    return new Response("not found", { status: 404 });
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>,
    importModule: vi.fn(async () => ({ default: factory })),
    loadScript: vi.fn(async () => factory),
  };
}

const input: EngineInput = {
  jurisdiction: "MI",
  context: { incident_date: "2026-06-14", as_of_date: "2026-10-03", police_report: "no", forensic_exam: true },
  items: [
    {
      item_id: "a",
      date: "2026-06-14",
      amount_cents: 100,
      expense: "medical",
      confirmed: true,
      insurance_paid_cents: 0,
      is_bill: false,
      units: 0,
      description: "x".repeat(400),
    },
  ],
};

describe("WebAssembly engine loader", () => {
  it("returns null when /engine/tend.js is missing or is an HTML page", async () => {
    const d = deps(fakeModule(), "", "text/html");
    expect(
      await loadWasmEngine("/engine", { ...d, fetch: (async () => new Response("", { status: 404 })) as typeof fetch }),
    ).toBeNull();
    expect(await loadWasmEngine("/engine", d)).toBeNull();
  });

  it("loads a classic MODULARIZE build through a script tag", async () => {
    const d = deps(fakeModule(), "var createTendModule = function(){};");
    const engine = await loadWasmEngine("/engine", d);
    expect(engine).not.toBeNull();
    expect(d.loadScript).toHaveBeenCalledWith("/engine/tend.js", "createTendModule");
    expect(d.importModule).not.toHaveBeenCalled();
  });

  it("loads an ES module build with a default export", async () => {
    const d = deps(fakeModule(), "export default function createTendModule() {}");
    expect(await loadWasmEngine("/engine", d)).not.toBeNull();
    expect(d.importModule).toHaveBeenCalledWith("/engine/tend.js");
  });

  it("rejects a build that is missing an exported function", async () => {
    const broken = fakeModule() as Partial<TendModule>;
    delete broken._tend_eval_json;
    await expect(loadWasmEngine("/engine", deps(broken as TendModule, "var x;"))).rejects.toThrow(/_tend_eval_json/);
  });

  it("passes the law image and NUL-terminated input through the heap and frees everything", async () => {
    const mod = fakeModule();
    const engine = (await loadWasmEngine("/engine", deps(mod, "var x;")))!;
    const image = (await engine.lawImage("mi"))!;
    expect(dec.decode(image)).toBe("TLAW-MI");

    const out = engine.evaluate(image, input);
    expect(out.law_image_sha256).toBe("TLAW-MI");
    expect(JSON.parse(mod.calls[0].input)).toEqual(input);
    // image buffer, input buffer, and the returned string are all released
    expect(mod.freed.length).toBe(3);
    expect(engine.version).toBe("1.0.0-test");
    expect(engine.disasm(image)).toBe("; listing of TLAW-MI");
  });

  it("surfaces engine errors instead of returning them as output", async () => {
    const engine = (await loadWasmEngine("/engine", deps(fakeModule(), "var x;")))!;
    const image = (await engine.lawImage("MI"))!;
    expect(() => engine.evaluate(image, { ...input, items: [] })).toThrow(/no items/);
  });

  it("caches law images and returns null for a state with no image", async () => {
    const d = deps(fakeModule(), "var x;");
    const engine = (await loadWasmEngine("/engine", d))!;
    await engine.lawImage("MI");
    await engine.lawImage("MI");
    expect(await engine.lawImage("NY")).toBeNull();
    expect(d.fetch.mock.calls.filter(([u]) => String(u).endsWith("MI.tlaw"))).toHaveLength(1);
  });
});
