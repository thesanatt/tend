const r1 = (n) => Math.round(n * 10) / 10;
const seeded = (key) => { let h = 2166136261; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => { h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const info = (stage, g, key) => { const rand = seeded(key); const lean = (rand() - 0.5) * 5;
  const count = { seed: 0, sprout: 0, leaf: 2 + Math.round(2 * g), bud: 4 + Math.round(g), bloom: 4 + Math.round(2 * g) }[stage];
  const angles = []; for (let i = 0; i < count; i++) { angles.push(r1(-32 - (rand() - 0.5) * 14)); rand(); }
  const petals = stage === "bloom" ? (rand() < 0.5 ? 5 : 6) : 0; return { lean: r1(lean), petals, angles }; };
for (const stage of ["sprout", "leaf", "bud", "bloom"]) for (const [gname, g] of [["low", 0.15], ["mid", 0.55], ["high", 0.95]]) {
  const cands = [`stage-${stage}`, `${stage}-${gname}`, `tend-${stage}-${gname}`, `${stage}-${gname}-2`, `${stage}-${gname}-3`, `${stage}-${gname}-4`];
  console.log(stage, gname, cands.map((k) => `${k}:${JSON.stringify(info(stage, g, k))}`).join("  "));
}
console.log("MI card", JSON.stringify(info("bloom", 1, "MI")));
