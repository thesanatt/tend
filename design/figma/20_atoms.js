// Components, part 1: mark, wordmark, icons, key cap, status shapes and tags, buttons, links,
// Exit this page, citation, answer buttons, checkbox, radio, choice card.
(async () => {
  const T = window.__tend;
  await T.goto("Components");
  const made = [];

  // ---------- Tend mark ----------
  const MARK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
<path id="Stem" d="M12 21V11" stroke="#010101" stroke-width="1.8" stroke-linecap="round" fill="none"/>
<path id="Leaf left" d="M12 12.5C11.2 8.6 7.6 6.3 4 6.6C4.4 10.6 8 13 12 12.5Z" fill="#010101"/>
<path id="Leaf right" d="M12 10C12.6 6.4 15.8 3.8 19.6 4C19.4 7.8 16 10.4 12 10Z" fill="#010101" fill-opacity="0.72"/>
<path id="Ground" d="M7 21H17" stroke="#010101" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const moveIn = (svgRoot, c) => {
    for (const ch of [...svgRoot.children]) c.appendChild(ch);
    svgRoot.remove();
  };
  await T.makeComp({
    name: "Tend mark",
    lane: "atoms",
    desc: "The sprout mark from SiteHeader.tsx, 24 x 24 in green. Shown at 26px beside the wordmark and at 40px on the share card.",
    make: (c) => {
      c.resize(24, 24);
      moveIn(T.svg(MARK, { "#010101": "green" }), c);
    },
  });
  made.push("Tend mark");

  await T.makeComp({
    name: "Tend wordmark",
    lane: "atoms",
    base: { layout: "H", gap: "space-2", cross: "CENTER" },
    desc: "Mark plus the name in Source Serif 4 SemiBold 26, tracking -0.02em. Links home. 44px tall so it is a full touch target.",
    make: (c) => {
      T.num(c, "minHeight", "touch-target");
      const m = T.inst("Tend mark");
      m.name = "Mark";
      T.add(c, m);
      m.rescale(26 / 24);
      T.add(c, T.text("Tend", "brand/wordmark", "ink", { name: "Name" }));
    },
  });
  made.push("Tend wordmark");

  // ---------- Icons ----------
  const ICONS = {
    Shield: [
      `<path id="Shield" d="M8 1.5L13.5 3.6V7.6C13.5 10.9 11.3 13.5 8 14.5C4.7 13.5 2.5 10.9 2.5 7.6V3.6Z" fill="none" stroke="#010101" stroke-width="1.4" stroke-linejoin="round"/><path id="Check" d="M5.6 8.1L7.3 9.8L10.6 6.3" fill="none" stroke="#010101" stroke-width="1.4" stroke-linecap="round"/>`,
      "green",
    ],
    Info: [
      `<circle id="Ring" cx="8" cy="8" r="6.6" fill="none" stroke="#010101" stroke-width="1.4"/><path id="Stroke" d="M8 7.2V11.4" stroke="#010101" stroke-width="1.6" stroke-linecap="round"/><circle id="Dot" cx="8" cy="4.9" r="0.95" fill="#010101"/>`,
      "green",
    ],
    "Chevron down": [
      `<path id="Chevron" d="M4 6L8 10L12 6" fill="none" stroke="#010101" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      "ink",
    ],
    Calendar: [
      `<rect id="Page" x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="#010101" stroke-width="1.4"/><path id="Header" d="M2.5 6.5H13.5" stroke="#010101" stroke-width="1.4"/><path id="Rings" d="M5.5 2V4.5M10.5 2V4.5" stroke="#010101" stroke-width="1.4" stroke-linecap="round"/>`,
      "ink",
    ],
    Check: [
      `<path id="Check" d="M3.5 8.5L6.5 11.5L12.5 4.5" fill="none" stroke="#010101" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      "green",
    ],
    Disclosure: [`<path id="Triangle" d="M5.5 3.5L11.5 8L5.5 12.5Z" fill="#010101"/>`, "green"],
  };
  await T.makeSet({
    name: "Icon",
    lane: "atoms",
    cols: "Name",
    desc: "The few line icons Tend draws: the privacy shield, the info circle, a select chevron, the date field calendar, the checkbox check, and the disclosure triangle on state pages. 16 x 16, 1.4px strokes, colored by variable. No emoji, no icon font.",
    variants: Object.entries(ICONS).map(([name, [body, color]]) => ({
      props: { Name: name },
      make: (c) => {
        c.resize(16, 16);
        moveIn(T.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>`, { "#010101": color }), c);
      },
    })),
  });
  made.push("Icon");

  // ---------- Key cap ----------
  await T.makeComp({
    name: "Key cap",
    lane: "atoms",
    base: { layout: "H", pad: [0, 5], cross: "CENTER", radius: "radius-1" },
    desc: "The <kbd> style from globals.css: mono at 0.85em, a line-strong border that is 2px at the bottom, 4px radius. Used for Esc in the Exit this page hint.",
    make: (c) => {
      T.stroke(c, "line-strong", 1, "INSIDE", { t: 1, r: 1, b: 2, l: 1 });
      T.add(c, T.text("Esc", "text-2xs/mono", "ink-3", { name: "Key" }));
    },
    props: { text: [{ name: "Key", default: "Esc" }] },
  });
  made.push("Key cap");

  // ---------- Status shape + Status tag ----------
  const SHAPES = {
    Eligible: [`<circle cx="6" cy="6" r="4.5" fill="#010101"/>`, "green", "Counts"],
    Held: [`<rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="#010101"/>`, "clay", "Held"],
    Excluded: [
      `<circle cx="6" cy="6" r="4.3" fill="none" stroke="#010101" stroke-width="1.4"/><path d="M3 9L9 3" stroke="#010101" stroke-width="1.4"/>`,
      "ink-2",
      "Not covered",
    ],
    "Needs confirmation": [
      `<circle cx="6" cy="6" r="4.3" fill="none" stroke="#010101" stroke-width="1.4" stroke-dasharray="2.2 1.6"/>`,
      "ink",
      "Needs your answer",
    ],
    "Not included": [`<circle cx="6" cy="6" r="4.3" fill="none" stroke="#010101" stroke-width="1.4"/>`, "ink-3", "Not included"],
  };
  const shapeNames = { Eligible: "Filled circle", Held: "Filled square", Excluded: "Struck circle", "Needs confirmation": "Dashed circle", "Not included": "Open circle" };
  await T.makeSet({
    name: "Status shape",
    lane: "atoms",
    cols: "Status",
    desc: "The shape half of a status, 12 x 12: filled circle (eligible), filled square (held), struck circle (excluded), dashed circle (needs confirmation), open circle (not included). Shape carries meaning without color.",
    variants: Object.entries(SHAPES).map(([status, [body, color]]) => ({
      props: { Status: status },
      make: (c) => {
        c.resize(12, 12);
        const s = T.svg(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">${body}</svg>`, { "#010101": color });
        s.children.forEach((ch, i) => (ch.name = i === 0 ? shapeNames[status] : "Strike"));
        moveIn(s, c);
      },
    })),
  });
  made.push("Status shape");

  await T.makeSet({
    name: "Status tag",
    lane: "atoms",
    cols: "Status",
    base: { layout: "H", gap: 6, cross: "CENTER" },
    desc: "Word plus shape, never color alone. Words come from the survivor flow (lib/i18n/en.ts status): Counts, Held, Not covered, Needs your answer, Not included. Atkinson Hyperlegible Next Bold 14/1.2. Eligible is green, Held is clay, Needs confirmation is ink, Excluded is ink-2, Not included is ink-3.",
    variants: Object.entries(SHAPES).map(([status, [, color, word]]) => ({
      props: { Status: status },
      make: (c) => {
        const s = T.inst("Status shape", { Status: status });
        s.name = "Shape";
        T.add(c, s);
        T.add(c, T.text(word, "text-xs/body bold", color, { name: "Word" }));
      },
    })),
  });
  made.push("Status tag");

  // ---------- Button ----------
  const BTN = {
    Primary: { fill: "green", hover: "green-strong", stroke: null, text: "on-green" },
    Secondary: { fill: null, hover: "green-tint", stroke: "green", text: "green" },
    Quiet: { fill: null, hover: "paper-sunk", stroke: "line-strong", text: "ink-2" },
  };
  const STATES = ["Default", "Hover", "Focus", "Disabled"];
  await T.makeSet({
    name: "Button",
    lane: "atoms",
    rows: "Variant",
    cols: "State",
    base: { layout: "H", align: "CENTER", cross: "CENTER", pad: [0, "space-5"], gap: "space-2", radius: "radius-btn" },
    desc: "Primary: green fill, paper text. Secondary: green outline. Quiet: a line-strong outline with ink-2 text (DESIGN.md calls it ink-3; globals.css ships line-strong). 48px tall (tap), 24px sides, 6px radius, Atkinson Hyperlegible Next SemiBold 16. Hover darkens the fill or adds a tint. Focus is a 3px green ring 2px outside the edge. Disabled is 45% opacity. Labels say what happens, never Submit or OK.",
    note: "**Behavior.** Transitions on background and border only, 160ms with cubic-bezier(0.2, 0.7, 0.2, 1); cut to zero under prefers-reduced-motion. A button that moves money stays disabled until the six-digit code is typed.",
    variants: Object.keys(BTN).flatMap((variant) =>
      STATES.map((state) => ({
        props: { Variant: variant, State: state },
        make: (c) => {
          const b = BTN[variant];
          T.num(c, "minHeight", "tap");
          const fill = state === "Hover" ? b.hover : b.fill;
          c.fills = fill ? [T.paint(fill)] : [];
          if (b.stroke) T.stroke(c, b.stroke, 1, "INSIDE");
          T.add(c, T.text("Find my costs", "text-sm/body semibold", b.text, { name: "Label" }));
          if (state === "Disabled") c.opacity = 0.45;
          if (state === "Focus") T.focusRing(c, "green", 2, 6);
        },
      })),
    ),
    props: { text: [{ name: "Label", default: "Find my costs" }] },
  });
  made.push("Button");

  // ---------- Text link ----------
  await T.makeSet({
    name: "Text link",
    lane: "atoms",
    cols: "Size",
    base: { layout: "H", cross: "CENTER" },
    desc: "Links and link-style buttons: green, underlined 1px with a 0.2em offset (2px on hover). At least 44px tall to tap. Body size inside paragraphs and option rows, Small in tallies and footers.",
    variants: [
      ["Body", "text-md/body", "Use a sample statement"],
      ["Small", "text-sm/body", "See the bill"],
    ].map(([size, style, label]) => ({
      props: { Size: size },
      make: (c) => {
        T.num(c, "minHeight", "touch-target");
        T.add(c, T.text(label, style, "green", { name: "Label", deco: "UNDERLINE" }));
      },
    })),
    props: { text: [{ name: "Label", default: "Use a sample statement" }] },
  });
  made.push("Text link");

  // ---------- Exit this page ----------
  await T.makeSet({
    name: "Exit this page",
    lane: "atoms",
    cols: "State",
    base: { layout: "V", gap: 2, cross: "MAX" },
    desc: "The quick exit. Ink fill, paper text, Bold 16, at least 44px tall, 6px radius. Fixed 12px from the top right of every screen and repeated inside every sheet. The Esc hint shows only with a fine pointer (desktop).",
    note: "**Exit this page.** Click it, or press Esc twice within 1 second (listened for in the capture phase, so an open sheet cannot swallow the second press). The screen blanks at once, the tab title becomes Weather, saved progress locks, this tab's session storage is cleared, and location.replace() loads a neutral weather search, so Back does not return to Tend. If Back restores a cached Tend page anyway, it blanks and reloads (pageshow).",
    variants: ["Default", "Hover", "Focus"].map((state) => ({
      props: { State: state },
      make: (c) => {
        const btn = T.build(
          T.fr("Button", "H", { pad: [0, "space-4"], cross: "CENTER", radius: "radius-btn", fill: state === "Hover" ? "ink-2" : "ink" }, [
            T.tx("Exit this page", "text-sm/body bold", "paper", { name: "Label" }),
          ]),
          c,
        );
        T.num(btn, "minHeight", "touch-target");
        if (state === "Focus") T.focusRing(btn, "ink", 3, 6);
        const hint = T.build(
          T.fr("Hint", "H", { gap: 4, pad: [0, "space-1"], cross: "CENTER", radius: "radius-1", fill: "paper" }, [
            T.tx("or press", "text-xs/body", "ink-3", { name: "Before" }),
            { t: "inst", comp: "Key cap", name: "Esc" },
            T.tx("twice", "text-xs/body", "ink-3", { name: "After" }),
          ]),
          c,
        );
        hint.name = "Hint";
      },
    })),
    props: { bool: [{ name: "Esc hint", default: true, layer: "Hint" }], text: [{ name: "Label", default: "Exit this page" }] },
  });
  made.push("Exit this page");

  // ---------- Citation ----------
  await T.makeSet({
    name: "Citation",
    lane: "atoms",
    cols: "State",
    base: { layout: "H", gap: 2, cross: "CENTER", pad: [0, "space-2"], radius: "radius-1" },
    desc: "The pinpoint as an underlined button: green, Bold 14, at least 44px tall. A long pinpoint ends in ... after 24 characters. +N says how many more rules stand behind the line. It opens a sheet with the plain summary, the exact quote highlighted in green-tint, and a link to the sentence on the official page.",
    note: "**Citation.** Opens Sheet (Tone=Held when the line is held). The sheet lists every rule behind the line, grouped by kind, each with its pinpoint, rule id, plain summary, the verbatim quote in Source Serif 4 on green-tint, and Read this sentence on the official site (a text fragment link). Screen readers hear: show the law for <subject>.",
    variants: ["Default", "Hover", "Focus"].map((state) => ({
      props: { State: state },
      make: (c) => {
        T.num(c, "minHeight", "touch-target");
        if (state === "Hover") T.fill(c, "green-tint");
        T.add(c, T.text("MCL 18.355a(2)", "text-xs/body bold", "green", { name: "Pinpoint", deco: "UNDERLINE" }));
        T.add(c, T.text("+4", "text-xs/body", "ink-3", { name: "More", deco: "UNDERLINE" }));
        if (state === "Focus") T.focusRing(c, "green", 2, 4);
      },
    })),
    props: {
      text: [
        { name: "Pinpoint", default: "MCL 18.355a(2)" },
        { name: "More", default: "+4" },
      ],
      bool: [{ name: "Show more", default: true, layer: "More" }],
    },
  });
  made.push("Citation");

  // ---------- Answer button ----------
  await T.makeSet({
    name: "Answer button",
    lane: "atoms",
    cols: "State",
    base: { layout: "H", align: "CENTER", cross: "CENTER", pad: [0, "space-4"], radius: "radius-btn" },
    desc: "Yes, No, Not sure under a question in the ledger. 44px tall, at least 76px wide, SemiBold 16 on paper with a line-strong border. Pressed fills green. Not sure keeps the line out of the total until the person decides.",
    variants: ["Default", "Hover", "Pressed"].map((state) => ({
      props: { State: state },
      make: (c) => {
        T.num(c, "minHeight", "touch-target");
        T.num(c, "minWidth", 76);
        T.fill(c, state === "Pressed" ? "green" : "paper");
        T.stroke(c, state === "Default" ? "line-strong" : "green", 1, "INSIDE");
        T.add(c, T.text("Yes", "text-sm/body semibold", state === "Pressed" ? "on-green" : "ink", { name: "Label" }));
      },
    })),
    props: { text: [{ name: "Label", default: "Yes" }] },
  });
  made.push("Answer button");

  // ---------- Checkbox ----------
  await T.makeSet({
    name: "Checkbox",
    lane: "atoms",
    rows: "State",
    cols: "Checked",
    base: { layout: "H", align: "CENTER", cross: "CENTER", radius: "radius-1" },
    desc: "22 x 22 with accent-color green, as the browser draws it. A direct match in the ledger starts checked, one tap to uncheck. Sits inside a 44px tall label.",
    variants: ["Default", "Focus"].flatMap((state) =>
      ["Yes", "No"].map((checked) => ({
        props: { Checked: checked, State: state },
        make: (c) => {
          c.layoutSizingHorizontal = "FIXED";
          c.layoutSizingVertical = "FIXED";
          c.resize(22, 22);
          if (checked === "Yes") {
            T.fill(c, "green");
            const i = T.inst("Icon", { Name: "Check" });
            i.name = "Check";
            T.add(c, i);
            for (const v of i.findAll((n) => n.type === "VECTOR")) v.strokes = [T.paint("on-green")];
          } else {
            T.fill(c, "paper-raised");
            T.stroke(c, "line-strong", 1.5, "INSIDE");
          }
          if (state === "Focus") T.focusRing(c, "green", 2, 4);
        },
      })),
    ),
  });
  made.push("Checkbox");

  // ---------- Radio ----------
  await T.makeSet({
    name: "Radio",
    lane: "atoms",
    cols: "Selected",
    desc: "22 x 22 radio with accent-color green: an open line-strong ring, or a green ring with a green dot.",
    variants: ["Yes", "No"].map((sel) => ({
      props: { Selected: sel },
      make: (c) => {
        c.resize(22, 22);
        const ring = figma.createEllipse();
        ring.name = "Ring";
        c.appendChild(ring);
        ring.resize(22, 22);
        T.fill(ring, "paper-raised");
        T.stroke(ring, sel === "Yes" ? "green" : "line-strong", sel === "Yes" ? 2 : 1.5, "INSIDE");
        if (sel === "Yes") {
          const dot = figma.createEllipse();
          dot.name = "Dot";
          c.appendChild(dot);
          dot.resize(10, 10);
          dot.x = 6;
          dot.y = 6;
          T.fill(dot, "green");
        }
      },
    })),
  });
  made.push("Radio");

  // ---------- Choice card ----------
  await T.makeSet({
    name: "Choice card",
    lane: "atoms",
    rows: "State",
    cols: "Selected",
    base: { layout: "H", gap: "space-2", cross: "CENTER", pad: [0, "space-4", 0, "space-3"], radius: "radius-btn" },
    desc: "One answer in a Check question (Yes, No, Not sure; Not yet for police). 48px tall, line-strong border on paper-raised. Selected turns the border green, fills green-tint, and bolds the label, so the choice shows without color too.",
    variants: ["Default", "Focus"].flatMap((state) =>
      ["No", "Yes"].map((sel) => ({
        props: { Selected: sel, State: state },
        make: (c) => {
          T.num(c, "minHeight", "tap");
          T.fill(c, sel === "Yes" ? "green-tint" : "paper-raised");
          T.stroke(c, sel === "Yes" ? "green" : "line-strong", 1, "INSIDE");
          const r = T.inst("Radio", { Selected: sel });
          r.name = "Radio";
          T.add(c, r);
          T.add(c, T.text(sel === "Yes" ? "Yes" : "No", sel === "Yes" ? "text-md/body bold" : "text-md/body", "ink", { name: "Label" }));
          if (state === "Focus") T.focusRing(c, "green", 2, 6);
        },
      })),
    ),
    props: { text: [{ name: "Label", default: "Yes" }] },
  });
  made.push("Choice card");

  await T.refresh();
  return { made, comps: Object.keys(T.comps) };
})()
