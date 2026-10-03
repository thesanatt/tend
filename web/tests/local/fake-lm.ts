// A stand-in for Chrome's LanguageModel global, so the on-device paths run in Node.
import { forgetSessions } from "@/lib/local/deviceai";

export interface PromptCall {
  input: unknown;
  options: { responseConstraint?: object; signal?: AbortSignal } | undefined;
}

export interface FakeOptions {
  availability?: Partial<Record<"text" | "image", string>>;
  // Returns the model's raw text for one prompt.
  answer?: (input: unknown, call: PromptCall) => string | Promise<string>;
  delayMs?: number;
  createError?: Error;
}

export class FakeLanguageModel {
  creates: object[] = [];
  prompts: PromptCall[] = [];
  destroyed = 0;
  constructor(readonly opts: FakeOptions = {}) {}

  availability = async (options?: { expectedInputs?: { type: string }[] }) => {
    const image = options?.expectedInputs?.some((i) => i.type === "image");
    return this.opts.availability?.[image ? "image" : "text"] ?? "available";
  };

  create = async (options: object = {}) => {
    this.creates.push(options);
    if (this.opts.createError) throw this.opts.createError;
    return this.session();
  };

  private session() {
    const prompt = async (input: unknown, options?: PromptCall["options"]) => {
      const call = { input, options };
      this.prompts.push(call);
      if (this.opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, this.opts.delayMs);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(options.signal!.reason ?? new DOMException("aborted", "AbortError"));
          });
        });
      }
      return (this.opts.answer ?? (() => '{"results":[]}'))(input, call);
    };
    return {
      prompt,
      clone: async () => this.session(),
      destroy: () => {
        this.destroyed++;
      },
    };
  }
}

type Row = { ref: string; kind: string; merchant: string; category: string; description: string };

// The rows a classification prompt carries (the JSON after the first line).
export function rowsOf(input: unknown): Row[] {
  const text = String(input);
  return JSON.parse(text.slice(text.indexOf("\n") + 1)) as Row[];
}

export function install(fake: FakeLanguageModel): FakeLanguageModel {
  forgetSessions();
  (globalThis as { LanguageModel?: unknown }).LanguageModel = fake;
  return fake;
}

export function uninstall(): void {
  forgetSessions();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
}
