// One-off: move the sections built before the lane spacing was widened (forms 2400 -> 2300, ledger 4800 -> 5800).
(async () => {
  const T = window.__tend;
  const page = T.page("Components");
  const moves = { 2400: 2300, 4800: 5800 };
  let moved = 0;
  for (const s of page.children.filter((n) => n.type === "SECTION")) {
    const to = moves[Math.round(s.x)];
    if (to != null) {
      s.x = to;
      moved++;
    }
  }
  return { moved, lanes: page.children.filter((n) => n.type === "SECTION").map((s) => `${s.name}@${Math.round(s.x)},${Math.round(s.y)} w${Math.round(s.width)}`) };
})()
