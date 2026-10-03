// Plant stages for both gardens, and the geometry that draws them.
// National garden: growth follows how many of a state's rules are verified.
// Survivor's garden: a plant grows only for money that comes back.

export type Stage = "seed" | "sprout" | "leaf" | "bud" | "bloom";

export const LAW_STAGES: { stage: Stage; label: string; range: string; min: number }[] = [
  { stage: "seed", label: "Not read yet", range: "No verified rules", min: 0 },
  { stage: "sprout", label: "Sprouting", range: "1 to 14 rules", min: 1 },
  { stage: "leaf", label: "Leafing", range: "15 to 24 rules", min: 15 },
  { stage: "bud", label: "Budding", range: "25 to 34 rules", min: 25 },
  { stage: "bloom", label: "In bloom", range: "35 or more rules", min: 35 },
];

export function lawStage(rules: number): Stage {
  let stage: Stage = "seed";
  for (const s of LAW_STAGES) if (rules >= s.min) stage = s.stage;
  return stage;
}

// 0..1 progress inside the stage band, so two budding states still differ in height.
export function lawGrowth(rules: number): number {
  const i = LAW_STAGES.findIndex((s) => s.stage === lawStage(rules));
  const lo = LAW_STAGES[i].min;
  const hi = LAW_STAGES[i + 1]?.min ?? 55;
  return Math.max(0, Math.min(1, (rules - lo) / Math.max(1, hi - lo)));
}

export interface LineLife {
  receipt?: string;
  filed_at?: string;
  paid_at?: string;
}

export const MONEY_STAGES: { stage: Stage; label: string; when: string }[] = [
  { stage: "sprout", label: "Sprout", when: "You confirmed the cost" },
  { stage: "leaf", label: "Leaf", when: "A receipt is attached" },
  { stage: "bud", label: "Bud", when: "The claim is filed" },
  { stage: "bloom", label: "Bloom", when: "The program paid you" },
];

export function moneyStage(confirmed: boolean, life: LineLife | undefined): Stage | null {
  if (life?.paid_at) return "bloom";
  if (life?.filed_at) return "bud";
  if (life?.receipt) return "leaf";
  return confirmed ? "sprout" : null;
}

// Bigger costs grow taller plants, on a log scale so a $1,180 bill does not dwarf a $23 ride.
export function moneyGrowth(cents: number): number {
  const dollars = Math.max(1, cents / 100);
  return Math.max(0, Math.min(1, Math.log10(dollars) / 3.5));
}

// Small seeded PRNG so each plant leans and branches the same way on every render.
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const VIEW = { w: 40, h: 56, ground: 53, cx: 20 };

export interface Leaf {
  x: number;
  y: number;
  angle: number;
  length: number;
  side: 1 | -1;
}

export interface PlantShape {
  stem: string | null;
  top: { x: number; y: number };
  leaves: Leaf[];
  cotyledons: boolean;
  bud: boolean;
  petals: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function plantShape(stage: Stage, growth: number, key: string): PlantShape {
  const rand = seeded(key);
  const g = Math.max(0, Math.min(1, growth));
  const lean = (rand() - 0.5) * 5;
  const height = { seed: 0, sprout: 11 + 5 * g, leaf: 21 + 8 * g, bud: 27 + 6 * g, bloom: 30 + 6 * g }[stage];
  const x0 = VIEW.cx;
  const y0 = VIEW.ground;
  const x2 = x0 + lean;
  const y2 = y0 - height;
  const cx = x0 + lean * 0.15;
  const cy = y0 - height * 0.55;
  const at = (t: number) => ({
    x: (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x2,
    y: (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y2,
  });

  const count = {
    seed: 0,
    sprout: 0,
    leaf: 2 + Math.round(2 * g),
    bud: 4 + Math.round(g),
    bloom: 4 + Math.round(2 * g),
  }[stage];
  const leaves: Leaf[] = [];
  for (let i = 0; i < count; i++) {
    const t = 0.16 + (i * 0.6) / Math.max(1, count - 1);
    const p = at(t);
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    leaves.push({
      x: r1(p.x),
      y: r1(p.y),
      side,
      angle: r1(-32 - (rand() - 0.5) * 14),
      length: r1(Math.max(6.5, 12.5 - i * 1.1 + (rand() - 0.5) * 1.6)),
    });
  }

  return {
    stem: stage === "seed" ? null : `M${x0} ${y0} Q${r1(cx)} ${r1(cy)} ${r1(x2)} ${r1(y2)}`,
    top: { x: r1(x2), y: r1(y2) },
    leaves,
    cotyledons: stage === "sprout" || stage === "leaf",
    bud: stage === "bud",
    petals: stage === "bloom" ? (rand() < 0.5 ? 5 : 6) : 0,
  };
}

export function leafPath(length: number): string {
  const L = length;
  const W = L * 0.42;
  return `M0 0 C${r1(L * 0.25)} ${r1(-W)} ${r1(L * 0.7)} ${r1(-W)} ${r1(L)} 0 C${r1(L * 0.7)} ${r1(W * 0.75)} ${r1(L * 0.25)} ${r1(W * 0.75)} 0 0Z`;
}
