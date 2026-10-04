// Text styles named after the type tokens, the sheet shadow effect styles, and the two layout grids.
// Re-running updates styles in place by name.
(async () => {
  const T = window.__tend;
  const { serif, sans, mono } = T.F;
  const pct = (v) => ({ value: v, unit: "PERCENT" });
  const px = (v) => ({ value: v, unit: "PIXELS" });

  // name, family, style, size, line height %, letter spacing (% or {px}), description
  const TEXT = [
    ["text-2xs/mono bold", mono, "Bold", 12, 100, 0, "0.75rem literal, not a DESIGN.md token: step numbers and law garden state labels."],
    ["text-2xs/mono", mono, "Regular", 12, 120, 0, "0.85em of text-xs, not a DESIGN.md token: the Esc key cap."],
    ["text-xs/body", sans, "Regular", 14, 145, 0, "text-xs 14/1.45. Meta, captions, notes under amounts."],
    ["text-xs/body bold", sans, "Bold", 14, 120, 0, "text-xs 14/1.2 bold. Status tags, citations, Don't pay."],
    ["text-xs/mono", mono, "Regular", 14, 145, 0, "text-xs in the mono face. Ledger dates, rule ids, share links."],
    ["text-sm/body", sans, "Regular", 16, 150, 0, "text-sm 16/1.5. Secondary UI, tables, hints."],
    ["text-sm/body semibold", sans, "SemiBold", 16, 120, 0, "Button labels: 600 16/1.2."],
    ["text-sm/body bold", sans, "Bold", 16, 150, 0, "text-sm bold. Current nav item, Exit this page, group titles."],
    ["text-sm/mono", mono, "Regular", 16, 150, 0, "text-sm in the mono face. Amounts in small tables."],
    ["text-sm/mono bold", mono, "Bold", 16, 150, 0, "text-sm mono bold."],
    ["text-md/body", sans, "Regular", 18, 160, 0, "text-md 18/1.6. Body, the base size."],
    ["text-md/body bold", sans, "Bold", 18, 160, 0, "text-md bold. Field labels, fact leads, Held notes."],
    ["text-md/mono", mono, "Regular", 18, 160, 0, "text-md in the mono face. Ledger and bill amounts, so columns line up."],
    ["text-md/mono bold", mono, "Bold", 18, 160, 0, "Counted amounts in the ledger."],
    ["text-md/serif quote", serif, "Regular", 18, 155, 0, "Quoted law: Source Serif 4, 18/1.55, highlighted in green-tint."],
    ["text-md/serif quote line", serif, "Regular", 18, 120, 0, "One highlighted line of quoted law (the <mark> box). Lines sit 27.9px apart, the 1.55 line height of text-md/serif quote."],
    ["text-lg/body", sans, "Regular", 21, 150, 0, "text-lg 21/1.5. Lead paragraphs."],
    ["text-lg/body bold", sans, "Bold", 21, 150, 0, "text-lg bold. The rest of a bill."],
    ["text-lg/mono bold", mono, "Bold", 21, 150, 0, "text-lg mono bold. The rest of a bill, amount column."],
    ["text-xl/serif", serif, "SemiBold", 26, 115, -1.2, "text-xl 26/1.15. Bed, sheet, and section titles."],
    ["text-xl/mono", mono, "Regular", 26, 120, 20, "The confirmation code field: mono, 0.2em tracking."],
    ["text-2xl/phone serif", serif, "SemiBold", 28, 115, -1.2, "text-2xl at phone width (clamp minimum 28px)."],
    ["text-2xl/desktop serif", serif, "SemiBold", 34, 115, -1.2, "text-2xl at desktop width (clamp maximum 34px)."],
    ["text-2xl/phone mono bold", mono, "Bold", 28, 120, 8, "The six-digit code to type: mono bold, 0.08em tracking."],
    ["text-3xl/phone serif", serif, "SemiBold", 36, 106, -1.2, "Page titles at phone width. CSS weight 560 on the variable font; SemiBold here."],
    ["text-3xl/desktop serif", serif, "SemiBold", 52, 106, -1.2, "Page titles at desktop width (clamp maximum 52px)."],
    ["text-3xl/phone figure", serif, "Medium", 36, 105, -2, "The running claim total in the tally, phone width."],
    ["text-3xl/desktop figure", serif, "Medium", 52, 105, -2, "The running claim total in the tally, desktop width."],
    ["text-display/phone serif", serif, "Medium", 44, 100, -3, "The claim total, weight 500, phone width (clamp minimum 44px)."],
    ["text-display/desktop serif", serif, "Medium", 72, 100, -3, "The claim total, weight 500, desktop width (clamp maximum 72px)."],
    ["brand/wordmark", serif, "SemiBold", 26, 100, -2, "The Tend wordmark in the header: 1.625rem, 600, -0.02em."],
    ["card/wordmark", serif, "SemiBold", 36, 100, { px: -0.5 }, "Share card wordmark (components/public/og/card.tsx)."],
    ["card/lead", serif, "SemiBold", 40, 115, 0, "Share card lead line, in green."],
    ["card/body", serif, "SemiBold", 60, 112, { px: -0.6 }, "Share card sentence. 60px up to 100 characters, smaller for longer lines."],
    ["card/address", sans, "Bold", 32, 120, 0, "Share card address, e.g. youreowed.tech/mi."],
    ["card/source", sans, "Regular", 21, 130, 0, "Share card source line with the pinpoints."],
  ];

  const existing = await figma.getLocalTextStylesAsync();
  for (const [name, family, style, size, lh, ls, desc] of TEXT) {
    let s = existing.find((x) => x.name === name);
    if (!s) {
      s = figma.createTextStyle();
      s.name = name;
    }
    s.fontName = { family, style };
    s.fontSize = size;
    s.lineHeight = pct(lh);
    s.letterSpacing = typeof ls === "object" ? px(ls.px) : pct(ls);
    s.description = desc;
  }

  // Effect styles: the sheet shadow is the only shadow in Tend.
  const effects = await figma.getLocalEffectStylesAsync();
  const shadow = (x, y, blur, color) => ({
    type: "DROP_SHADOW",
    color,
    offset: { x, y },
    radius: blur,
    spread: 0,
    visible: true,
    blendMode: "NORMAL",
    showShadowBehindNode: false,
  });
  const bind = (eff, name) => figma.variables.setBoundVariableForEffect(eff, "color", T.v[name]);
  const EFFECTS = [
    [
      "shadow-sheet",
      [bind(shadow(0, -1, 0, { r: 0, g: 0, b: 0, a: 1 }), "line"), bind(shadow(0, -18, 40, { r: 0, g: 0, b: 0, a: 0.1 }), "shadow-sheet")],
      "Bottom sheet on phones: 0 -1px 0 line, 0 -18px 40px shadow-sheet. The only shadow in Tend.",
    ],
    [
      "shadow-sheet-side",
      [bind(shadow(-1, 0, 0, { r: 0, g: 0, b: 0, a: 1 }), "line"), shadow(-24, 0, 48, { ...T.hex("#1C1B18"), a: 0.12 })],
      "Side panel from 900px: -1px 0 0 line, -24px 0 48px ink at 12% (Sheet.module.css).",
    ],
  ];
  for (const [name, list, desc] of EFFECTS) {
    let s = effects.find((x) => x.name === name);
    if (!s) {
      s = figma.createEffectStyle();
      s.name = name;
    }
    s.effects = list;
    s.description = desc;
  }

  // Layout grids.
  const grids = await figma.getLocalGridStylesAsync();
  const tint = { r: 0.12, g: 0.32, b: 0.21, a: 0.07 };
  const clayTint = { r: 0.61, g: 0.31, b: 0.2, a: 0.07 };
  const GRIDS = [
    [
      "grid/phone 390",
      [{ pattern: "COLUMNS", alignment: "STRETCH", count: 4, gutterSize: 16, offset: 16, visible: true, color: tint }],
      "Phone, 390 wide: 4 columns, 16px side gutter (clamp(16px, 4vw, 40px) at 390).",
    ],
    [
      "grid/desktop 1440",
      [
        { pattern: "COLUMNS", alignment: "CENTER", count: 12, sectionSize: 60, gutterSize: 32, visible: true, color: tint },
        { pattern: "COLUMNS", alignment: "MIN", count: 1, sectionSize: 640, gutterSize: 0, offset: 184, visible: true, color: clayTint },
      ],
      "Desktop, 1440 wide: the 72rem page (1152 with 40px gutters, 1072 of content) as 12 columns, plus the 40rem reading measure from the page edge.",
    ],
  ];
  for (const [name, layoutGrids, desc] of GRIDS) {
    let s = grids.find((x) => x.name === name);
    if (!s) {
      s = figma.createGridStyle();
      s.name = name;
    }
    s.layoutGrids = layoutGrids;
    s.description = desc;
  }

  await T.refresh();
  return { text: Object.keys(T.ts).length, effects: Object.keys(T.es), grids: Object.keys(T.gs) };
})()
