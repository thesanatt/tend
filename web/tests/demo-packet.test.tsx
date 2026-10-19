// @vitest-environment jsdom
// A demo packet always says it is one. The sample statement, the sample bill, and the demo bank,
// added in any order, give a summary PDF that says so; a survivor's own records mixed with demo data
// say which part is made up; the advocate's view says the same.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SharedClaim from "@/app/share/SharedClaim";
import { buildEngineInput } from "@/components/flow/claim";
import { sampleBillFile, sampleStatementFile } from "@/components/flow/samples";
import { packetLineInfo } from "@/components/flow/usePacket";
import { billReader, classifier, statementParser } from "@/lib/local";
import { createPacketBuilder } from "@/lib/packet";
import { demoNote, demoSource, isDemo } from "@/lib/packet/specs";
import type { EngineInput } from "@/lib/types";
import {
  captureFlow,
  MI_CHECK,
  MI_LAW,
  michiganOutput,
  stateFrom,
  stubLawFetch,
  testServices,
  TODAY,
} from "./helpers/flow";

const web = path.resolve(import.meta.dirname, "..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = async (file: Blob) => new Uint8Array(await file.arrayBuffer());

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Source = "statement" | "bank" | "bill";

// Every order of every non-empty set of the three demo sources: 3 + 6 + 6 = 15.
function orders(sources: Source[]): Source[][] {
  const out: Source[][] = [];
  const walk = (done: Source[], left: Source[]) => {
    if (done.length) out.push(done);
    left.forEach((s, i) => walk([...done, s], [...left.slice(0, i), ...left.slice(i + 1)]));
  };
  walk([], sources);
  return out;
}

// Each sample file is read once for the whole file; the flow still hashes it and sorts its rows.
const reads = new Map<string, Promise<unknown>>();
function once<T>(key: string, read: () => Promise<T>): Promise<T> {
  if (!reads.has(key)) reads.set(key, read());
  return reads.get(key) as Promise<T>;
}
const services = () =>
  testServices({
    statementParser: { parse: (f: File) => once(`statement ${f.name} ${f.size}`, () => statementParser.parse(f)) },
    classifier,
    billReader: { read: (f: File) => once(`bill ${f.name} ${f.size}`, () => billReader.read(f)) },
  });

async function gather(steps: (Source | File)[]) {
  const box = captureFlow(services(), stateFrom([MI_CHECK]));
  for (const step of steps) {
    await act(async () => {
      if (step === "statement") await box.flow!.readStatement(await sampleStatementFile(), true);
      else if (step === "bank") await box.flow!.connectBank();
      else if (step === "bill") await box.flow!.readBill(sampleBillFile(), true);
      else await box.flow!.readStatement(step);
    });
  }
  const state = box.flow!.state;
  return { state, input: buildEngineInput(state, TODAY)! };
}

const builder = createPacketBuilder({ loadLaw: async () => MI_LAW, loadForm: async () => null });
const summary = async (input: EngineInput, lines = {}) =>
  (await builder.build("MI", input, michiganOutput(input), { lines })).transcript;

describe("a demo packet", () => {
  it.each(orders(["statement", "bank", "bill"]).map((o) => [o.join(", then "), o] as const))(
    "says it is a demo in its summary: %s",
    async (_, steps) => {
      const { input } = await gather([...steps]);
      expect(input.items.length).toBeGreaterThan(0);
      expect(input.items.every((i) => demoSource(i.item_id) !== null)).toBe(true);
      const note = demoNote(input)!;
      expect(note).toMatch(/^Demo packet\. The person and every record in it are made up\./);
      // The Nessie sentence only when a record came from the demo bank.
      expect(note.includes("Capital One's Nessie")).toBe(input.items.some((i) => i.item_id.startsWith("nessie:")));
      expect(await summary(input)).toContain(note);
    },
    30_000,
  );

  it("says so in the tour's order, where the bank's records fold into the statement's", async () => {
    const { state, input } = await gather(["statement", "bill", "bank"]);
    // The statement already holds the bank's costs, and the sample bill stands in for the bank's
    // bill, so no record from the bank reaches the engine: the old check missed this packet.
    expect(input.items.some((i) => i.item_id.startsWith("nessie:"))).toBe(false);
    expect(isDemo(input)).toBe(true);
    // Paying the rest of the bill in the tour goes to the demo bank.
    const paid = {
      ...state,
      payments: [
        {
          action_id: "a1",
          bill_id: state.bills[0].id,
          item_ids: state.items
            .filter((i) => i.origin === "bill" && i.expense !== "forensic_exam")
            .map((i) => i.item_id),
          amount_cents: 11800,
          payee: "Riverbend General Hospital",
          from: "Checking 0011",
          status: "done",
          demo: false,
          at: "2026-10-03T17:00:00Z",
        },
      ],
    };
    expect(await summary(input, packetLineInfo(paid))).toContain(
      "Demo packet. The person and every record in it are made up. The demo bank is Capital One's Nessie, a mock bank, so no real money moved.",
    );
  }, 30_000);

  it("says which part is made up when it is mixed with the survivor's own records", async () => {
    const own = new File([readFileSync(path.join(web, "tests/local/fixtures/csv/chase-checking.csv"))], "mine.csv", {
      type: "text/csv",
    });
    const { input } = await gather([own, "bill"]);
    const demo = input.items.filter((i) => demoSource(i.item_id) === "bill").length;
    expect(demo).toBe(3);
    const note = demoNote(input)!;
    expect(note).toBe(
      `Part of this packet is demo data. 3 of ${input.items.length} costs come from the sample bill, which is made up. Do not send those costs to the program.`,
    );
    expect(await summary(input)).toContain(note);
  }, 30_000);

  it("is not called a demo when every record is the survivor's own", async () => {
    const own = new File([readFileSync(path.join(web, "tests/local/fixtures/csv/chase-checking.csv"))], "mine.csv", {
      type: "text/csv",
    });
    const { input } = await gather([own]);
    expect(input.items.length).toBeGreaterThan(0);
    expect(demoNote(input)).toBeNull();
    expect((await summary(input)).join("\n")).not.toMatch(/demo/i);
  }, 30_000);

  it("knows the sample files by their hashes, including the copies a visitor can save and add", async () => {
    const statement = sha256(await bytesOf(await sampleStatementFile()));
    const served = sha256(readFileSync(path.join(web, "public/samples/rowan-statement-FICTIONAL.pdf")));
    const bill = sha256(await bytesOf(sampleBillFile()));
    const servedBill = sha256(readFileSync(path.join(web, "public/samples/riverbend-bill-FICTIONAL.pdf")));
    // Statement costs are "stmt:<first 10 of the sha256>:<row>"; bill lines "bill:<first 16>:<line>".
    expect(demoSource(`stmt:${statement.slice(0, 10)}:pdf:12`)).toBe("statement");
    expect(demoSource(`stmt:${served.slice(0, 10)}:pdf:12`)).toBe("statement");
    expect(demoSource(`bill:${bill.slice(0, 16)}:2`)).toBe("bill");
    expect(servedBill).toBe(bill);
    // Saved progress from before the bill ids were fixed still counts.
    expect(demoSource(`bill:${bill.slice(0, 10)}:bill:${bill.slice(0, 16)}:2`)).toBe("bill");
    expect(demoSource("nessie:rowan-12")).toBe("bank");
    expect(demoSource("stmt:0123456789:pdf:12")).toBeNull();
    expect(demoSource("bill:0123456789abcdef:2")).toBeNull();
  });
});

describe("the advocate's view of a demo claim", () => {
  it("says it is a demo, and names the bank only when its records are there", async () => {
    const { input } = await gather(["statement", "bill", "bank"]);
    render(<SharedClaim input={input} output={michiganOutput(input)} createdAt={null} expiresAt={null} sealed />);
    expect(screen.getByText("Demo packet. The person and every record in it are made up.")).toBeTruthy();
    expect(screen.queryByText(/Nessie/)).toBeNull();
  }, 30_000);
});
