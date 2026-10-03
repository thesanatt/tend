import { ImageResponse } from "next/og";
import { loadIr, loadLaw, siteUrl, stateFromParam } from "@/components/public/data";
import { Card, CARD_SIZE, cardFonts } from "@/components/public/og/card";
import { buildStateSummary } from "@/components/public/summary";
import STATES from "@/lib/states.json";
import type { Rule } from "@/lib/types";

// The share card for each state, drawn by next/og and written as a static PNG at build time:
// /mi/card.png. The page's Open Graph tags point here, with the card's sentence as alt text.
export const dynamicParams = false;

export function generateStaticParams() {
  return STATES.map((s) => ({ st: s.st.toLowerCase() }));
}

function cardFor(param: string) {
  const ref = stateFromParam(param);
  if (!ref || param !== ref.st.toLowerCase()) return null;
  const loaded = loadLaw(ref.st);
  if (!loaded) return null;
  const summary = buildStateSummary(loaded.law, loadIr(ref.st));
  const rules = new Map<string, Rule>(loaded.law.rules.map((r) => [r.id, r]));
  const pinpoints = [
    ...new Set(summary.share.clauses.map((c) => rules.get(c.cites[0])?.pinpoint).filter((p): p is string => !!p)),
  ];
  return { ref, summary, rules: loaded.law.rules.length, pinpoints };
}

export async function GET(_request: Request, { params }: { params: Promise<{ st: string }> }) {
  const { st } = await params;
  const card = cardFor(st);
  if (!card) return new Response("Not found", { status: 404 });
  return new ImageResponse(
    <Card
      summary={card.summary}
      rules={card.rules}
      address={`${siteUrl().host}/${card.ref.st.toLowerCase()}`}
      pinpoints={card.pinpoints}
    />,
    { ...CARD_SIZE, fonts: await cardFonts() },
  );
}
