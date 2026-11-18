import { afterEach, describe, expect, it } from "vitest";
import { classifyDetailed } from "@/lib/local/classify";
import { heldOutTxns, parseAnswers, runHeldOut, type HeldOutSet } from "@/lib/local/heldout";
import { captureDeviceAnswers } from "@/lib/local/measure";
import raw from "./fixtures/classifier-heldout.json";
import { FakeLanguageModel, install, rowsOf, uninstall } from "./fake-lm";

afterEach(() => uninstall());

const set = raw as HeldOutSet;

describe("captureDeviceAnswers", () => {
  const always = (expense: string) =>
    new FakeLanguageModel({
      answer: (input) => JSON.stringify({ results: rowsOf(input).map((r) => ({ ref: r.ref, expense, reason: "x" })) }),
    });

  it("keeps the label the app took for every row the model was asked about", async () => {
    const fake = install(always("medical"));
    const [run, ...rest] = await captureDeviceAnswers(set);
    expect(rest).toHaveLength(0);
    expect(run).toMatchObject({ status: "available", sent: 360, answered: 360, batches: 55, errors: [] });
    expect(fake.prompts).toHaveLength(55); // 326 distinct rows, six a prompt
    expect(Object.keys(run.answers)).toHaveLength(360);
    expect(new Set(Object.values(run.answers))).toEqual(new Set(["medical"]));
    expect(run.answers.h237).toBeUndefined(); // a rule sorted it, so the model never saw it
  });

  it("records the two barred labels as the app changes them", async () => {
    install(always("forensic_exam"));
    const [exam] = await captureDeviceAnswers(set);
    expect(new Set(Object.values(exam.answers))).toEqual(new Set(["medical"]));
    install(always("lost_wages"));
    const [pay] = await captureDeviceAnswers(set);
    expect(new Set(Object.values(pay.answers))).toEqual(new Set(["unknown"]));
  });

  it("records nothing when the browser has no model, or the model's answer is not usable", async () => {
    install(new FakeLanguageModel({ availability: { text: "unavailable" } }));
    const [none] = await captureDeviceAnswers(set);
    expect(none).toMatchObject({ status: "unavailable", sent: 360, answered: 0, batches: 0, answers: {} });
    install(always("coffee"));
    const [odd] = await captureDeviceAnswers(set, { runs: 1 });
    expect(odd).toMatchObject({ status: "available", answered: 0, answers: {} });
  });

  it("gives a file that replays to the rows the model run gave", async () => {
    const byWords = () =>
      new FakeLanguageModel({
        answer: (input) =>
          JSON.stringify({
            results: rowsOf(input).map((r) => {
              const d = `${r.merchant} ${r.description}`.toLowerCase();
              const expense = /uber|lyft/.test(d)
                ? "transportation"
                : /pharm|rx/.test(d)
                  ? "prescription"
                  : /exam/.test(d)
                    ? "forensic_exam"
                    : /dds|dental|ortho/.test(d)
                      ? "dental"
                      : "unknown";
              return { ref: r.ref, expense, reason: "x" };
            }),
          }),
      });
    install(byWords());
    const direct = await classifyDetailed(heldOutTxns(set.rows), set.context, {});
    install(byWords());
    const runs = await captureDeviceAnswers(set);
    uninstall();

    const file = parseAnswers(JSON.parse(JSON.stringify({ model: "a test stand-in", runs })));
    const replay = await runHeldOut(set, { answers: file.runs[0].answers });
    const shape = (all: typeof direct.all) => all.map((c) => [c.ref, c.expense, c.candidate, c.confirmed, c.method]);
    expect(shape(replay.report.all)).toEqual(shape(direct.all));
    expect(replay.model).toMatchObject({ asked: 360, answered: 360, unused: [] });
  });
});
