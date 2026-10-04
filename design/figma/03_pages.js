// Pages in order, the file name, and canvas colors.
(async () => {
  const T = window.__tend;
  const NAMES = [
    "Cover",
    "Foundations",
    "Components",
    "Survivor flow / Phone",
    "Survivor flow / Desktop",
    "Espanol",
    "Public",
    "Dark mode",
    "Accessibility",
  ];
  const pages = figma.root.children;
  if (pages.length === 1 && pages[0].name === "Page 1" && pages[0].children.length === 0) pages[0].name = "Cover";
  NAMES.forEach((name, i) => {
    let p = figma.root.children.find((x) => x.name === name);
    if (!p) {
      p = figma.createPage();
      p.name = name;
    }
    figma.root.insertChild(i, p);
    // Warm neutral canvas so paper-colored frames read as sheets; near-black for the dark page.
    p.backgrounds = [T.solid(name === "Dark mode" ? "#0E0E0D" : "#E3DDD1")];
  });
  let renamed = "ok";
  try {
    figma.root.name = "Tend: design system and survivor flow";
  } catch (e) {
    renamed = "ERR " + e.message;
  }
  return { pages: figma.root.children.map((p) => p.name), fileName: figma.root.name, renamed };
})()
