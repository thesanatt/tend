// @vitest-environment jsdom
// Gather and bill triage (docs/UX.md step 2), through the thin mocks of the local modules.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillsScreen from "@/components/flow/bills/BillsScreen";
import Cite from "@/components/flow/Cite";
import { ROWAN_ACCOUNT } from "@/components/flow/samples";
import GatherScreen from "@/components/flow/gather/GatherScreen";
import PrivacyLine from "@/components/flow/PrivacyLine";
import type { Action, BillRecord, FlowItem } from "@/components/flow/state";
import { fetchLaw, resetLawCacheForTests } from "@/lib/api";
import type { BillReading } from "@/lib/contracts";
import { SAMPLE_BILL_READING } from "@/lib/mocks";
import { mockEngineOutput } from "@/lib/mocks/engine";
import type { EngineInput, Jurisdiction } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";
import {
  MI_BYTES,
  MI_CHECK,
  MI_LAW,
  michiganOutput,
  renderFlow,
  stateFrom,
  stubLawFetch,
  testServices,
} from "./helpers/flow";

// Reading the five-page sample PDF takes well over a second when the whole suite runs in parallel.
const PDF_READ = { timeout: 10_000 };
vi.setConfig({ testTimeout: 20_000 });

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/gather",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function figure() {
  return screen.getByText(/^\$[\d,]+\.\d\d$/, { selector: "p[class*=tallyFigure] span" }).textContent;
}

// The tally keeps the last total while the engine works, so wait until no line is still being checked.
async function settled() {
  await waitFor(() => {
    expect(figure()).not.toBe("...");
    expect(document.querySelectorAll('li[data-status="checking"]')).toHaveLength(0);
  });
}

describe("Gather", () => {
  it("asks for the state first", () => {
    renderFlow(<GatherScreen />);
    expect(screen.getByText("First, tell Tend which state it happened in.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Check" }).getAttribute("href")).toBe("/check");
  });

  it("offers the statement first, then the demo bank, then a bill, all read on this device", () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    const options = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(options).toEqual(["Bank statement", "Demo bank", "A bill"]);
    // The statement upload is the one primary action on an empty screen.
    expect(screen.getByText("Upload a statement").className).toMatch(/btn-primary/);
    expect(screen.getByText("Add a bill").className).not.toMatch(/btn-primary/);
  });

  it("reads a statement, groups the costs, and confirms a group in one tap", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    expect(await screen.findByText("What Tend found", {}, PDF_READ)).toBeTruthy();
    expect(screen.getByText(/sample-statement-fictional\.pdf: 190 transactions read/)).toBeTruthy();
    await settled();
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(expect.arrayContaining(["Counseling", "Getting there", "Home", "Work", "Not covered"]));

    // Direct matches start checked; guesses are questions with Yes / No / Not sure.
    const counseling = screen.getByRole("region", { name: "Counseling" });
    const boxes = within(counseling).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.checked)).toBe(true);
    const ride = screen.getAllByRole("group", { name: /Was this ride to care\?/ })[0];
    expect(
      within(ride)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Yes", "No", "Not sure"]);

    await settled();
    const before = figure();
    const confirmAll = screen.getByRole("button", { name: /^Yes to all \d+ rides$/ });
    fireEvent.click(confirmAll);
    await waitFor(() => expect(figure()).not.toBe(before));
    expect(screen.queryByRole("button", { name: /^Yes to all \d+ rides$/ })).toBeNull();

    // Not covered lines stay visible, each with the rule that excludes it.
    const notCovered = screen.getByRole("region", { name: "Not covered" });
    expect(within(notCovered).getByText("Brightline Wireless - new phone")).toBeTruthy();
    expect(within(notCovered).getByRole("button", { name: /show the law for Brightline Wireless/ })).toBeTruthy();
    // A yes would not change what the law says, so these lines ask nothing.
    expect(within(notCovered).queryAllByRole("group")).toHaveLength(0);
  });

  it("unchecking a direct match takes it out of the total, one tap", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: "Use a sample statement" }));
    await screen.findByText("What Tend found", {}, PDF_READ);
    await settled();
    const before = figure();
    const box = within(screen.getByRole("region", { name: "Counseling" })).getAllByRole("checkbox")[0];
    fireEvent.click(box);
    await waitFor(() => expect(figure()).not.toBe(before));
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("says plainly when a file has no transactions it can read", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.change(document.getElementById("statement-file")!, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect(
      await screen.findByText("Tend could not find transactions in this file. Try a CSV or PDF from your bank."),
    ).toBeTruthy();
  });

  it("reads a bill on the device and says whether its lines add up", async () => {
    renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: "Use a sample bill" }));
    expect(await screen.findByText(/Riverbend General Hospital: 3 lines, adding up to \$443\.00\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Next: your bill" }).getAttribute("href")).toBe("/gather/bills");
  });

  it("marks a bill it cannot read reliably, and adds none of its lines", async () => {
    const { services } = renderFlow(<GatherScreen />, { initial: stateFrom([MI_CHECK]) });
    fireEvent.change(document.getElementById("bill-file")!, {
      target: { files: [new File(["blurry"], "photo.jpg", { type: "image/jpeg" })] },
    });
    expect(await screen.findByText("photo.jpg: Tend couldn't read this reliably.")).toBeTruthy();
    expect(services.evaluate).not.toHaveBeenCalledWith(
      expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ is_bill: true })]) }),
      expect.anything(),
    );
  });
});

const billLines: FlowItem[] = SAMPLE_BILL_READING.lines.map((l, i) => ({
  item_id: `bill:abc:${l.line_id}`,
  date: "2026-06-14",
  amount_cents: l.amount_cents,
  expense: l.expense,
  confirmed: true,
  insurance_paid_cents: 0,
  is_bill: true,
  units: 0,
  unit: null,
  tags: [],
  description: l.description,
  source: "rule",
  reason: "",
  confidence: 1,
  origin: "bill",
  merchant: "Riverbend General Hospital",
  bill_id: "bill-abc",
  line_no: i + 1,
}));
const bill: BillRecord = {
  id: "bill-abc",
  label: "riverbend.pdf",
  reading: SAMPLE_BILL_READING,
  replaces: null,
  choice: null,
  sample: true,
};
const withBill: Action[] = [MI_CHECK, { type: "addBill", bill, items: billLines }];
const withBank: Action = {
  type: "addSource",
  source: { id: "bank", kind: "bank", label: "Checking", read: 0, found: 0, warnings: [], sample: true },
  items: [],
  account: ROWAN_ACCOUNT,
};

describe("bill triage", () => {
  it("holds the exam line with the law beside it, and offers a ready letter that quotes the law", async () => {
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill) });
    expect(await screen.findByRole("heading", { name: "Don't pay this line" })).toBeTruthy();
    expect(
      screen.getByText(
        "Medical forensic exam, deductible applied, $325.00. Michigan law says you should not be billed for it.",
      ),
    ).toBeTruthy();
    const noBill = MI_LAW.rules.find((r) => r.id === "MI-EXAM-1")!;
    expect(screen.getByText(noBill.quote)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The rest: $118.00" })).toBeTruthy();
    expect(
      screen.getByText("Both choices are fine. The program can pay you back for these, whether you pay now or not:"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Get a letter for the billing office" }));
    const letter = await screen.findByText((_, el) => el?.tagName === "PRE" && el.textContent!.includes(noBill.quote));
    expect(letter.textContent).toContain(`Michigan law, ${noBill.pinpoint}, says:`);
    expect(letter.textContent).toContain("Riverbend General Hospital");
    expect(screen.getByText("Tend does not send anything for you. You choose if and when.")).toBeTruthy();
  });

  it("without a connected bank, paying is not offered; leaving it unpaid and claiming it is", async () => {
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill) });
    const pay = (await screen.findByRole("button", { name: "Pay $118.00 now" })) as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Leave unpaid and claim it" }));
    expect(await screen.findByText("You chose to leave it unpaid and claim it. It is in your packet.")).toBeTruthy();
  });

  it("pays only with the six-digit code, and the privacy line changes only after the bank took it", async () => {
    const { services } = renderFlow(
      <>
        <PrivacyLine />
        <BillsScreen />
      </>,
      { initial: stateFrom([...withBill, withBank]) },
    );
    // Once Tend knows there is no locked progress, the line says nothing has left.
    expect(await screen.findByText("On this device. Nothing has left it since this page opened.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Pay $118.00 now from Checking 0011" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("$118.00")).toBeTruthy();
    expect(within(dialog).getByText("Riverbend General Hospital")).toBeTruthy();
    expect(
      within(dialog).getByText(/Medical forensic exam, deductible applied, \$325\.00\. It stays held\./),
    ).toBeTruthy();
    // Opening the sheet sends nothing; asking for the code does.
    expect(services.propose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Get a code" }));
    await within(dialog).findByLabelText("Confirmation code");
    expect(screen.getByText("On this device, except what you chose to send: a payment you started.")).toBeTruthy();
    expect(services.propose).toHaveBeenCalledWith(
      expect.objectContaining({ amount_cents: 11800, payee: "Riverbend General Hospital", from: ROWAN_ACCOUNT }),
    );

    const payButton = within(dialog).getByRole("button", { name: "Pay $118.00" }) as HTMLButtonElement;
    const code = within(dialog).getByLabelText("Confirmation code");
    expect(payButton.disabled).toBe(true);
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.click(payButton);
    expect(
      await within(dialog).findByText("That code does not match. Check the six digits and try again."),
    ).toBeTruthy();
    expect(screen.getByText("On this device, except what you chose to send: a payment you started.")).toBeTruthy();

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(payButton);
    expect(await within(dialog).findByText("Paid $118.00.")).toBeTruthy();
    expect(within(dialog).getByText("The bank's record matches this payment.")).toBeTruthy();
    expect(screen.getByText("On this device, except what you chose to send: a payment.")).toBeTruthy();
  });

  it("a demo payment sends nothing, so the privacy line stays the same", async () => {
    const services = testServices({
      propose: vi.fn(async (req) => ({
        action_id: "demo-1",
        amount_cents: req.amount_cents,
        from: "Checking 0011",
        payee: req.payee,
        confirm_code: "123456",
        expires_at: "2026-10-03T23:00:00Z",
        demo: true,
      })),
      confirm: vi.fn(async () => ({
        action_id: "demo-1",
        status: "not_sent",
        amount_cents: 11800,
        at: "2026-10-03T17:00:00Z",
      })),
    });
    renderFlow(
      <>
        <PrivacyLine />
        <BillsScreen />
      </>,
      { services, initial: stateFrom([...withBill, withBank]) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pay $118.00 now from Checking 0011" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Get a code" }));
    expect(await within(dialog).findByText(/Demo mode: Tend is not connected to the bank/)).toBeTruthy();
    expect(screen.getByText("On this device. Nothing has left it since this page opened.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Confirmation code"), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pay $118.00" }));
    expect(await within(dialog).findByText("Nothing was sent.")).toBeTruthy();
    expect(screen.getByText("On this device. Nothing has left it since this page opened.")).toBeTruthy();
  });

  it("refuses a proposal whose amount differs from the bill, before any code is asked for", async () => {
    const services = testServices({
      propose: vi.fn(async (req) => ({
        action_id: "a1",
        amount_cents: 44300,
        from: "Checking 0011",
        payee: req.payee,
        confirm_code: "123456",
        expires_at: "2026-10-03T23:00:00Z",
        demo: false,
      })),
    });
    renderFlow(<BillsScreen />, { services, initial: stateFrom([...withBill, withBank]) });
    fireEvent.click(await screen.findByRole("button", { name: "Pay $118.00 now from Checking 0011" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Get a code" }));
    expect(
      await within(dialog).findByText(
        "The payment service proposed $443.00, but the bill shows $118.00. Nothing was sent.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText("Confirmation code")).toBeNull();
    expect(services.confirm).not.toHaveBeenCalled();
  });
});

// Two of Rowan's costs from the demo bank: a $12 ride on a counseling day and the sheets an AI sorted.
// Both are guesses, so both wait for a yes.
const guess = (item_id: string, date: string, cents: number, expense: FlowItem["expense"], description: string) =>
  ({
    item_id,
    date,
    amount_cents: cents,
    expense,
    confirmed: false,
    insurance_paid_cents: 0,
    is_bill: false,
    units: 0,
    unit: null,
    tags: [],
    description,
    source: "rule",
    reason: "",
    confidence: 0.6,
    origin: "bank",
  }) satisfies FlowItem;
const ride = guess("nessie:r-1", "2026-06-17", 1200, "transportation", "Wayfare Rides - trip");
const sheets = guess("nessie:r-2", "2026-06-16", 9600, "clothing_bedding", "Linen & Loom - sheet set, pillows");
const withGuesses: Action[] = [
  MI_CHECK,
  {
    type: "addSource",
    source: { id: "bank", kind: "bank", label: "Checking", read: 2, found: 2, warnings: [], sample: true },
    items: [ride, sheets],
  },
];
// A ride's proof as the engine gives it (fixtures/rowan-mi.output.json): the $5,000 limit it counts
// with, the rule that covers rides, and the $1,000 limit for trips of 50 miles or less beside them.
const realProof = () =>
  testServices({
    evaluate: vi.fn(async (input: EngineInput) => {
      const out = michiganOutput(input);
      const lines = out.lines.map((l) =>
        l.expense === "transportation"
          ? { ...l, rule_ids: ["MI-CAP-8", "MI-COV-7"], alt_cap_rule_ids: ["MI-CAP-7"] }
          : l,
      );
      return { output: { ...out, lines }, backend: "wasm" as const, detail: "test" };
    }),
  });
const quote = (id: string) => MI_LAW.rules.find((r) => r.id === id)!.quote;

describe("the law behind each cost", () => {
  it("cites a local ride to the rule that covers rides to care, then both trip-length limits", async () => {
    renderFlow(<GatherScreen />, { services: realProof(), initial: stateFrom(withGuesses) });
    const cite = await screen.findByRole("button", { name: /show the law for Wayfare Rides - trip/ });
    // Not MCL 18.361(2)(e)(ii), the $5,000 limit for trips of 50 miles or more.
    expect(cite.textContent).toMatch(/^MCL 18\.361\(2\)\(e\) \+2:/);
    fireEvent.click(cite);
    const sheet = await screen.findByRole("dialog");
    for (const id of ["MI-COV-7", "MI-CAP-7", "MI-CAP-8"]) expect(within(sheet).getByText(quote(id))).toBeTruthy();
    const order = ["MI-COV-7", "MI-CAP-7", "MI-CAP-8"].map((id) => sheet.textContent!.indexOf(quote(id)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(
      within(sheet).getByText(
        /The law sets more than one limit for this kind of cost\. Each rule says when it applies\. Tend uses the highest, and the program decides which one fits\./,
      ),
    ).toBeTruthy();
  });

  it("asks whether replaced bedding was kept as evidence, the condition its rule sets", async () => {
    renderFlow(<GatherScreen />, { services: realProof(), initial: stateFrom(withGuesses) });
    expect(
      await screen.findByRole("group", { name: /^Did this replace clothing or bedding kept as evidence\?/ }),
    ).toBeTruthy();
    const cite = screen.getByRole("button", { name: /show the law for Linen & Loom/ });
    expect(cite.textContent).toMatch(/^MCL 18\.361\(2\)\(j\):/);
    fireEvent.click(cite);
    expect(within(await screen.findByRole("dialog")).getByText(quote("MI-CAP-10"))).toBeTruthy();
    expect(quote("MI-CAP-10")).toContain("that is held as evidence of a crime");
  });

  it("asks the same in Spanish", async () => {
    renderFlow(<GatherScreen />, { services: realProof(), initial: stateFrom(withGuesses, "es"), lang: "es" });
    expect(
      await screen.findByRole("group", {
        name: /^¿Esto reemplazó ropa o ropa de cama que se guardó como evidencia\?/,
      }),
    ).toBeTruthy();
  });
});

// The same sheets in other states, with the rule ids the engine gives an unconfirmed clothing line
// there (public/engine/laws/*.tlaw).
const sheetsIn = (st: string): Action[] => [
  { type: "check", patch: { st, date: "2026-06-14", exam: "yes", police: "not_yet" } },
  {
    type: "addSource",
    source: { id: "bank", kind: "bank", label: "Checking", read: 1, found: 1, warnings: [], sample: true },
    items: [sheets],
  },
];
const clothingProof = (ruleIds: string[]) =>
  testServices({
    evaluate: vi.fn(async (input: EngineInput) => {
      const out = mockEngineOutput(input);
      const lines = out.lines.map((l) => (l.expense === "clothing_bedding" ? { ...l, rule_ids: ruleIds } : l));
      return { output: { ...out, lines }, backend: "wasm" as const, detail: "test" };
    }),
  });

describe("the clothing question in other states", () => {
  // NJ-COV-CLOTH quotes a clause of New Jersey's crime scene clean-up section (N.J.A.C. 13:75-4.12(d)1).
  // Asked only "clothing or bedding?", a yes would count clothes the hospital kept, with no cleanup.
  it("asks New Jersey whether it replaced clothing or bedding as part of cleanup", async () => {
    renderFlow(<GatherScreen />, { services: clothingProof(["NJ-COV-CLOTH"]), initial: stateFrom(sheetsIn("NJ")) });
    expect(
      await screen.findByRole("group", {
        name: /^Did this replace clothing or bedding as part of cleanup you needed afterward\?/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /^Did this replace clothing or bedding\?/ })).toBeNull();
    expect(screen.queryByText(/kept as evidence/)).toBeNull();
  });

  it("asks New Jersey the same in Spanish", async () => {
    renderFlow(<GatherScreen />, {
      services: clothingProof(["NJ-COV-CLOTH"]),
      initial: stateFrom(sheetsIn("NJ"), "es"),
      lang: "es",
    });
    expect(
      await screen.findByRole("group", {
        name: /^¿Esto reemplazó ropa o ropa de cama como parte de una limpieza que necesitaste después\?/,
      }),
    ).toBeTruthy();
  });

  // OH-COV-5 pays only for clothing removed to assess or treat injuries. Asked only "clothing or
  // bedding?", a yes would count these sheets under a sentence about clothes taken off for care.
  it("asks Ohio whether it replaced clothing removed to check for or treat injuries", async () => {
    renderFlow(<GatherScreen />, { services: clothingProof(["OH-COV-5"]), initial: stateFrom(sheetsIn("OH")) });
    expect(
      await screen.findByRole("group", { name: /^Did this replace clothing removed to check for or treat injuries\?/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /^Did this replace clothing or bedding/ })).toBeNull();
  });

  it("asks Ohio the same in Spanish", async () => {
    renderFlow(<GatherScreen />, {
      services: clothingProof(["OH-COV-5"]),
      initial: stateFrom(sheetsIn("OH"), "es"),
      lang: "es",
    });
    expect(
      await screen.findByRole("group", {
        name: /^¿Esto reemplazó ropa que te quitaron para revisar si había lesiones o tratarlas\?/,
      }),
    ).toBeTruthy();
  });

  it("asks Washington about clothing or footwear lost or damaged in emergency treatment", async () => {
    renderFlow(<GatherScreen />, {
      services: clothingProof(["WA-COV-CLOTHING"]),
      initial: stateFrom(sheetsIn("WA")),
    });
    expect(
      await screen.findByRole("group", {
        name: /^Did this replace clothing or footwear lost or damaged during emergency treatment for injuries\?/,
      }),
    ).toBeTruthy();
  });

  it("asks DC about clothing kept as evidence, since its rule names no bedding", async () => {
    renderFlow(<GatherScreen />, { services: clothingProof(["DC-CAP-8"]), initial: stateFrom(sheetsIn("DC")) });
    expect(await screen.findByRole("group", { name: /^Did this replace clothing kept as evidence\?/ })).toBeTruthy();
  });

  it("asks Texas about evidence or the investigation, as both its rules do", async () => {
    renderFlow(<GatherScreen />, {
      services: clothingProof(["TX-SEIZED-1", "TX-SEIZED-2"]),
      initial: stateFrom(sheetsIn("TX")),
    });
    expect(
      await screen.findByRole("group", {
        name: /^Did this replace clothing or bedding kept as evidence or ruined by the investigation\?/,
      }),
    ).toBeTruthy();
  });

  // The condition is read from the state's law file, which loads apart from the engine. Without it, a
  // yes to the plain question would count the cost without the condition, so the row waits.
  it("holds the question while the state's law has not loaded", async () => {
    // fetchLaw keeps a failed load for the rest of the visit; no other test in this file loads Wisconsin.
    const served = stubLawFetch();
    const requests = vi.fn(async (url: string) =>
      url === "/data/law/WI.json" ? new Response("not found", { status: 404 }) : served(url),
    );
    vi.stubGlobal("fetch", requests);
    renderFlow(<GatherScreen />, { services: clothingProof(["WI-CAP-3"]), initial: stateFrom(sheetsIn("WI")) });
    await waitFor(() => expect(document.querySelector('li[data-status="needs_confirmation"]')).not.toBeNull());
    expect(await fetchLaw("WI")).toBeNull();
    expect(requests).toHaveBeenCalledWith("/data/law/WI.json");
    const row = document.querySelector<HTMLElement>('li[data-status="needs_confirmation"]')!;
    expect(within(row).getByText("Needs your answer")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /^Did this replace clothing/ })).toBeNull();
  });
});

// The engine answers at once; Michigan's law file took about 1.5 s on a phone's first visit.
describe("bill triage while the law loads", () => {
  afterEach(() => resetLawCacheForTests());

  const serve = (law: Promise<Response | null>) => {
    resetLawCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/data/law/MI.json" ? ((await law) ?? new Response("gone", { status: 404 })) : notFound(),
      ),
    );
  };
  const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  const held = "Medical forensic exam, deductible applied, $325.00. Michigan law says you should not be billed for it.";

  it("says it is still checking, not half a sentence, until the law's words arrive", async () => {
    let release!: () => void;
    serve(new Promise((r) => (release = () => r(new Response(MI_BYTES, { status: 200 })))));
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill) });
    // The engine has decided: the bill already shows the rest.
    expect(await screen.findByText("The rest")).toBeTruthy();
    expect(screen.getByText(/^Checking each line against the law\./)).toBeTruthy();
    expect(screen.queryByText(/law says you should not be billed for it/)).toBeNull();
    expect(screen.queryByText(/MI-EXAM-\d/)).toBeNull();
    expect(screen.queryByText("The program can tell you who pays.")).toBeNull();

    await act(async () => release());
    expect(await screen.findByText(held)).toBeTruthy();
    const noBill = MI_LAW.rules.find((r) => r.id === "MI-EXAM-1")!;
    // The citation names the law, not a rule id.
    expect(
      screen.getByRole("button", { name: new RegExp(`^${noBill.pinpoint.replace(/[().]/g, "\\$&")}`) }),
    ).toBeTruthy();
    const payer = MI_LAW.rules.find((r) => r.category === "exam_payment" && typeof r.params?.payer === "string");
    expect(screen.getByText(String(payer!.params!.payer))).toBeTruthy();
  });

  it("names the state from the list of states when the law cannot load", async () => {
    serve(Promise.resolve(null));
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill) });
    expect(await screen.findByText(held)).toBeTruthy();
  });

  // An urgent care bill with no exam line: nothing on it is held.
  const care: BillReading = {
    status: "ok",
    provider: "Northside Urgent Care",
    total_cents: 24000,
    lines: [
      { line_id: "1", description: "Urgent care visit", amount_cents: 15000, expense: "medical" },
      { line_id: "2", description: "X-ray, wrist", amount_cents: 9000, expense: "medical" },
    ],
    sums_match: true,
    source: "rule",
  };
  const withCare: Action[] = [
    MI_CHECK,
    {
      type: "addBill",
      bill: { ...bill, id: "bill-care", label: "care.txt", reading: care, sample: false },
      items: care.lines.map((l, i) => ({
        ...billLines[0],
        item_id: `bill:care:${l.line_id}`,
        amount_cents: l.amount_cents,
        expense: l.expense,
        description: l.description,
        merchant: "Northside Urgent Care",
        bill_id: "bill-care",
        line_no: i + 1,
      })),
    },
  ];

  it("explains a bill with nothing held only from law that loaded", async () => {
    serve(Promise.resolve(null));
    renderFlow(<BillsScreen />, { initial: stateFrom(withCare) });
    // The engine's answer stands without the law's words.
    expect(await screen.findByRole("heading", { name: "No line on this bill is held" })).toBeTruthy();
    // Michigan has an exam billing rule; a law file that did not load says nothing about it.
    expect(MI_LAW.rules.some((r) => r.category === "exam_no_bill")).toBe(true);
    expect(screen.queryByText(/verified rules have no exam billing rule/)).toBeNull();
    expect(screen.queryByText(/exam billing rules don't apply/)).toBeNull();
  });

  it("gives the reason once the law's words are here", async () => {
    serve(Promise.resolve(new Response(MI_BYTES, { status: 200 })));
    renderFlow(<BillsScreen />, { initial: stateFrom(withCare) });
    expect(
      await screen.findByText("None of its lines is a forensic exam, so the exam billing rules don't apply to it."),
    ).toBeTruthy();
  });
});

// Every screen's citation chip, not only the bill's: "Why" until the law's words load, then the law.
describe("a citation while the law loads", () => {
  const index = (law: Jurisdiction | null, missing = false): LawIndex => ({
    law,
    missing,
    sha256: null,
    rule: (id) => law?.rules.find((r) => r.id === id),
    source: (id) => law?.sources.find((s) => s.id === id),
    byCategory: (c) => law?.rules.filter((r) => r.category === c) ?? [],
  });
  const ids = ["MI-EXAM-1", "MI-EXAM-5"];
  const chip = () => screen.getByRole("button", { name: /show the law for the exam line$/ });

  it("says Why, with no rule id and no count, until the law's words are here", async () => {
    renderFlow(<Cite ruleIds={ids} law={index(null)} subject="the exam line" />);
    expect(chip().textContent).toBe("Why: show the law for the exam line");
    fireEvent.click(chip());
    expect(await screen.findByText("Loading")).toBeTruthy();
  });

  it("then names the law", () => {
    renderFlow(<Cite ruleIds={ids} law={index(MI_LAW)} subject="the exam line" />);
    const pinpoint = MI_LAW.rules.find((r) => r.id === "MI-EXAM-1")!.pinpoint;
    expect(chip().textContent).toBe(`${pinpoint} +1: show the law for the exam line`);
  });

  it("shows the rule ids when the law cannot load, and says they did not load instead of Loading", async () => {
    renderFlow(<Cite ruleIds={ids} law={index(null, true)} subject="the exam line" />);
    expect(chip().textContent).toBe("MI-EXAM-1 +1: show the law for the exam line");
    fireEvent.click(chip());
    expect(await screen.findByText("Some rules did not load: MI-EXAM-1, MI-EXAM-5")).toBeTruthy();
    expect(screen.queryByText("Loading")).toBeNull();
  });
});
