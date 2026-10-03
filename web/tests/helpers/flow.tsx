// Renders flow screens with the thin mocks from lib/mocks and Michigan's real verified rules.
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { FlowProvider } from "@/components/flow/FlowProvider";
import { accountLabel, type FlowServices } from "@/components/flow/services";
import { demoBankTxns, ROWAN_ACCOUNT } from "@/components/flow/samples";
import { initialState, reducer, type Action, type FlowState } from "@/components/flow/state";
import { I18nProvider, type Lang } from "@/lib/i18n";
import {
  mockBillReader,
  mockClassifier,
  mockPacketBuilder,
  mockShare,
  mockStatementParser,
  mockVault,
} from "@/lib/mocks";
import { mockEngineOutput } from "@/lib/mocks/engine";
import type { EngineInput, EngineOutput, Jurisdiction } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "../..");
export const MI_BYTES = readFileSync(path.join(web, "public/data/law/MI.json"));
export const MI_LAW = JSON.parse(MI_BYTES.toString("utf8")) as Jurisdiction;
export const TODAY = "2026-10-03";

// The mock engine speaks in made-up rule ids; these point them at Michigan's real rules so the
// citations open real quotes.
const COVER: Record<string, string> = {
  medical: "MI-COV-1",
  counseling: "MI-COV-2",
  lost_wages: "MI-COV-3",
  relocation: "MI-COV-4",
  transportation: "MI-COV-7",
  security: "MI-CAP-9",
  clothing_bedding: "MI-CAP-10",
  prescription: "MI-COV-1",
};
const RENAME: Record<string, string> = {
  "ZZ-FILE-1": "MI-FILE-1",
  "ZZ-REPORT-1": "MI-REPORT-1",
  "ZZ-EXAM-1": "MI-EXAM-1",
  "ZZ-EXAM-2": "MI-EXAM-2",
  "ZZ-EXCL-1": "MI-EXCL-1",
  "ZZ-CAP-1": "MI-CAP-3",
};

export function michiganOutput(input: EngineInput): EngineOutput {
  const out = mockEngineOutput(input);
  const map = (id: string) => RENAME[id] ?? (id.startsWith("ZZ-COV-") ? (COVER[id.slice(7)] ?? id) : id);
  return {
    ...out,
    lines: out.lines.map((l) => ({ ...l, rule_ids: l.rule_ids.map(map), cap_rule_id: l.cap_rule_id && map(l.cap_rule_id) })),
    checks: {
      deadline: { ...out.checks.deadline, rule_ids: out.checks.deadline.rule_ids.map(map) },
      minimum_loss: out.checks.minimum_loss,
      reporting: { ...out.checks.reporting, rule_ids: out.checks.reporting.rule_ids.map(map) },
    },
  };
}

export type TestServices = FlowServices & { vault: ReturnType<typeof mockVault>; share: ReturnType<typeof mockShare> };

export function testServices(over: Partial<FlowServices> = {}): TestServices {
  const vault = mockVault();
  return {
    statementParser: mockStatementParser,
    classifier: mockClassifier,
    billReader: mockBillReader(),
    vault,
    share: mockShare(),
    packetBuilder: mockPacketBuilder(async () => MI_LAW),
    evaluate: vi.fn(async (input: EngineInput) => ({
      output: michiganOutput(input),
      backend: "wasm" as const,
      detail: "test",
    })),
    bank: async () => ({ ...demoBankTxns(), account: ROWAN_ACCOUNT }),
    propose: vi.fn(async (req) => ({
      action_id: "a1",
      amount_cents: req.amount_cents,
      from: accountLabel(req.from),
      payee: req.payee,
      confirm_code: "123456",
      expires_at: "2026-10-03T23:00:00Z",
      demo: false,
    })),
    confirm: vi.fn(async (actionId: string, code: string) => {
      if (code !== "123456") throw new Error("That code does not match.");
      return {
        action_id: actionId,
        status: "done",
        amount_cents: 11800,
        nessie_id: "nessie-w-1",
        read_back_matches: true,
        at: "2026-10-03T17:00:00Z",
      };
    }),
    passkeySupported: () => false,
    ...over,
  } as TestServices;
}

export function stateFrom(actions: Action[], lang: Lang = "en"): FlowState {
  return actions.reduce(reducer, initialState(lang));
}

export const MI_CHECK: Action = {
  type: "check",
  patch: { st: "MI", date: "2026-06-14", exam: "yes", police: "not_yet" },
};

// Serves Michigan's law file; everything else (the API probe) is "not found", so no server exists.
export function stubLawFetch() {
  const fn = vi.fn(async (url: string) =>
    url === "/data/law/MI.json"
      ? new Response(MI_BYTES, { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404, headers: { "content-type": "text/html" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function renderFlow(
  ui: ReactNode,
  { services = testServices(), initial, lang = "en" }: { services?: TestServices; initial?: FlowState; lang?: Lang } = {},
) {
  const view = render(
    <I18nProvider initial={lang}>
      <FlowProvider services={services} today={TODAY} initial={initial}>
        {ui}
      </FlowProvider>
    </I18nProvider>,
  );
  return { ...view, services };
}
