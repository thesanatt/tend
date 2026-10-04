// @vitest-environment jsdom
// The flow on the real on-device modules where they meet: one statement in two formats, rows the
// rules cannot sort from before the date, the demo bank's own kinds, bills paid through Tend, the
// net log behind the privacy line, offline payments, cloud AI consent, and Track's deadline note.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillsScreen from "@/components/flow/bills/BillsScreen";
import { buildEngineInput, buildRows, offered, paidLines } from "@/components/flow/claim";
import CloudConsent from "@/components/flow/CloudConsent";
import { FlowProvider, useFlow } from "@/components/flow/FlowProvider";
import AddRecords from "@/components/flow/gather/AddRecords";
import PrivacyLine from "@/components/flow/PrivacyLine";
import { demoBankTxns, ROWAN_ACCOUNT, sampleStatementCsv } from "@/components/flow/samples";
import { ROWAN_ROWS } from "@/components/flow/samples/rowan";
import { initialState, reducer, type Action, type BillRecord, type FlowItem, type FlowState } from "@/components/flow/state";
import TrackScreen from "@/components/flow/track/TrackScreen";
import { packetLineInfo } from "@/components/flow/usePacket";
import { DICTS, I18nProvider } from "@/lib/i18n";
import { classifier, statementParser } from "@/lib/local";
import { mockEngineOutput } from "@/lib/mocks/engine";
import { SAMPLE_BILL_READING } from "@/lib/mocks";
import { classifyRequest, installNetLog, netSends, onNetSend, resetNetLogForTests } from "@/lib/netlog";
import { buildLetters, LawBook, stillNeeded } from "@/lib/packet";
import { MI_CHECK, MI_LAW, michiganOutput, renderFlow, stateFrom, stubLawFetch, testServices, TODAY } from "./helpers/flow";

const { en, es } = DICTS;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/gather",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  resetNetLogForTests();
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});

const goOffline = () => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });

// Rowan's month as an OFX export from the same bank: payee in NAME, detail in MEMO, upper case.
function rowanOfx(): string {
  const OUT = new Set(["purchase", "withdrawal", "transfer", "bill"]);
  const TYPE: Record<string, string> = { deposit: "DIRECTDEP", withdrawal: "ATM", transfer: "XFER", purchase: "POS" };
  const trns = ROWAN_ROWS.map(([date, kind, cents, merchant, description], i) => {
    const signed = OUT.has(kind) ? -cents : cents;
    return [
      "<STMTTRN>",
      `<TRNTYPE>${TYPE[kind] ?? "OTHER"}`,
      `<DTPOSTED>${date.replace(/-/g, "")}120000`,
      `<TRNAMT>${(signed / 100).toFixed(2)}`,
      `<FITID>2026${String(i + 1).padStart(5, "0")}`,
      `<NAME>${(merchant || description).toUpperCase()}`,
      `<MEMO>${description.toUpperCase()}`,
      "</STMTTRN>",
    ].join("\n");
  });
  return [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
    "<BANKACCTFROM><ACCTID>0000000011<ACCTTYPE>CHECKING</BANKACCTFROM>",
    "<BANKTRANLIST>",
    ...trns,
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  ].join("\n");
}

// The flow as a value, for driving the provider's readers directly.
function captureFlow(services = testServices(), initial?: FlowState) {
  const box: { flow: ReturnType<typeof useFlow> | null } = { flow: null };
  function Grab() {
    box.flow = useFlow();
    return null;
  }
  render(
    <I18nProvider initial="en">
      <FlowProvider services={services} today={TODAY} initial={initial}>
        <Grab />
      </FlowProvider>
    </I18nProvider>,
  );
  return box;
}

describe("a CSV and an OFX of the same month", () => {
  it("count every cost once, on the real parsers and classifier", async () => {
    const services = testServices({ statementParser, classifier });
    const box = captureFlow(services, stateFrom([MI_CHECK]));
    const csv = new File([sampleStatementCsv()], "rowan.csv", { type: "text/csv" });
    const ofx = new File([rowanOfx()], "rowan.ofx", { type: "application/x-ofx" });
    let first!: Awaited<ReturnType<NonNullable<typeof box.flow>["readStatement"]>>;
    await act(async () => {
      first = await box.flow!.readStatement(csv);
    });
    const before = box.flow!.state.items.length;
    expect(first.found).toBeGreaterThan(30);
    let second!: typeof first;
    await act(async () => {
      second = await box.flow!.readStatement(ofx);
    });
    expect(second.read).toBe(first.read);
    // Every cost the OFX found was already there from the CSV.
    expect(second.found).toBe(0);
    expect(box.flow!.state.items.length).toBe(before);
    const input = buildEngineInput(box.flow!.state, TODAY)!;
    const keys = input.items.map((i) => `${i.date}|${i.amount_cents}|${i.description.toLowerCase().replace(/[^a-z]/g, "")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("rows the rules cannot sort", () => {
  const unsorted = (id: string, date: string): FlowItem => ({
    item_id: id,
    date,
    amount_cents: 1100,
    expense: "unknown",
    confirmed: false,
    insurance_paid_cents: 0,
    is_bill: false,
    units: 0,
    unit: null,
    tags: [],
    description: "Hearthstone Pharmacy allergy relief",
    source: "rule",
    reason: "Could not sort this one; review it by hand",
    confidence: 0,
    origin: "statement",
  });
  const source = { id: "stmt:abc", kind: "statement" as const, label: "s.csv", read: 2, found: 2, warnings: [], sample: true };

  it("are not offered, or sent to the engine, when they are from before the date", () => {
    const state = stateFrom([
      MI_CHECK,
      { type: "addSource", source, items: [unsorted("stmt:abc:1", "2026-04-20"), unsorted("stmt:abc:2", "2026-06-20")] },
    ]);
    expect(offered(state, state.items[0], TODAY)).toBe(false);
    expect(buildRows(state, null).map((r) => r.item.item_id)).toEqual(["stmt:abc:2"]);
    expect(buildEngineInput(state, TODAY)!.items.map((i) => i.item_id)).toEqual(["stmt:abc:2"]);
  });

  it("are still offered when the date is not known", () => {
    const state = stateFrom([
      { type: "check", patch: { st: "MI", dateUnsure: true } },
      { type: "addSource", source, items: [unsorted("stmt:abc:1", "2026-04-20")] },
    ]);
    expect(buildRows(state, null)).toHaveLength(1);
  });
});

describe("the demo bank", () => {
  it("carries Nessie's kinds and categories, so moves between Rowan's own accounts are never costs", async () => {
    const { txns } = demoBankTxns();
    expect(txns.filter((t) => t.kind === "transfer").map((t) => t.description)).toEqual(
      expect.arrayContaining(["Save to Cushion", "Move to checking"]),
    );
    expect(txns.find((t) => t.merchant === "Wayfare Rides")?.category).toBe("rideshare");
    expect(txns.at(-1)).toMatchObject({ kind: "bill", amount_cents: 44300, merchant: "Riverbend General Hospital" });
    const items = await classifier.classify(txns, { st: "MI", incident_date: "2026-06-14" });
    expect(items.some((i) => /Save to Cushion|Move to checking/.test(i.description))).toBe(false);
    expect(items.find((i) => i.amount_cents === 44300)).toMatchObject({ is_bill: true, expense: "medical" });
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
const bill: BillRecord = { id: "bill-abc", label: "riverbend.pdf", reading: SAMPLE_BILL_READING, replaces: null, choice: null, sample: true };
const bank: Action = {
  type: "addSource",
  source: { id: "bank", kind: "bank", label: "Checking", read: 0, found: 0, warnings: [], sample: true },
  items: [],
  account: ROWAN_ACCOUNT,
};
const paid: Action = {
  type: "payment",
  record: {
    action_id: "a1",
    bill_id: "bill-abc",
    item_ids: [billLines[0].item_id, billLines[2].item_id],
    amount_cents: 11800,
    payee: "Riverbend General Hospital",
    from: "Checking 0011",
    status: "done",
    demo: false,
    at: "2026-10-03T17:00:00Z",
  },
};

describe("a bill paid through Tend", () => {
  const state = stateFrom([MI_CHECK, { type: "addBill", bill, items: billLines }, bank, paid]);

  it("goes to the engine as money spent, not an unpaid bill, with the same amounts", () => {
    const input = buildEngineInput(state, TODAY)!;
    const byId = new Map(input.items.map((i) => [i.item_id, i]));
    expect(byId.get(billLines[0].item_id)).toMatchObject({ is_bill: false, amount_cents: 7500 });
    expect(byId.get(billLines[2].item_id)).toMatchObject({ is_bill: false, amount_cents: 4300 });
    // The held exam line was not paid: it is still a bill the law says not to pay.
    expect(byId.get(billLines[1].item_id)).toMatchObject({ is_bill: true, amount_cents: 32500 });
    expect([...paidLines(state).keys()].sort()).toEqual([billLines[0].item_id, billLines[2].item_id].sort());
  });

  it("tells the packet who sent the bill and who paid which line", () => {
    const info = packetLineInfo(state);
    expect(info[billLines[1].item_id]).toEqual({ provider: "Riverbend General Hospital" });
    expect(info[billLines[0].item_id]).toEqual({
      provider: "Riverbend General Hospital",
      paid: { at: "2026-10-03T17:00:00Z", from: "Checking 0011", to: "Riverbend General Hospital" },
    });
  });

  it("names the hospital on the billing letter, and still counts the paid lines as itemized", () => {
    const input = buildEngineInput(state, TODAY)!;
    const output = michiganOutput(input);
    const law = new LawBook(MI_LAW);
    const info = packetLineInfo(state);
    const [hold] = buildLetters(law, input, output, { lines: info }).filter((l) => l.kind === "billing_hold");
    expect(hold.body).toContain("To: Billing office, Riverbend General Hospital");
    expect(hold.body).not.toContain("[hospital or clinic name]");
    const letters = buildLetters(law, input, output, { lines: info });
    expect(letters.some((l) => l.kind === "itemized_bill_request")).toBe(false);
    const itemized = stillNeeded(law, input, output, {}, info).find((c) => /itemized/i.test(c.document));
    if (itemized) expect(itemized.have_it).toBe(true);
    // Without the provider the letter keeps its placeholder.
    const [plain] = buildLetters(law, input, output).filter((l) => l.kind === "billing_hold");
    expect(plain.body).toContain("[hospital or clinic name]");
  });
});

describe("the net log behind the privacy line", () => {
  const origin = "http://localhost";
  it("names only what carries something off the device", () => {
    const u = (p: string) => new URL(p, origin);
    expect(classifyRequest("GET", u("/data/law/MI.json"), origin)).toBeNull();
    expect(classifyRequest("GET", u("/engine/laws/MI.tlaw"), origin)).toBeNull();
    expect(classifyRequest("GET", u("/api/jurisdictions/MI"), origin)).toBeNull();
    expect(classifyRequest("GET", u("/api/bank/rowan-mi/transactions"), origin)).toBe("bank");
    expect(classifyRequest("POST", u("/api/actions/propose"), origin)).toBe("payment_setup");
    expect(classifyRequest("POST", u("/api/actions/confirm"), origin)).toBe("payment");
    expect(classifyRequest("POST", u("/api/shares"), origin)).toBe("share");
    expect(classifyRequest("POST", u("/api/ai/classify"), origin)).toBe("cloud_rows");
    expect(classifyRequest("POST", u("/api/ai/bill"), origin)).toBe("cloud_bill");
    expect(classifyRequest("POST", u("/api/claim"), origin)).toBe("server_engine");
    expect(classifyRequest("DELETE", u("/api/shares/abc12345"), origin)).toBeNull();
    expect(classifyRequest("POST", u("/somewhere"), origin)).toBe("other");
    expect(classifyRequest("GET", new URL("https://tracker.example/pixel"), origin)).toBe("other");
  });

  it("reports a send with what it carried, and nothing when the device is offline", async () => {
    const fake = vi.fn(async (url: string) =>
      url === "/api/actions/propose"
        ? new Response(JSON.stringify({ action_id: "act-9", amount_cents: 11800, payee: "Riverbend General Hospital" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fake);
    installNetLog(window);
    const seen: string[] = [];
    onNetSend((s) => seen.push(`${s.kind}:${s.ref ?? ""}:${s.amount_cents ?? ""}`));
    await fetch("/data/law/MI.json");
    await fetch("/api/actions/propose", {
      method: "POST",
      body: JSON.stringify({ amount_cents: 11800, payee: "Riverbend General Hospital" }),
    });
    expect(seen).toEqual(["payment_setup:setup:act-9:11800"]);
    goOffline();
    fake.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetch("/api/shares", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(netSends()).toHaveLength(1);
  });

  it("a send no screen announced still shows on the privacy line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    renderFlow(<PrivacyLine />, { initial: stateFrom([MI_CHECK]) });
    expect(screen.getByText(en.privacy.quiet)).toBeTruthy();
    await act(async () => {
      await fetch("/api/ai/classify", { method: "POST", body: "{}" });
    });
    expect(screen.getByText(en.privacy.sent(en.privacy.partCloudRows))).toBeTruthy();
  });
});

describe("paying while offline", () => {
  const setup: Action[] = [MI_CHECK, { type: "addBill", bill, items: billLines }, bank];

  it("says nothing was sent, keeps the privacy line, and tries again", async () => {
    let calls = 0;
    const services = testServices({
      propose: vi.fn(async (req) => {
        calls++;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return {
          action_id: "a1",
          amount_cents: req.amount_cents,
          from: ROWAN_ACCOUNT.id,
          payee: req.payee,
          confirm_code: "123456",
          expires_at: "2026-10-03T23:00:00Z",
          demo: false,
        };
      }),
    });
    renderFlow(
      <>
        <PrivacyLine />
        <BillsScreen />
      </>,
      { services, initial: stateFrom(setup) },
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Pay \$118\.00 now/ }));
    const dialog = await screen.findByRole("dialog");
    goOffline();
    fireEvent.click(within(dialog).getByRole("button", { name: en.pay.getCode }));
    expect(await within(dialog).findByText(en.pay.offline)).toBeTruthy();
    expect(screen.getByText(en.privacy.quiet)).toBeTruthy();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
    fireEvent.click(within(dialog).getByRole("button", { name: en.pay.retry }));
    expect(await within(dialog).findByLabelText(en.pay.codeLabel)).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("a confirm that never left keeps the code and logs no payment", async () => {
    const services = testServices({
      confirm: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    renderFlow(
      <>
        <PrivacyLine />
        <BillsScreen />
      </>,
      { services, initial: stateFrom(setup) },
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Pay \$118\.00 now/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.pay.getCode }));
    fireEvent.change(await within(dialog).findByLabelText(en.pay.codeLabel), { target: { value: "123456" } });
    goOffline();
    fireEvent.click(within(dialog).getByRole("button", { name: en.pay.pay("$118.00") }));
    expect(await within(dialog).findByText(en.pay.offline)).toBeTruthy();
    expect(within(dialog).getByLabelText(en.pay.codeLabel)).toBeTruthy();
    // The code request went out; the payment did not.
    expect(screen.getByText(en.privacy.sent(en.privacy.partSetup(1)))).toBeTruthy();
  });
});

describe("the payment result", () => {
  it("speaks the survivor's language, with the bank service's English note as a detail", async () => {
    const services = testServices({
      confirm: vi.fn(async (actionId: string) => ({
        action_id: actionId,
        status: "done",
        amount_cents: 11800,
        nessie_id: "w-1",
        read_back_matches: true,
        dry_run: false,
        message: "Paid $118.00 to Riverbend General Hospital. Nessie recorded it as withdrawal w-1.",
        at: "2026-10-03T17:00:00Z",
      })),
    });
    renderFlow(<BillsScreen />, { services, initial: stateFrom([MI_CHECK, { type: "addBill", bill, items: billLines }, bank], "es"), lang: "es" });
    fireEvent.click(await screen.findByRole("button", { name: /^Pagar \$118\.00/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.pay.getCode }));
    fireEvent.change(await within(dialog).findByLabelText(es.pay.codeLabel), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.pay.pay("$118.00") }));
    expect(await within(dialog).findByText(es.pay.noteDone("$118.00", "Riverbend General Hospital"))).toBeTruthy();
    const note = within(dialog).getByText(/Nessie recorded it/);
    expect(note.closest("details")).toBeTruthy();
    expect(note.getAttribute("lang")).toBe("en");
  });
});

describe("cloud AI consent", () => {
  it("starts at no, and says what leaves and who gets it", () => {
    const onNo = vi.fn();
    const onYes = vi.fn();
    render(
      <I18nProvider initial="en">
        <CloudConsent ask={{ kind: "rows", rows: 2 }} onNo={onNo} onYes={onYes} />
      </I18nProvider>,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(en.cloud.whatRows(2))).toBeTruthy();
    expect(within(dialog).getByText(en.cloud.whoRows)).toBeTruthy();
    const no = within(dialog).getByRole("button", { name: en.cloud.no });
    expect(document.activeElement === no || no.hasAttribute("autofocus")).toBe(true);
    fireEvent.click(no);
    expect(onNo).toHaveBeenCalled();
    expect(onYes).not.toHaveBeenCalled();
  });

  it("is offered per file only without on-device AI, and a yes re-sorts with consent", async () => {
    const classify = vi.fn(async (txns, ctx, opts?: { cloudConsent?: boolean }) =>
      (await classifier.classify(txns, ctx, { deviceAi: false })).map((i) =>
        opts?.cloudConsent && i.expense === "unknown" && i.description.includes("Linen")
          ? { ...i, expense: "clothing_bedding" as const, source: "cloud_ai" as const, reason: "Bedding" }
          : i,
      ),
    );
    const services = testServices({
      statementParser,
      classifier: { deviceAi: async () => "unavailable", classify },
    });
    renderFlow(<AddRecords />, { services, initial: stateFrom([MI_CHECK]) });
    fireEvent.click(screen.getByRole("button", { name: en.gather.statementSample }));
    const offer = await screen.findByRole("button", { name: en.cloud.offerButton }, { timeout: 10_000 });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][2]).toBeUndefined();
    fireEvent.click(offer);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.cloud.yes }));
    await waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
    expect(classify.mock.calls[1][2]).toEqual({ cloudConsent: true });
    expect(await screen.findByText(en.cloud.sorted(1))).toBeTruthy();
  });
});

describe("Track", () => {
  it("repeats Check's note when the law counts the deadline from the report", async () => {
    const state = stateFrom([MI_CHECK]);
    const services = testServices({
      evaluate: vi.fn(async (input) => {
        const out = michiganOutput(input);
        return {
          output: { ...out, checks: { ...out.checks, deadline: { ...out.checks.deadline, flags: ["deadline_from_report"] } } },
          backend: "wasm" as const,
          detail: "test",
        };
      }),
    });
    renderFlow(<TrackScreen />, { services, initial: state });
    expect(await screen.findByText(en.check.deadlineFromReport)).toBeTruthy();
  });

  it("says nothing extra when the deadline counts from the day it happened", async () => {
    renderFlow(<TrackScreen />, { initial: stateFrom([MI_CHECK]) });
    await screen.findByText(/File by|Ask the program/);
    expect(screen.queryByText(en.check.deadlineFromReport)).toBeNull();
  });
});

// The reducer keeps one event per send, however many places report it.
describe("one send, reported twice", () => {
  it("merges by ref", () => {
    let s = initialState("en");
    s = reducer(s, { type: "sent", event: { kind: "payment", at: "t1", ref: "pay:a1", amount_cents: 11800 } });
    s = reducer(s, { type: "sent", event: { kind: "payment", at: "t2", ref: "pay:a1", dry_run: true } });
    expect(s.sent).toEqual([{ kind: "payment", at: "t1", ref: "pay:a1", amount_cents: 11800, dry_run: true }]);
    void mockEngineOutput;
  });
});
