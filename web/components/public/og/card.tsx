// The 1200 x 630 share card, drawn by next/og (Satori: flexbox and inline styles only).
// Text comes from buildStateSummary, so the card says only what the verified rules say.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lawGrowth, lawStage, leafPath, plantShape } from "@/lib/garden";
import type { StateSummary } from "../summary";

export const CARD_SIZE = { width: 1200, height: 630 };

// Light theme tokens from app/globals.css; a card is an image, so it has one look.
const C = {
  paper: "#F6F2E9",
  ink: "#1C1B18",
  ink2: "#4A463E",
  line: "#D8D1C3",
  lineStrong: "#857E70",
  green: "#1F5136",
  leaf: "#E2EADF",
  petal: "#FBF8F2",
};

// Latin subsets of OFL fonts (components/public/og/fonts, licenses and a README alongside). Satori needs TTF.
export async function cardFonts() {
  const dir = path.join(process.cwd(), "components", "public", "og", "fonts");
  const [serif, sans, sansBold] = await Promise.all([
    readFile(path.join(dir, "SourceSerif4-Semibold.ttf")),
    readFile(path.join(dir, "AtkinsonHyperlegibleNext-Regular.ttf")),
    readFile(path.join(dir, "AtkinsonHyperlegibleNext-Bold.ttf")),
  ]);
  return [
    { name: "Source Serif", data: serif, weight: 600 as const, style: "normal" as const },
    { name: "Atkinson", data: sans, weight: 400 as const, style: "normal" as const },
    { name: "Atkinson", data: sansBold, weight: 700 as const, style: "normal" as const },
  ];
}

// Longer lines get a smaller size so every card fits the same frame.
export function bodySize(text: string): number {
  const n = text.length;
  if (n <= 100) return 60;
  if (n <= 130) return 54;
  if (n <= 165) return 48;
  return 42;
}

function CardPlant({ st, rules }: { st: string; rules: number }) {
  const stage = lawStage(rules);
  const shape = plantShape(stage === "seed" ? "sprout" : stage, lawGrowth(rules), st);
  const { top } = shape;
  return (
    <svg width="372" height="372" viewBox="-6 0 52 52.5" style={{ position: "absolute", right: 44, bottom: 40 }}>
      <path d="M-6 52.5H46" stroke={C.lineStrong} strokeWidth="0.35" fill="none" />
      {shape.stem ? <path d={shape.stem} stroke={C.green} strokeWidth="0.9" strokeLinecap="round" fill="none" /> : null}
      {shape.leaves.map((leaf, i) => (
        <g key={i} transform={`translate(${leaf.x} ${leaf.y}) scale(${leaf.side} 1) rotate(${leaf.angle})`}>
          <path d={leafPath(leaf.length)} fill={C.leaf} stroke={C.green} strokeWidth="0.6" strokeLinejoin="round" />
          <path
            d={`M0.6 0Q${leaf.length * 0.5} ${-leaf.length * 0.06} ${leaf.length * 0.88} 0`}
            stroke={C.green}
            strokeWidth="0.35"
            fill="none"
          />
        </g>
      ))}
      {shape.cotyledons ? (
        <>
          <path
            d={`M${top.x} ${top.y}c-3-0.5-7.2-2.8-7.6-6.6c3.8-0.6 7.2 2 7.6 6.6z`}
            fill={C.leaf}
            stroke={C.green}
            strokeWidth="0.6"
          />
          <path
            d={`M${top.x} ${top.y}c3-0.5 7.2-2.8 7.6-6.6c-3.8-0.6-7.2 2-7.6 6.6z`}
            fill={C.leaf}
            stroke={C.green}
            strokeWidth="0.6"
          />
        </>
      ) : null}
      {shape.bud ? (
        <path d={`M${top.x} ${top.y + 1}c-4-1.8-4.4-8.6 0-12.6c4.4 4 4 10.8 0 12.6z`} fill={C.green} stroke="none" />
      ) : null}
      {shape.petals ? (
        <g transform={`translate(${top.x} ${top.y - 5.4})`}>
          {Array.from({ length: shape.petals }, (_, i) => (
            <ellipse
              key={i}
              cx="0"
              cy="-5.3"
              rx="3.2"
              ry="4.8"
              transform={`rotate(${(360 / shape.petals) * i + 12})`}
              fill={C.petal}
              stroke={C.green}
              strokeWidth="0.6"
            />
          ))}
          <circle r="2.7" fill={C.green} />
        </g>
      ) : null}
    </svg>
  );
}

function Mark() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24">
      <path d="M12 21V11" stroke={C.green} strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M12 12.5C11.2 8.6 7.6 6.3 4 6.6C4.4 10.6 8 13 12 12.5Z" fill={C.green} />
      <path d="M12 10C12.6 6.4 15.8 3.8 19.6 4C19.4 7.8 16 10.4 12 10Z" fill={C.green} opacity="0.72" />
      <path d="M7 21H17" stroke={C.green} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export interface CardProps {
  summary: StateSummary;
  rules: number;
  // "youreowed.tech/mi"
  address: string;
  // Pinpoints behind the two clauses, when they are short enough to print.
  pinpoints: string[];
}

// The card's sentence is Tend's plain wording of the cited rules, not a quote, so the small print
// names the pinpoints when they fit and otherwise points to the page that cites them.
export function cardSourceLine(name: string, pinpoints: string[]): string {
  const cites = pinpoints.join(" and ");
  return cites && cites.length <= 64
    ? `From ${name} law: ${cites}. The program decides.`
    : `From ${name} law, with citations on the page. The program decides.`;
}

export function Card({ summary, rules, address, pinpoints }: CardProps) {
  const lead = `If you're Jane Doe in ${summary.place}:`;
  const body = `${summary.share.clauses.map((c) => c.text).join(", and ")}.`;
  const sourceLine = cardSourceLine(summary.name, pinpoints);

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
      <CardPlant st={summary.st} rules={rules} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: 830,
          height: "100%",
          padding: "56px 0 52px 76px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <Mark />
          <div style={{ marginLeft: 12, fontFamily: "Source Serif", fontSize: 36, letterSpacing: -0.5 }}>Tend</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: "Source Serif", fontSize: 40, color: C.green, lineHeight: 1.15 }}>{lead}</div>
          <div
            style={{
              marginTop: 14,
              fontFamily: "Source Serif",
              fontSize: bodySize(body),
              lineHeight: 1.12,
              letterSpacing: -0.6,
            }}
          >
            {body}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: C.ink }}>{address}</div>
          <div style={{ marginTop: 6, fontSize: 21, color: C.ink2 }}>{sourceLine}</div>
        </div>
      </div>
    </div>
  );
}
