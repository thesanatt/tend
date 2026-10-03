import { afterEach, describe, expect, it } from "vitest";
import {
  baseSession,
  deviceAiStatus,
  DeviceAiTimeout,
  downloadProgress,
  promptJson,
  startModelDownload,
} from "@/lib/local/deviceai";
import { FakeLanguageModel, install, uninstall } from "./fake-lm";

afterEach(() => uninstall());

describe("device AI status", () => {
  it("is unavailable when the browser has no LanguageModel", async () => {
    expect(await deviceAiStatus()).toBe("unavailable");
    expect(await deviceAiStatus("image")).toBe("unavailable");
  });

  it.each(["available", "downloadable", "downloading", "unavailable"])("passes %s through", async (state) => {
    install(new FakeLanguageModel({ availability: { text: state } }));
    expect(await deviceAiStatus()).toBe(state);
  });

  it("reads text and image separately", async () => {
    install(new FakeLanguageModel({ availability: { text: "available", image: "downloadable" } }));
    expect(await deviceAiStatus("text")).toBe("available");
    expect(await deviceAiStatus("image")).toBe("downloadable");
  });

  it("treats odd answers and errors as unavailable", async () => {
    install(new FakeLanguageModel({ availability: { text: "readily" } }));
    expect(await deviceAiStatus()).toBe("unavailable");
    const broken = new FakeLanguageModel();
    broken.availability = async () => {
      throw new Error("NotSupportedError");
    };
    install(broken);
    expect(await deviceAiStatus()).toBe("unavailable");
  });
});

describe("starting the download", () => {
  it("calls create() before awaiting anything, so the tap's user activation still counts", async () => {
    let progressEvents: ((e: Event) => void) | null = null;
    const fake = new FakeLanguageModel({ availability: { text: "downloadable" } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.create = async (options: object = {}) => {
      fake.creates.push(options);
      const target = new EventTarget();
      (options as { monitor?: (m: EventTarget) => void }).monitor?.(target);
      progressEvents = (e) => target.dispatchEvent(e);
      await gate;
      return { prompt: async () => "", destroy: () => undefined };
    };
    install(fake);
    const seen: number[] = [];
    const done = startModelDownload((loaded) => seen.push(loaded));
    // Synchronously, before any microtask runs:
    expect(fake.creates).toHaveLength(1);
    expect(await deviceAiStatus()).toBe("downloading");
    progressEvents!(Object.assign(new Event("downloadprogress"), { loaded: 0.25 }));
    progressEvents!(Object.assign(new Event("downloadprogress"), { loaded: 1 }));
    expect(seen).toEqual([0.25, 1]);
    expect(downloadProgress()).toBe(1);
    // A second tap while it runs does not start another download.
    expect(startModelDownload()).toBe(done);
    release();
    expect(await done).toBe("available");
  });

  it("reports the real state when Chrome refuses (for example, no user activation)", async () => {
    install(
      new FakeLanguageModel({
        availability: { text: "downloadable" },
        createError: new DOMException("needs a tap", "NotAllowedError"),
      }),
    );
    expect(await startModelDownload()).toBe("downloadable");
    expect(await deviceAiStatus()).toBe("downloadable");
  });

  it("is unavailable without the API", async () => {
    expect(await startModelDownload()).toBe("unavailable");
  });
});

describe("sessions and prompts", () => {
  it("keeps one warm session per system prompt and modality", async () => {
    const fake = install(new FakeLanguageModel());
    const a = await baseSession("sys A");
    const b = await baseSession("sys A");
    const c = await baseSession("sys A", "image");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(fake.creates).toHaveLength(2);
  });

  it("retries without samplingMode when the browser rejects it", async () => {
    const fake = new FakeLanguageModel();
    const calls: object[] = [];
    fake.create = async (options: object = {}) => {
      calls.push(options);
      if ("samplingMode" in options) throw new TypeError("bad enum value");
      return { prompt: async () => "{}", destroy: () => undefined };
    };
    install(fake);
    await baseSession("sys");
    expect(calls).toHaveLength(2);
    expect("samplingMode" in calls[1]).toBe(false);
  });

  it("a failed start is not cached", async () => {
    const fake = install(new FakeLanguageModel({ createError: new Error("model crashed") }));
    await expect(baseSession("sys")).rejects.toThrow("model crashed");
    fake.opts.createError = undefined;
    await expect(baseSession("sys")).resolves.toBeTruthy();
  });

  it("parses JSON answers on a clone and destroys the clone", async () => {
    const fake = install(new FakeLanguageModel({ answer: () => '{"ok":true}' }));
    const base = await baseSession("sys");
    expect(await promptJson(base, "hi", { type: "object" }, 1000)).toEqual({ ok: true });
    expect(fake.destroyed).toBe(1);
    expect(fake.prompts[0].options?.responseConstraint).toEqual({ type: "object" });
  });

  it("times out with DeviceAiTimeout", async () => {
    install(new FakeLanguageModel({ delayMs: 500, answer: () => "{}" }));
    const base = await baseSession("sys");
    await expect(promptJson(base, "hi", {}, 20)).rejects.toBeInstanceOf(DeviceAiTimeout);
  });

  it("stops when the caller aborts", async () => {
    install(new FakeLanguageModel({ delayMs: 500, answer: () => "{}" }));
    const base = await baseSession("sys");
    const controller = new AbortController();
    const pending = promptJson(base, "hi", {}, 5000, controller.signal);
    controller.abort(new Error("left the page"));
    await expect(pending).rejects.toThrow("left the page");
  });
});
