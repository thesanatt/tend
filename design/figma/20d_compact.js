// Restack the Components page lanes (run after any component script).
(async () => {
  const T = window.__tend;
  T.compactLanes();
  const page = T.page("Components");
  return page.children.filter((n) => n.type === "SECTION").map((s) => `${s.name}@${Math.round(s.x)},${Math.round(s.y)}`).join(" | ");
})()
