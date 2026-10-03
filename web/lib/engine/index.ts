// Picks where the law engine runs, per call:
//   1. WebAssembly on this device, when /engine/tend.js and /engine/laws/<ST>.tlaw exist
//   2. the Tend API (POST /api/claim), when the API is reachable
//   3. the TypeScript preview of the same semantics, labeled as such
import { claimFromApi, fetchAsmFixture, fetchAsmFromApi, fetchLaw } from "../api";
import type { EngineInput, EngineOutput } from "../types";
import { evaluatePreview } from "./preview";
import { loadWasmEngine, type WasmEngine } from "./wasm";

export type Backend = "wasm" | "api" | "preview";

export interface Evaluation {
  output: EngineOutput;
  backend: Backend;
  detail: string;
}

export const BACKEND_LABEL: Record<Backend, string> = {
  wasm: "Law engine (WebAssembly) on this device",
  api: "Law engine on the Tend server",
  preview: "Preview engine in this browser",
};

let wasmPromise: Promise<WasmEngine | null> | null = null;

export function wasmEngine(): Promise<WasmEngine | null> {
  // next.config.ts sets this to "0" when public/engine/tend.js was absent at startup.
  if (typeof window === "undefined" || process.env.NEXT_PUBLIC_TEND_WASM === "0") return Promise.resolve(null);
  wasmPromise ??= loadWasmEngine().catch((err) => {
    console.warn("WebAssembly engine did not load:", err);
    return null;
  });
  return wasmPromise;
}

// Engines expect only the SPEC input fields; scan extras (merchant, confidence) stay behind.
export function toEngineInput(input: EngineInput): EngineInput {
  return {
    jurisdiction: input.jurisdiction.toUpperCase(),
    context: {
      incident_date: input.context.incident_date,
      as_of_date: input.context.as_of_date,
      police_report: input.context.police_report,
      forensic_exam: input.context.forensic_exam,
    },
    items: input.items.map((it) => ({
      item_id: it.item_id,
      date: it.date,
      amount_cents: it.amount_cents,
      expense: it.expense,
      confirmed: it.confirmed,
      insurance_paid_cents: it.insurance_paid_cents ?? 0,
      is_bill: it.is_bill,
      units: it.units ?? 0,
      description: it.description,
    })),
  };
}

export async function evaluateClaim(raw: EngineInput): Promise<Evaluation> {
  const input = toEngineInput(raw);
  const notes: string[] = [];

  const wasm = await wasmEngine();
  if (wasm) {
    const image = await wasm.lawImage(input.jurisdiction);
    if (image) {
      try {
        return { output: wasm.evaluate(image, input), backend: "wasm", detail: `tend ${wasm.version}` };
      } catch (err) {
        notes.push(`WebAssembly engine failed: ${(err as Error).message}`);
      }
    } else {
      notes.push(`No compiled law image for ${input.jurisdiction}`);
    }
  }

  try {
    const api = await claimFromApi(input);
    if (api) return { output: api.output, backend: "api", detail: api.engine };
  } catch (err) {
    notes.push((err as Error).message);
  }

  const law = await fetchLaw(input.jurisdiction);
  if (!law) throw new Error(`No verified rules for ${input.jurisdiction}`);
  return {
    output: evaluatePreview(input, law.law, law.sha256),
    backend: "preview",
    detail: notes.join("; ") || "No engine build or API connected",
  };
}

export async function disassemble(st: string): Promise<{ text: string; source: "wasm" | "api" | "fixture" } | null> {
  const wasm = await wasmEngine();
  const image = wasm ? await wasm.lawImage(st) : null;
  if (wasm && image) return { text: wasm.disasm(image), source: "wasm" };
  const api = await fetchAsmFromApi(st).catch(() => null);
  if (api) return { text: api, source: "api" };
  const fixture = await fetchAsmFixture(st);
  return fixture ? { text: fixture, source: "fixture" } : null;
}
