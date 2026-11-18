// @vitest-environment jsdom
// The development page that records the built-in model's answers for the held-out rows, so a run in
// Chrome can be scored later with no model. No test here calls a model: a stand-in answers.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClassifierEvalPage, { metadata } from "@/app/dev/classifier-eval/page";
import sitemap from "@/app/sitemap";
import { HELDOUT_FILES, parseAnswers, runHeldOut, setHash, type HeldOutSet } from "@/lib/local/heldout";
import { browserToken, captureFile, type CaptureFile } from "@/lib/local/measure";
import { score } from "@/lib/local/score";
import raw from "./local/fixtures/classifier-heldout.json";
import { FakeLanguageModel, install, rowsOf, uninstall } from "./local/fake-lm";

const set = raw as HeldOutSet;

afterEach(() => {
  cleanup();
  uninstall();
  vi.unstubAllEnvs();
});

const always = (expense: string) =>
  new FakeLanguageModel({
    answer: (input) => JSON.stringify({ results: rowsOf(input).map((r) => ({ ref: r.ref, expense, reason: "x" })) }),
  });

const choose = (text: string) =>
  fireEvent.change(screen.getByLabelText(/Choose web\/tests\/local\/fixtures\/classifier-heldout\.json/), {
    target: { files: [new File([text], HELDOUT_FILES.set, { type: "application/json" })] },
  });

const runButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Run" });

async function recorded(): Promise<CaptureFile> {
  const link = await screen.findByRole<HTMLAnchorElement>("link", { name: `Save ${HELDOUT_FILES.nano}` });
  expect(link.getAttribute("download")).toBe(HELDOUT_FILES.nano);
  const href = link.getAttribute("href")!;
  expect(href.startsWith("data:application/json;charset=utf-8,")).toBe(true);
  return JSON.parse(decodeURIComponent(href.slice(href.indexOf(",") + 1))) as CaptureFile;
}

describe("/dev/classifier-eval", () => {
  it("is not part of the built site", async () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect((await sitemap()).filter((e) => new URL(e.url).pathname.startsWith("/dev"))).toEqual([]);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => ClassifierEvalPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("says so when the browser has no model, and will not run", async () => {
    render(<ClassifierEvalPage />);
    expect(await screen.findByText("Built-in model: not available in this browser.")).toBeTruthy();
    choose(JSON.stringify(set));
    expect(await screen.findByText(`${set.rows.length} rows, set hash ${setHash(set)}.`)).toBeTruthy();
    expect(runButton().disabled).toBe(true);
  });

  it("offers the download when Chrome has not fetched the model yet", async () => {
    const fake = install(new FakeLanguageModel({ availability: { text: "downloadable" } }));
    render(<ClassifierEvalPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Download the model" }));
    expect(fake.creates).toHaveLength(1);
    expect(runButton().disabled).toBe(true);
  });

  it("refuses a file that is not the set", async () => {
    install(always("medical"));
    render(<ClassifierEvalPage />);
    choose("{}");
    expect((await screen.findByRole("alert")).textContent).toContain("it has no rows");
    choose(JSON.stringify({ ...set, rows: [set.rows[0], set.rows[0]] }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("row id h001 is listed twice"));
    expect(runButton().disabled).toBe(true);
  });

  it("records a run, and the saved file scores with no model", async () => {
    const fake = install(always("medical"));
    render(<ClassifierEvalPage />);
    expect(await screen.findByText("Built-in model: ready.")).toBeTruthy();
    choose(JSON.stringify(set));
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    const file = await recorded();
    expect(fake.prompts).toHaveLength(55);
    expect(file).toMatchObject({
      set: HELDOUT_FILES.set,
      rows: 460,
      set_hash: setHash(set),
      model: "gemini-nano",
      prompt: "classify-v3",
      examples: true,
      timeout_ms: 5000,
    });
    expect(file.made).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(file.runs).toHaveLength(1);
    expect(file.runs[0]).toMatchObject({ status: "available", sent: 360, answered: 360, batches: 55, errors: [] });
    expect(screen.getByText(/npx tsx scripts\/classifier-eval\.ts --model tests\/local\/fixtures\//)).toBeTruthy();

    // The model is gone; the file alone gives the score.
    uninstall();
    const replay = await runHeldOut(set, { answers: parseAnswers(file).runs[0].answers });
    expect(replay.model).toMatchObject({ asked: 360, answered: 360, unused: [], missing: [] });
    expect(score(replay.rows).sent.left).toBe(0);
  });

  it("has nothing to save when the model answered no rows", async () => {
    install(always("coffee"));
    render(<ClassifierEvalPage />);
    choose(JSON.stringify(set));
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The model answered no rows, so there is nothing to save.",
    );
    expect(screen.queryByRole("link", { name: /Save/ })).toBeNull();
  });
});

describe("the saved file", () => {
  it("keeps the Chrome version and nothing else about the browser", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36";
    expect(browserToken(ua)).toBe("Chrome/142.0.7444.60");
    expect(browserToken("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("unknown");
  });

  it("records the time limit and whether the examples were in the prompt", () => {
    const about = { made: "2026-11-16T00:00:00.000Z", browser: "Chrome/142.0.0.0" };
    expect(captureFile(set, [], about)).toMatchObject({ examples: true, timeout_ms: 5000, runs: [] });
    expect(captureFile(set, [], { ...about, examples: false, timeoutMs: 20000 })).toMatchObject({
      examples: false,
      timeout_ms: 20000,
    });
  });
});
