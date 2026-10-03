"use client";

// The survivor's session lives in this tab only (sessionStorage) and is wiped by Exit this page.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scan as runScan } from "./api";
import { LEFT_KEY, SESSION_KEY } from "./keys";
import { evaluateClaim, type Evaluation } from "./engine";
import type { LineLife } from "./garden";
import type { ActionResult, EngineInput, PoliceReport, ScanResult, ShareLink } from "./types";

export type Answer = "yes" | "no" | "unsure";

export interface StartParams {
  persona_id: string;
  st: string;
  incident_date: string;
  police_report: PoliceReport;
  forensic_exam: boolean | null;
}

export interface PaymentRecord extends ActionResult {
  item_ids: string[];
  payee: string;
  from: string;
}

export interface Session extends StartParams {
  v: 1;
  consented_at: string;
  scan: ScanResult;
  answers: Record<string, Answer>;
  life: Record<string, LineLife>;
  payments: PaymentRecord[];
  share: (ShareLink & { demo: boolean }) | null;
}

export { SESSION_KEY };

export const DEMO: StartParams = {
  persona_id: "rowan",
  st: "MI",
  incident_date: "2026-06-14",
  police_report: "no",
  forensic_exam: true,
};

export function engineInputFrom(s: Session): EngineInput {
  return {
    jurisdiction: s.st,
    context: {
      incident_date: s.incident_date,
      as_of_date: s.scan.as_of_date,
      police_report: s.police_report,
      forensic_exam: s.forensic_exam === true,
    },
    items: s.scan.items
      .filter((it) => s.answers[it.item_id] !== "no")
      .map((it) => ({ ...it, confirmed: it.confirmed || s.answers[it.item_id] === "yes" })),
  };
}

// An itemized bill is its own receipt, so bill lines start with one attached.
function initialLife(scan: ScanResult): Record<string, LineLife> {
  const life: Record<string, LineLife> = {};
  for (const it of scan.items) {
    if (it.source === "bill") life[it.item_id] = { receipt: `Itemized bill from ${it.merchant ?? "the provider"}` };
  }
  return life;
}

export type ClaimStatus = "idle" | "computing" | "ready" | "error";

interface SessionContext {
  ready: boolean;
  session: Session | null;
  claim: { status: ClaimStatus; evaluation: Evaluation | null; error: string | null };
  begin(params: StartParams): Promise<void>;
  answer(itemId: string, value: Answer | null): void;
  setJurisdiction(st: string): void;
  updateLife(itemIds: string[], patch: Partial<LineLife> | null): void;
  addPayment(record: PaymentRecord): void;
  setShare(share: Session["share"]): void;
  clear(): void;
}

const Ctx = createContext<SessionContext | null>(null);

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as Session) : null;
    return parsed?.v === 1 && parsed.scan ? parsed : null;
  } catch {
    return null;
  }
}

function save(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private windows can refuse storage; the session still works until the tab closes.
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [claim, setClaim] = useState<SessionContext["claim"]>({ status: "idle", evaluation: null, error: null });
  const run = useRef(0);

  useEffect(() => {
    // Storage is only readable after hydration, so the first client render matches the server's.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(load());
    setReady(true);
  }, []);

  const update = useCallback((fn: (s: Session) => Session) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      save(next);
      return next;
    });
  }, []);

  const input = useMemo(() => (session ? engineInputFrom(session) : null), [session]);
  const inputKey = useMemo(() => (input ? JSON.stringify(input) : ""), [input]);

  useEffect(() => {
    if (!input) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClaim({ status: "idle", evaluation: null, error: null });
      return;
    }
    const id = ++run.current;
    setClaim((c) => ({ ...c, status: "computing" }));
    evaluateClaim(input)
      .then((evaluation) => {
        if (id === run.current) setClaim({ status: "ready", evaluation, error: null });
      })
      .catch((err: Error) => {
        if (id === run.current) setClaim((c) => ({ status: "error", evaluation: c.evaluation, error: err.message }));
      });
    // inputKey carries the content of input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const value = useMemo<SessionContext>(
    () => ({
      ready,
      session,
      claim,
      async begin(params) {
        const result = await runScan({
          persona_id: params.persona_id,
          st: params.st,
          incident_date: params.incident_date,
        });
        const next: Session = {
          ...params,
          v: 1,
          consented_at: new Date().toISOString(),
          scan: result,
          answers: {},
          life: initialLife(result),
          payments: [],
          share: null,
        };
        save(next);
        try {
          sessionStorage.removeItem(LEFT_KEY);
        } catch {
          // nothing to clear
        }
        setSession(next);
      },
      answer(itemId, value) {
        update((s) => {
          const answers = { ...s.answers };
          if (value) answers[itemId] = value;
          else delete answers[itemId];
          return { ...s, answers };
        });
      },
      setJurisdiction(st) {
        update((s) => ({ ...s, st: st.toUpperCase(), share: null }));
      },
      updateLife(itemIds, patch) {
        update((s) => {
          const life = { ...s.life };
          for (const id of itemIds) {
            if (patch === null) delete life[id];
            else life[id] = { ...life[id], ...patch };
          }
          return { ...s, life };
        });
      },
      addPayment(record) {
        update((s) => ({ ...s, payments: [...s.payments, record] }));
      },
      setShare(share) {
        update((s) => ({ ...s, share }));
      },
      clear() {
        save(null);
        setSession(null);
      },
    }),
    [ready, session, claim, update],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession needs SessionProvider");
  return ctx;
}
