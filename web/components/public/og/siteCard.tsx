// Link preview cards for Tend's own pages (/, /how-it-works, /sources, /tour, /data, /law/changes), in the state cards'
// look (card.tsx): paper and ink, the mark, and a row of plants from sprout to bloom on one ground
// line. Satori: flexbox and inline styles only.
import type { Metadata } from "next";
import { plantShape, VIEW, type Stage } from "@/lib/garden";
import { siteUrl } from "../site";
import { C, CARD_SIZE, Mark, plantArt } from "./card";

export interface SiteCardText {
  // The page the card stands for; its image is a static PNG at <path>/card.png.
  path: string;
  // The green line over the sentence. The home card has none: the wordmark heads it.
  heading?: string;
  sentence: string;
}

export const SITE_CARDS = {
  home: {
    path: "/",
    sentence:
      "Tend helps sexual assault survivors apply for crime victim compensation from their state, without giving Tend their name.",
  },
  how: {
    path: "/how-it-works",
    heading: "How Tend works",
    sentence: "Each state's verified law runs on your device, and every dollar points to the sentence behind it.",
  },
  sources: {
    path: "/sources",
    heading: "Sources",
    sentence: "Where each number about the problem comes from, and how to rerun Tend's own.",
  },
  tour: {
    path: "/tour",
    heading: "What you just saw",
    sentence: "A 2-minute tour of Tend with Rowan, a fictional survivor in Michigan.",
  },
  data: {
    path: "/data",
    heading: "Rules data",
    sentence: "All of Tend's verified rules, as JSON and CSV. Each rule quotes its source word for word.",
  },
  changes: {
    path: "/law/changes",
    heading: "Law changes",
    sentence: "What changed in the rules Tend uses, version by version, with the exact quotes.",
  },
} satisfies Record<string, SiteCardText>;

export type SitePage = keyof typeof SITE_CARDS;

const text = (page: SitePage): SiteCardText => SITE_CARDS[page];

export function siteCardPath(page: SitePage): string {
  const { path } = text(page);
  return path === "/" ? "/card.png" : `${path}/card.png`;
}

// "youreowed.tech", "youreowed.tech/sources"
export function siteCardAddress(page: SitePage): string {
  const { path } = text(page);
  return `${siteUrl().host}${path === "/" ? "" : path}`;
}

// What the image shows, for people who cannot see it.
export function siteCardAlt(page: SitePage): string {
  const { heading, sentence } = text(page);
  return `${heading ? `${heading}: ` : ""}${sentence} ${siteCardAddress(page)}, with a row of plant drawings from sprout to bloom.`;
}

// Open Graph and Twitter tags for one of these pages; the URLs resolve against metadataBase
// (app/layout.tsx). The root layout and the survivor flow set none, so a link copied from the flow
// gets no card. Its title is "Tend" and its description neutral (components/flow/meta.ts).
export function sitePreview(page: SitePage): Pick<Metadata, "openGraph" | "twitter"> {
  const { path, heading, sentence } = text(page);
  const title = heading ?? "Tend";
  const image = { url: siteCardPath(page), ...CARD_SIZE, type: "image/png", alt: siteCardAlt(page) };
  return {
    openGraph: { type: "website", siteName: "Tend", title, description: sentence, url: path, images: [image] },
    twitter: { card: "summary_large_image", title, description: sentence, images: [image] },
  };
}

// The four stages of a plant in the survivor's garden (lib/garden.ts), each seeded so the row grows
// the same way on every card.
const ROW: { stage: Stage; growth: number; key: string }[] = [
  { stage: "sprout", growth: 0.6, key: "sprout" },
  { stage: "leaf", growth: 0.6, key: "leaf" },
  { stage: "bud", growth: 0.6, key: "bud" },
  { stage: "bloom", growth: 0.8, key: "bloom" },
];
// Garden units between stems, pixels per unit, and how much heavier the lines are than on the state
// card, which draws its one plant at about 7 pixels per unit.
const STEP = 30;
const UNIT = 4.2;
const WEIGHT = 1.45;
// Bare ground on either side of the row, in garden units.
const OVERHANG = 16;
// The ground line's height above the bottom edge. The address stands on it too.
const GROUND = 40;
const GROUND_LINE = 0.35;

function Garden() {
  const x0 = VIEW.cx - OVERHANG;
  const width = STEP * (ROW.length - 1) + 2 * OVERHANG;
  const { ground } = VIEW;
  return (
    <svg
      width={width * UNIT}
      height={ground * UNIT}
      viewBox={`${x0} 0 ${width} ${ground}`}
      style={{ position: "absolute", right: 44, bottom: GROUND }}
    >
      {/* Stems start at the ground and the box ends there, so the line sits just inside it. */}
      <path
        d={`M${x0} ${ground - GROUND_LINE / 2}H${x0 + width}`}
        stroke={C.lineStrong}
        strokeWidth={GROUND_LINE}
        fill="none"
      />
      {ROW.map((p, i) => (
        <g key={p.stage} transform={`translate(${i * STEP} 0)`}>
          {plantArt(plantShape(p.stage, p.growth, p.key), WEIGHT)}
        </g>
      ))}
    </svg>
  );
}

// A sentence over 110 characters steps down a size so it still fits in three lines.
export function sentenceSize(sentence: string): number {
  return sentence.length <= 110 ? 54 : 50;
}

export function SiteCard({ page }: { page: SitePage }) {
  const { heading, sentence } = text(page);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: C.paper,
        color: C.ink,
        fontFamily: "Atkinson",
      }}
    >
      <Garden />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: "56px 76px 0 76px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <Mark />
          <div style={{ marginLeft: 12, fontFamily: "Source Serif", fontSize: 36, letterSpacing: -0.5 }}>Tend</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 48 }}>
          {heading ? (
            <div style={{ fontFamily: "Source Serif", fontSize: 40, color: C.green, lineHeight: 1.15 }}>{heading}</div>
          ) : null}
          {/* Lines stop short of the flower at the end of the row. */}
          <div
            style={{
              maxWidth: 960,
              marginTop: heading ? 14 : 0,
              fontFamily: "Source Serif",
              fontSize: sentenceSize(sentence),
              lineHeight: 1.12,
              letterSpacing: -0.6,
              textWrap: "balance",
            }}
          >
            {sentence}
          </div>
        </div>
      </div>
      {/* Atkinson's baseline sits 0.316 em above the bottom of its line box (its descender), so
          this stands the address on the same ground line as the plants. */}
      <div
        style={{
          position: "absolute",
          left: 76,
          bottom: GROUND - 0.316 * 32,
          fontSize: 32,
          fontWeight: 700,
        }}
      >
        {siteCardAddress(page)}
      </div>
    </div>
  );
}
