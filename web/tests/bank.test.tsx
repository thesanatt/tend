// @vitest-environment jsdom
// The demo bank in Track (components/bank): the program's demo payment and the bank records panel. Both
// show only when the flow connected the demo bank, say they are a demo, and read or write the bank only
// when asked, which the privacy line records. The API is a stand-in fetch; the flow and its reducer are real.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoPersona, type Activity } from "@/components/bank/api";
import { BANK_TEXT, type BankText } from "@/components/bank/strings";
import PrivacyLine from "@/components/flow/PrivacyLine";
import { ROWAN_ACCOUNT } from "@/components/flow/samples";
import type { Action, FlowItem } from "@/components/flow/state";
import TrackScreen from "@/components/flow/track/TrackScreen";
import { dataMode, resetDataModeForTests } from "@/lib/api";
import { MI_BYTES, MI_CHECK, renderFlow, stateFrom } from "./helpers/flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/track",
}));

function session(id: string, date: string): FlowItem {
  return {
    item_id: `nessie:${id}`,
    date,
    amount_cents: 4000,
    expense: "counseling",
    confirmed: true,
    insurance_paid_cents: 0,
    is_bill: false,
    units: 1,
    unit: "session",
    tags: [],
    description: "session",
    source: "rule",
    reason: "A counseling provider charge",
    confidence: 0.95,
    origin: "bank",
    merchant: "Clearwater Counseling Group",
  };
}

const BANK_SOURCE = {
  id: "bank",
  kind: "bank" as const,
  label: "Checking",
  read: 2,
  found: 2,
  warnings: [],
  sample: true,
};
const fromBank: Action[] = [
  MI_CHECK,
  {
    type: "addSource",
    source: BANK_SOURCE,
    items: [session("s1", "2026-06-17"), session("s2", "2026-06-24")],
    account: ROWAN_ACCOUNT,
  },
];
const fromStatement: Action[] = [
  MI_CHECK,
  {
    type: "addSource",
    source: { ...BANK_SOURCE, id: "stmt:1", kind: "statement" },
    items: [session("s1", "2026-06-17")],
  },
];

const ACTIVITY: Activity = {
  persona_id: "rowan-mi",
  fictional: true,
  notice: "Fictional demo data on Capital One's Nessie mock bank.",
  source: "live",
  source_error: null,
  read_at: "2026-10-03T21:00:00Z",
  bank_mode: "nessie",
  customer: { id: "27b3870f-0f5a-429d-8640-54aba63d9f81" },
  accounts: [
    {
      id: ROWAN_ACCOUNT.id,
      type: "Checking",
      nickname: "Checking",
      mask: "0011",
      nessie_balance_cents: 285000,
      ledger: {
        opening_cents: 285000,
        terms: [
          { key: "deposits", sign: 1, count: 15, cents: 903200 },
          { key: "purchases", sign: -1, count: 162, cents: 1016800 },
          { key: "withdrawals", sign: -1, count: 7, cents: 41800 },
          { key: "transfers_out", sign: -1, count: 6, cents: 24000 },
          { key: "transfers_in", sign: 1, count: 2, cents: 55000 },
        ],
        not_counted: 0,
        computed_cents: 469300,
        reconciled: true,
      },
      not_shown: 0,
    },
  ],
  bills: [
    {
      id: "c1398337-ac9d-4216-a449-ab7ac2a9e9b4",
      payee: "Riverbend General Hospital",
      account_id: ROWAN_ACCOUNT.id,
      status: "pending",
      amount_cents: 32500,
      nickname: "Riverbend General statement: $325.00 held under MCL 18.355a(2) (MI-EXAM-1). Do not pay.",
      nickname_changed: false,
      due_date: "2026-10-20",
      itemized_total_cents: 44300,
      payments: [
        {
          withdrawal_id: "fc5913f8-01f6",
          date: "2026-10-04",
          amount_cents: 11800,
          action_id: "act_c0ffee",
          lines: [1, 3],
        },
      ],
      paid_cents: 11800,
      expected_cents: 32500,
      held: { cents: 32500, rule_ids: ["MI-EXAM-1"], note: "$325.00 held under MCL 18.355a(2) (MI-EXAM-1)" },
      in_bank: true,
      reconciled: true,
    },
  ],
  tend_writes: [
    {
      id: "fc5913f8-01f6",
      kind: "withdrawal",
      account: "Checking 0011",
      date: "2026-10-04",
      amount_cents: 11800,
      status: "completed",
      description: null,
      merchant: null,
      to: null,
      source: "tend",
      changed: false,
      tend: {
        what: "payment",
        payee: "Riverbend General Hospital",
        action_id: "act_c0ffee",
        bill_id: "c1398337",
        bill_lines: [1, 3],
      },
    },
    {
      id: "f581cc53",
      kind: "deposit",
      account: "Checking 0011",
      date: "2026-10-04",
      amount_cents: 400800,
      status: "completed",
      description: null,
      merchant: null,
      to: null,
      source: "tend",
      changed: false,
      tend: { what: "demo_payout", program: "Michigan Crime Victim Compensation", st: "MI" },
    },
  ],
  records: {
    purchase: [
      {
        id: "72a94d59",
        kind: "purchase",
        account: "Checking 0011",
        date: "2026-04-01",
        amount_cents: 1900,
        status: "completed",
        description: "groceries",
        merchant: "Larkfield Market",
        to: null,
        source: "seed",
        changed: false,
      },
    ],
    deposit: [],
    withdrawal: [],
    transfer: [],
  },
  hidden_count: 0,
  dry_run_writes: [],
  calls: [
    { method: "GET", path: "/customers/27b3870f-0f5a-429d-8640-54aba63d9f81/accounts", status: 200, ms: 84, count: 2 },
    { method: "GET", path: `/accounts/${ROWAN_ACCOUNT.id}/purchases`, status: 200, ms: 120, count: 162 },
  ],
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The law file always; the API only when `api` is on, with `handler` answering the bank routes.
function stubFetch(api: boolean, handler: Handler = () => undefined) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/data/law/MI.json")
      return new Response(MI_BYTES, { status: 200, headers: { "content-type": "application/json" } });
    if (api && url === "/api/jurisdictions") return json([{ st: "MI", name: "Michigan", rules: 40, sources: 9 }]);
    const answer = api ? handler(url, init) : undefined;
    return answer ?? new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const PAYOUT = {
  deposit_id: "f581cc53-0cff-4cc3-a892-6437c6bb8b96",
  amount_cents: 8000,
  requested_cents: 8000,
  program: "Michigan Crime Victim Compensation",
  st: "MI",
  account: { id: ROWAN_ACCOUNT.id, nickname: "Checking", mask: "0011" },
  date: "2026-10-03",
  dry_run: false,
  read_back_matches: true,
  replayed: false,
  fictional: true,
  message: "Demo: Nessie recorded a deposit.",
};

const calls = (fn: ReturnType<typeof stubFetch>, part: string, method = "GET") =>
  fn.mock.calls.filter(([url, init]) => String(url).includes(part) && (init?.method ?? "GET") === method);

beforeEach(() => resetDataModeForTests());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("who sees the demo bank", () => {
  it("is the demo persona only when the flow connected the demo bank", () => {
    expect(demoPersona(stateFrom(fromBank))).toBe("rowan-mi");
    expect(demoPersona(stateFrom(fromStatement))).toBeNull();
    const elsewhere = stateFrom([
      MI_CHECK,
      { type: "addSource", source: BANK_SOURCE, items: [], account: { id: "x", nickname: "Mine" } },
    ]);
    expect(demoPersona(elsewhere)).toBeNull();
  });

  it("shows nothing about a bank when the costs came from a statement", async () => {
    stubFetch(true);
    renderFlow(<TrackScreen />, { initial: stateFrom(fromStatement) });
    await screen.findAllByRole("img", { name: /^Sprout: / });
    expect(screen.queryByRole("button", { name: /when the program pays/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the bank records" })).toBeNull();
  });
});

describe("the program's demo payment", () => {
  it("asks the demo bank for a deposit, blooms the plants it covers, and says it is a demo", async () => {
    const fetch = stubFetch(true, (url, init) =>
      url === "/api/bank/rowan-mi/payout" && init?.method === "POST" ? json(PAYOUT) : undefined,
    );
    renderFlow(
      <>
        <PrivacyLine />
        <TrackScreen />
      </>,
      { initial: stateFrom(fromBank) },
    );
    expect(await screen.findAllByRole("img", { name: /^Sprout: / })).toHaveLength(2);
    expect(
      screen.getByText(/Demo amount: \$80\.00, what your claim asks for now\. The program decides\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show what it looks like when the program pays (demo)" }));
    expect(
      await screen.findByText("Demo: Michigan Crime Victim Compensation paid $80.00 into your account."),
    ).toBeTruthy();
    expect(screen.getByText(`Nessie, the demo bank, recorded it as deposit ${PAYOUT.deposit_id}.`)).toBeTruthy();
    expect(screen.getByText("It is not real money. The program decides what it pays, and when.")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Bloom: / })).toHaveLength(2);
    expect(screen.getAllByText("Paid in the demo")).toHaveLength(2);
    const [[, init]] = calls(fetch, "/payout", "POST");
    expect(JSON.parse(String(init?.body))).toEqual({ st: "MI", amount_cents: 8000 });
    expect(screen.getByText("On this device, except what you chose to send: a payment.")).toBeTruthy();
  });

  it("undoes the demo payment in the bank and in the garden", async () => {
    const fetch = stubFetch(true, (url, init) =>
      url === "/api/bank/rowan-mi/payout"
        ? init?.method === "DELETE"
          ? json({ deleted: [PAYOUT.deposit_id] })
          : json(PAYOUT)
        : undefined,
    );
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    fireEvent.click(await screen.findByRole("button", { name: /when the program pays \(demo\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo the demo payment" }));
    expect(await screen.findByRole("button", { name: /when the program pays \(demo\)/ })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Sprout: / })).toHaveLength(2);
    expect(calls(fetch, "/payout", "DELETE")).toHaveLength(1);
  });

  it("without the demo bank, blooms the plants and says nothing was recorded", async () => {
    const fetch = stubFetch(false);
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    fireEvent.click(await screen.findByRole("button", { name: /when the program pays \(demo\)/ }));
    expect(await screen.findByText(/Tend is not connected to the demo bank, so nothing was recorded\./)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Bloom: / })).toHaveLength(2);
    expect(calls(fetch, "/payout", "POST")).toHaveLength(0);
  });

  it("with Wi-Fi off after the API was reached, sends nothing and blooms the plants here", async () => {
    const fetch = stubFetch(true, (url) => (url === "/api/bank/rowan-mi/payout" ? json(PAYOUT) : undefined));
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    await screen.findAllByRole("img", { name: /^Sprout: / });
    await dataMode(); // the mode is cached as live, as it is mid-demo
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /when the program pays \(demo\)/ }));
    expect(await screen.findByText(/Tend is not connected to the demo bank, so nothing was recorded\./)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /^Bloom: / })).toHaveLength(2);
    expect(calls(fetch, "/payout", "POST")).toHaveLength(0);
  });

  it("records the request on the privacy line even when the bank refuses it", async () => {
    stubFetch(true, (url) =>
      url === "/api/bank/rowan-mi/payout" ? json({ detail: "The bank did not answer." }, 502) : undefined,
    );
    renderFlow(
      <>
        <PrivacyLine />
        <TrackScreen />
      </>,
      { initial: stateFrom(fromBank) },
    );
    fireEvent.click(await screen.findByRole("button", { name: /when the program pays \(demo\)/ }));
    await screen.findByRole("alert");
    expect(screen.getByText("On this device, except what you chose to send: a payment.")).toBeTruthy();
  });

  it("says why when the bank refuses, and nothing blooms", async () => {
    stubFetch(true, (url) =>
      url === "/api/bank/rowan-mi/payout"
        ? json({ detail: "A demo payment of $40.00 is already in this account. Undo it first." }, 409)
        : undefined,
    );
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    fireEvent.click(await screen.findByRole("button", { name: /when the program pays \(demo\)/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The demo payment did not work: A demo payment of $40.00 is already in this account. Undo it first.",
    );
    expect(screen.getAllByRole("img", { name: /^Sprout: / })).toHaveLength(2);
  });
});

describe("the bank records panel", () => {
  it("reads the bank only when asked, then shows the ledger, the bill, Tend's writes, and the calls", async () => {
    const fetch = stubFetch(true, (url) => (url === "/api/bank/rowan-mi/activity" ? json(ACTIVITY) : undefined));
    renderFlow(
      <>
        <PrivacyLine />
        <TrackScreen />
      </>,
      { initial: stateFrom(fromBank) },
    );
    await screen.findAllByRole("img", { name: /^Sprout: / });
    expect(calls(fetch, "/activity")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show the bank records" }));
    const panel = screen.getByRole("region", { name: /Bank records \(demo\)/ });
    const checking = await within(panel).findByRole("article", { name: "Checking 0011" });
    expect(within(checking).getByText(ROWAN_ACCOUNT.id)).toBeTruthy();
    expect(within(checking).getByText("162 purchases")).toBeTruthy();
    expect(within(checking).getByText("$4,693.00")).toBeTruthy();
    expect(within(checking).getByText("Adds up")).toBeTruthy();
    const bill = within(panel).getByRole("article", { name: "Bill from Riverbend General Hospital" });
    expect(within(bill).getByText("Paid lines 1 and 3, withdrawal fc5913f8-01f6")).toBeTruthy();
    expect(
      within(bill).getByText("Held: $325.00 held under MCL 18.355a(2) (MI-EXAM-1). Tend will not pay it."),
    ).toBeTruthy();
    expect(within(bill).getByText("Matches")).toBeTruthy();
    expect(within(panel).getByText("Payment to Riverbend General Hospital. For bill lines 1 and 3")).toBeTruthy();
    expect(within(panel).getByText("Michigan Crime Victim Compensation, demo payment")).toBeTruthy();
    expect(within(panel).getByText("The API calls behind this view (2)")).toBeTruthy();
    expect(within(panel).getByText(`GET /accounts/${ROWAN_ACCOUNT.id}/purchases`)).toBeTruthy();
    expect(screen.getByText("On this device, except what you chose to send: a request to the bank.")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Read them again" }));
    await waitFor(() => expect(calls(fetch, "/activity")).toHaveLength(2));
    // The panel's own report and the net log's are one send in the list, not two or three.
    fireEvent.click(screen.getByRole("button", { name: /What stays here/ }));
    expect(await screen.findAllByText(/a request to the bank for your transactions\./)).toHaveLength(1);
  });

  it("says so when Tend is not connected to the demo bank", async () => {
    stubFetch(false);
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    fireEvent.click(await screen.findByRole("button", { name: "Show the bank records" }));
    expect(await screen.findByText(/Tend is not connected to the demo bank here/)).toBeTruthy();
  });

  it("with Wi-Fi off, reads nothing and says there is nothing to show", async () => {
    const fetch = stubFetch(true, (url) => (url === "/api/bank/rowan-mi/activity" ? json(ACTIVITY) : undefined));
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    await dataMode();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Show the bank records" }));
    expect(await screen.findByText(/Tend is not connected to the demo bank here/)).toBeTruthy();
    expect(calls(fetch, "/activity")).toHaveLength(0);
  });

  it("shows nothing from an answer that is not fictional demo data", async () => {
    stubFetch(true, (url) =>
      url === "/api/bank/rowan-mi/activity" ? json({ ...ACTIVITY, fictional: false }) : undefined,
    );
    renderFlow(<TrackScreen />, { initial: stateFrom(fromBank) });
    fireEvent.click(await screen.findByRole("button", { name: "Show the bank records" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Tend could not read the demo bank");
    expect(screen.queryByText("Adds up")).toBeNull();
  });
});

// The same rules as tests/i18n.test.ts, for these strings.
type Tree = Record<string, unknown>;
const SAMPLE: Record<string, unknown[]> = {
  "activity.term": ["purchases", 3],
  "activity.kind": ["purchase", 3],
  "activity.callNote": [84, 3],
};
function leaves(node: unknown, at = ""): [string, string][] {
  if (typeof node === "string") return [[at, node]];
  if (typeof node === "function") {
    const args = SAMPLE[at] ?? Array.from({ length: node.length }, (_, i) => (i % 2 ? 3 : "X"));
    const out = (node as (...a: unknown[]) => unknown)(...args);
    return typeof out === "string" ? [[`${at}()`, out]] : [];
  }
  if (node && typeof node === "object")
    return Object.entries(node as Tree).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
  return [];
}
function shape(node: unknown): unknown {
  if (typeof node === "function") return `fn/${node.length}`;
  if (node && typeof node === "object")
    return Object.fromEntries(Object.entries(node as Tree).map(([k, v]) => [k, shape(v)]));
  return typeof node;
}
const BANNED = new RegExp(
  `[${[0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c)).join("")}]`,
);
const HYPE =
  /\b(elevate|empower|unlock|seamless(ly)?|cutting-edge|robust|journey|revolutionize|supercharge|game-?changer)\b/i;

describe("the demo bank's words", () => {
  const en = leaves(BANK_TEXT.en);
  const es = leaves(BANK_TEXT.es);

  it("has the same keys and arguments in Spanish, every string translated", () => {
    expect(shape(BANK_TEXT.es)).toEqual(shape(BANK_TEXT.en));
    const english = new Map(en);
    expect(es.filter(([k, v]) => english.get(k) === v).map(([k]) => k)).toEqual([]);
    expect([...en, ...es].filter(([, v]) => !v.trim())).toEqual([]);
  });

  it("follows the copy rules: no dashes, curly quotes, exclamation marks, or hype words", () => {
    for (const [k, v] of [...en, ...es]) {
      expect(BANNED.test(v), k).toBe(false);
      expect(v.includes("!"), k).toBe(false);
      expect(HYPE.test(v), k).toBe(false);
    }
  });

  it("calls the payment a demo and leaves the decision with the program", () => {
    const p: BankText["payout"] = BANK_TEXT.en.payout;
    expect(p.button).toContain("(demo)");
    expect(p.decides).toContain("The program decides");
    expect(BANK_TEXT.es.payout.decides).toContain("El programa decide");
  });
});
