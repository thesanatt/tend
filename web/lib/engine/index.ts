// Picks where the law engine runs, per call:
//   1. WebAssembly on this device, when /engine/tend.js and /engine/laws/<ST>.tlaw exist
//   2. the Tend API (POST /api/claim), only when the caller allows it, because that sends the claim
//      to the server (docs/PRIVACY.md: nothing leaves the device unless the survivor acts)
// There is no third engine. When neither runs, the caller gets EngineUnavailableError and says so.
import { claimFromApi, dataMode, fetchAsmFixture, fetchAsmFromApi } from "../api";
import type { EngineInput, EngineOutput } from "../types";
import { loadWasmEngine, type WasmEngine } from "./wasm";

export type Backend = "wasm" | "api";

export interface Evaluation {
  output: EngineOutput;
  backend: Backend;
  detail: string;
}

export const BACKEND_LABEL: Record<Backend, string> = {
  wasm: "Law engine (WebAssembly) on this device",
  api: "Law engine on the Tend server",
};

// serverAvailable: the API answered the probe, so asking to use it makes sense.
export class EngineUnavailableError extends Error {
  constructor(
    message: string,
    readonly serverAvailable: boolean,
  ) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

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

// Engines expect only the SPEC input fields; extras (merchant, confidence, reason) stay behind.
// unit and tags are SPEC v1.2 fields and pass through when the caller has them.
export function toEngineInput(input: EngineInput): EngineInput {
  return {
    jurisdiction: input.jurisdiction.toUpperCase(),
    context: {
      incident_date: input.context.incident_date,
      as_of_date: input.context.as_of_date,
      police_report: input.context.police_report,
      forensic_exam: input.context.forensic_exam,
    },
    items: input.items.map((it) => {
      const extra = it as { unit?: unknown; tags?: unknown };
      return {
        item_id: it.item_id,
        date: it.date,
        amount_cents: it.amount_cents,
        expense: it.expense,
        confirmed: it.confirmed,
        insurance_paid_cents: it.insurance_paid_cents ?? 0,
        is_bill: it.is_bill,
        units: it.units ?? 0,
        description: it.description,
        ...(extra.unit !== undefined ? { unit: extra.unit } : {}),
        ...(Array.isArray(extra.tags) ? { tags: extra.tags } : {}),
      };
    }),
  };
}

export interface EvaluateOptions {
  // The caller has the survivor's yes to send this claim to the Tend server when the device cannot run it.
  allowApi?: boolean;
}

export async function evaluateClaim(raw: EngineInput, opts: EvaluateOptions = {}): Promise<Evaluation> {
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
  } else {
    notes.push("The WebAssembly engine is not available in this browser");
  }

  const live = (await dataMode()) === "live";
  if (!opts.allowApi) throw new EngineUnavailableError(notes.join("; "), live);

  try {
    const api = await claimFromApi(input);
    if (api) return { output: api.output, backend: "api", detail: api.engine };
    notes.push("The Tend server is not connected");
  } catch (err) {
    notes.push((err as Error).message);
  }
  throw new EngineUnavailableError(notes.join("; "), false);
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
