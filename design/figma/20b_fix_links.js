// One-off patch for the first build: text properties had reset the underline on Citation and Text link.
// (00_helpers.js now keeps decorations when wiring, so a fresh build does not need this.)
(async () => {
  const T = window.__tend;
  let n = 0;
  for (const name of ["Citation", "Text link"])
    for (const t of T.comps[name].findAll((x) => x.type === "TEXT")) {
      T.decorate(t, "UNDERLINE");
      n++;
    }
  return { underlined: n };
})()
