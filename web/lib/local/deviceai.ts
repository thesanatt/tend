// Gemini Nano on this device through Chrome's built-in Prompt API (the LanguageModel global).
// Feature-detected: browsers without it report "unavailable" and Tend keeps working on rules.
// Nothing here downloads a model on its own; startModelDownload must run from a tap or key press.
import type { DeviceAi } from "../contracts";

export interface LmPromptOptions {
  responseConstraint?: object;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

export interface LmSession {
  prompt(input: unknown, options?: LmPromptOptions): Promise<string>;
  clone?(options?: { signal?: AbortSignal }): Promise<LmSession>;
  destroy(): void;
  contextUsage?: number;
  contextWindow?: number;
}

export interface LmApi {
  availability(options?: object): Promise<string>;
  create(options?: object): Promise<LmSession>;
  params?: () => Promise<{ defaultTemperature: number; maxTemperature: number; defaultTopK: number; maxTopK: number }>;
}

export type Modality = "text" | "image";

const IO: Record<Modality, object> = {
  text: {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  },
  image: {
    expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  },
};

export function languageModel(): LmApi | null {
  const lm = (globalThis as { LanguageModel?: LmApi }).LanguageModel;
  return lm && typeof lm.availability === "function" && typeof lm.create === "function" ? lm : null;
}

let downloading: Promise<DeviceAi> | null = null;
let progress = 0;

async function availability(lm: LmApi, modality: Modality): Promise<DeviceAi> {
  try {
    const a = await lm.availability(IO[modality]);
    return a === "available" || a === "downloadable" || a === "downloading" ? a : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function deviceAiStatus(modality: Modality = "text"): Promise<DeviceAi> {
  const lm = languageModel();
  if (!lm) return "unavailable";
  if (downloading) return "downloading";
  return availability(lm, modality);
}

// Fraction downloaded (0 to 1) while a download started here is running.
export function downloadProgress(): number {
  return progress;
}

// Starts the one-time model download. Call it straight from a click or key handler: Chrome only
// downloads with user activation, so create() is called before anything is awaited.
export function startModelDownload(onProgress?: (loaded: number) => void): Promise<DeviceAi> {
  const lm = languageModel();
  if (!lm) return Promise.resolve("unavailable");
  if (downloading) return downloading;
  let created: Promise<LmSession>;
  try {
    created = lm.create({
      ...IO.text,
      monitor(m: EventTarget) {
        m.addEventListener("downloadprogress", (e) => {
          const loaded = (e as Event & { loaded?: number }).loaded;
          if (typeof loaded === "number") {
            progress = loaded;
            onProgress?.(loaded);
          }
        });
      },
    });
  } catch {
    return availability(lm, "text");
  }
  progress = 0;
  downloading = created.then(
    (session) => {
      session.destroy();
      downloading = null;
      return "available" as const;
    },
    () => {
      downloading = null;
      return availability(lm, "text");
    },
  );
  return downloading;
}

// Low temperature: Chrome extensions still honor temperature and topK; web pages use samplingMode.
async function createLowTemperature(lm: LmApi, options: object): Promise<LmSession> {
  let sampling: object = {};
  if (typeof lm.params === "function") {
    try {
      const p = await lm.params();
      sampling = { temperature: Math.min(0.2, p.maxTemperature), topK: 1 };
    } catch {
      sampling = {};
    }
  }
  try {
    return await lm.create({ ...options, ...sampling, samplingMode: "most-predictable" });
  } catch (err) {
    if (err instanceof TypeError) return lm.create({ ...options, ...sampling });
    throw err;
  }
}

const sessions = new Map<string, Promise<LmSession>>();

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

// One base session per system prompt, example turns and modality, kept warm; each request works
// on a clone so batches never see each other's rows.
export function baseSession(
  system: string,
  modality: Modality = "text",
  examples: Turn[] = [],
  createTimeoutMs = 60_000,
): Promise<LmSession> {
  const key = JSON.stringify([modality, system, examples]);
  let pending = sessions.get(key);
  if (!pending) {
    const lm = languageModel();
    if (!lm) return Promise.reject(new Error("On-device AI is not available in this browser."));
    // Aborting a create() signal after the session exists would destroy it, so the time limit
    // only ever aborts a creation that is still running. A start that never settles gives up
    // at the limit, and is not cached, so the next call tries again.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DeviceAiTimeout("on-device model took too long to start")),
      createTimeoutMs,
    );
    pending = untilAborted(
      createLowTemperature(lm, {
        ...IO[modality],
        initialPrompts: [{ role: "system", content: system }, ...examples],
        signal: controller.signal,
      }),
      controller.signal,
      destroyLate,
    )
      .catch((err) => {
        sessions.delete(key);
        throw err;
      })
      .finally(() => clearTimeout(timer));
    sessions.set(key, pending);
  }
  return pending;
}

export function forgetSessions(): void {
  for (const pending of sessions.values()) pending.then((s) => s.destroy()).catch(() => undefined);
  sessions.clear();
}

export class DeviceAiTimeout extends Error {}

// Settles with the promise, or rejects as soon as the signal aborts, so a browser call that
// ignores its signal cannot hang Tend. A session that arrives after the abort is handed to
// discard (destroyed) instead of staying in memory.
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal, discard?: (late: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) discard?.(value);
        else resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

const destroyLate = (session: LmSession) => session.destroy();

// One prompt with a JSON schema constraint and a time limit; the answer is parsed JSON.
export async function promptJson(
  base: LmSession,
  input: unknown,
  schema: object,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  // The time limit covers making the clone and the prompt, so neither can hang the batch loop.
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;
  let session = base;
  try {
    if (base.clone) session = await untilAborted(base.clone({ signal: combined }), combined, destroyLate);
    combined.throwIfAborted(); // the caller may have given up while the clone was made
    const text = await untilAborted(session.prompt(input, { responseConstraint: schema, signal: combined }), combined);
    return JSON.parse(text);
  } catch (err) {
    if (combined.aborted && combined.reason === timer.reason)
      throw new DeviceAiTimeout(`on-device model took longer than ${timeoutMs} ms`);
    throw err;
  } finally {
    if (session !== base) session.destroy();
  }
}
