// Variables: "Tend color" (every color token from web/app/globals.css and web/DESIGN.md) and
// "Tend space" (spacing, radii, touch sizes, layout). Re-running updates values in place.
(async () => {
  const T = window.__tend;
  const V = figma.variables;

  // name, light, dark, description, scopes
  const SURFACE = ["FRAME_FILL", "SHAPE_FILL"];
  const INK = ["TEXT_FILL", "SHAPE_FILL", "STROKE_COLOR", "FRAME_FILL"];
  const LINE = ["STROKE_COLOR", "SHAPE_FILL"];
  const ACCENT = ["ALL_FILLS", "STROKE_COLOR"];
  const COLORS = [
    ["paper", "#F6F2E9", "#141412", "Page background", SURFACE],
    ["paper-raised", "#FBF8F2", "#1C1C19", "Sheets, the bill, summary panels", SURFACE],
    ["paper-sunk", "#ECE6DA", "#22221E", "Footer, code listings, scripts to read aloud", SURFACE],
    ["ink", "#1C1B18", "#ECE7DC", "Body text, ledger rules, Exit this page button. 15.4:1 on paper (dark 15.0)", INK],
    ["ink-2", "#4A463E", "#BEB8AB", "Secondary text. 8.4:1 on paper (dark 9.3)", INK],
    ["ink-3", "#6A655B", "#989284", "Meta text, not-counted amounts. 5.2:1 on paper (dark 6.0)", INK],
    ["line", "#D8D1C3", "#36352F", "Hairlines", LINE],
    ["line-strong", "#857E70", "#77726A", "Form field borders (3:1 against paper)", LINE],
    ["green", "#1F5136", "#8CC4A0", "Primary action, links, eligible, every plant. 8.2:1 on paper (dark 9.2)", ACCENT],
    ["green-strong", "#163D28", "#A9D6B8", "Primary hover", ACCENT],
    ["green-tint", "#E2EADF", "#1D2C22", "Quote highlight, selected answer, leaf fill", SURFACE],
    ["clay", "#9B4E33", "#DA9677", "Held bills only. 5.3:1 on paper (dark 7.6)", ACCENT],
    ["clay-tint", "#F2E2D8", "#36241C", "Held bill row background", SURFACE],
    ["on-green", "#F6F2E9", "#10140F", "Text and icons on a green fill (primary buttons, current step)", INK],
    ["leaf-fill", "#E2EADF", "#1D2C22", "Plant leaves", SURFACE],
    ["petal-fill", "#FBF8F2", "#1C1C19", "Plant petals", SURFACE],
    ["scrim", ["#1C1B18", 0.38], ["#000000", 0.55], "Behind an open sheet", SURFACE],
    ["shadow-sheet", ["#1C1B18", 0.1], ["#000000", 0.4], "Color of the sheet shadow, the only shadow in Tend", ["EFFECT_COLOR"]],
  ];
  T.DARK = Object.fromEntries(COLORS.map(([n, , d]) => [n, d]));

  const rgba = (x) => {
    const [hex, a] = Array.isArray(x) ? x : [x, 1];
    return { ...T.hex(hex), a };
  };

  const getColl = async (name, modeName) => {
    let c = (await V.getLocalVariableCollectionsAsync()).find((x) => x.name === name);
    if (!c) c = V.createVariableCollection(name);
    c.renameMode(c.modes[0].modeId, modeName);
    return c;
  };
  const existing = await V.getLocalVariablesAsync();
  const getVar = (name, coll, type) => {
    let v = existing.find((x) => x.name === name && x.variableCollectionId === coll.id);
    if (!v) v = V.createVariable(name, coll, type);
    return v;
  };

  const color = await getColl("Tend color", "Light");
  const lightId = color.modes[0].modeId;
  const darkMode = color.modes.find((m) => m.name === "Dark");
  for (const [name, light, dark, desc, scopes] of COLORS) {
    const v = getVar(name, color, "COLOR");
    v.setValueForMode(lightId, rgba(light));
    if (darkMode) v.setValueForMode(darkMode.modeId, rgba(dark));
    v.description = desc;
    v.scopes = scopes;
    v.setVariableCodeSyntax("WEB", `var(--${name})`);
  }

  // Tend space: name, value, description, scopes, css var (or null)
  const GAP = ["GAP"];
  const SPACE = [
    ["space-1", 4, "4px step", GAP, "space-1"],
    ["space-2", 8, "8px step", GAP, "space-2"],
    ["space-3", 12, "12px step", GAP, "space-3"],
    ["space-4", 16, "16px step; the phone gutter", GAP, "space-4"],
    ["space-5", 24, "24px step; button side padding", GAP, "space-5"],
    ["space-6", 32, "32px step", GAP, "space-6"],
    ["space-7", 48, "48px step", GAP, "space-7"],
    ["space-8", 64, "64px step", GAP, "space-8"],
    ["space-9", 96, "96px step; space above the footer", GAP, "space-9"],
    ["radius-1", 4, "Fields and tags", ["CORNER_RADIUS"], "radius-1"],
    ["radius-btn", 6, "Buttons, choices, Exit this page (6px literal in globals.css)", ["CORNER_RADIUS"], null],
    ["radius-2", 8, "Panels", ["CORNER_RADIUS"], "radius-2"],
    ["radius-sheet", 12, "Top corners of the bottom sheet (Sheet.module.css)", ["CORNER_RADIUS"], null],
    ["touch-target", 44, "Smallest touch target: links, citations, answer buttons", ["WIDTH_HEIGHT"], null],
    ["tap", 48, "Button and field height", ["WIDTH_HEIGHT"], "tap"],
    ["measure", 640, "Reading measure, 40rem", ["WIDTH_HEIGHT"], "measure"],
    ["page", 1152, "Page width, 72rem", ["WIDTH_HEIGHT"], "page"],
    ["gutter-phone", 16, "Side gutter on phones (clamp(16px, 4vw, 40px))", ["GAP", "WIDTH_HEIGHT"], "gutter"],
    ["gutter-desktop", 40, "Side gutter on wide screens", ["GAP", "WIDTH_HEIGHT"], "gutter"],
  ];
  const space = await getColl("Tend space", "Value");
  const valId = space.modes[0].modeId;
  for (const [name, value, desc, scopes, css] of SPACE) {
    const v = getVar(name, space, "FLOAT");
    v.setValueForMode(valId, value);
    v.description = desc;
    v.scopes = scopes;
    if (css) v.setVariableCodeSyntax("WEB", `var(--${css})`);
  }

  await T.refresh();
  return {
    color: (await V.getLocalVariablesAsync()).filter((v) => v.variableCollectionId === color.id).length,
    space: (await V.getLocalVariablesAsync()).filter((v) => v.variableCollectionId === space.id).length,
    colorModes: color.modes.map((m) => m.name),
  };
})()
