import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { loadIr, loadLaw, siteUrl, stateFromParam } from "@/components/public/data";
import { Card, CARD_SIZE, cardFonts } from "@/components/public/og/card";
import { buildStateSummary } from "@/components/public/summary";
import type { Rule } from "@/lib/types";

export const contentType = "image/png";
export const size = CARD_SIZE;

function summaryFor(param: string | undefined) {
  const ref = param ? stateFromParam(param) : null;
  const loaded = ref ? loadLaw(ref.st) : null;
  if (!ref || !loaded) return null;
  return { ref, law: loaded.law, summary: buildStateSummary(loaded.law, loadIr(ref.st)) };
}

// One card per state, with the card's own sentence as its alt text. Next also calls this while it
// lists static params, sometimes before the state is known.
export function generateImageMetadata({ params }: { params?: { st?: string } }) {
  const found = summaryFor(params?.st);
  return [{ id: "card", size: CARD_SIZE, contentType, alt: found ? found.summary.share.text : "A Tend share card" }];
}

export default async function Image({ params }: { params: Promise<{ st: string }> }) {
  const { st } = await params;
  const found = summaryFor(st);
  if (!found) notFound();
  const { ref, law, summary } = found;
  const rules = new Map<string, Rule>(law.rules.map((r) => [r.id, r]));
  const pinpoints = [
    ...new Set(summary.share.clauses.map((c) => rules.get(c.cites[0])?.pinpoint).filter((p): p is string => !!p)),
  ];
  const site = siteUrl();
  return new ImageResponse(
    <Card
      summary={summary}
      rules={law.rules.length}
      address={`${site.host}/${ref.st.toLowerCase()}`}
      pinpoints={pinpoints}
    />,
    { ...CARD_SIZE, fonts: await cardFonts() },
  );
}
