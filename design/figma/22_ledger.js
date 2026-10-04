// Components, part 3: ledger bed header, ledger lines, bill lines, and the law quote.
// All copy is Rowan's real ledger from the running app (Michigan, sample statement and sample bill).
(async () => {
  const T = window.__tend;
  await T.goto("Components");
  const made = [];

  // ---------- Ledger bed header ----------
  await T.makeComp({
    name: "Ledger bed header",
    lane: "ledger",
    base: { layout: "H", wrap: true, gap: "space-4", rowGap: "space-2", align: "SPACE_BETWEEN", textBaseline: true, pad: ["space-3", 0, 0, 0], stroke: { c: "ink", sides: { t: 1.5 } } },
    desc: "One bed per kind of cost (Care, Counseling, Getting there, Home, Work, Not covered), each under a 1.5px ink rule. Title in Source Serif 4 SemiBold 26; the running amount in ink-3.",
    make: (c) => {
      c.resize(358, c.height);
      c.layoutSizingHorizontal = "FIXED";
      T.add(c, T.text("Care", "text-xl/serif", "ink", { name: "Title" }));
      T.add(c, T.text("$118.00 counted", "text-sm/body", "ink-3", { name: "Total" }));
    },
    props: {
      text: [
        { name: "Title", default: "Care" },
        { name: "Total", default: "$118.00 counted" },
      ],
    },
  });
  made.push("Ledger bed header");

  // ---------- Ledger line ----------
  const LINES = {
    Eligible: {
      desc: "Emergency department visit, copay",
      date: "Bill",
      reason: "Line 1 of the bill from Riverbend General Hospital.",
      from: null,
      check: true,
      cite: ["MCL 18.361(2)(a)", "+3"],
      amount: "$75.00",
    },
    "Eligible capped": {
      desc: "Clearwater Counseling Group - session",
      date: "Jun 17",
      reason: "A counseling provider charge.",
      from: "From your statement.",
      check: true,
      cite: ["MCL 18.361(6)", "+4"],
      cap: "Limited from $150.00",
      was: "$150.00",
      amount: "$125.00",
    },
    Held: {
      desc: "Medical forensic exam, deductible applied",
      date: "Bill",
      reason: "Line 2 of the bill from Riverbend General Hospital.",
      from: null,
      cite: ["MCL 18.355a(2)", "+4"],
      held: "Don't pay this line. The law says you should not be billed for it.",
      amount: "$325.00",
      note: "Don't pay",
    },
    "Needs confirmation": {
      desc: "Wayfare Rides - trip",
      date: "Jun 17",
      reason: "A ride on a day with care.",
      from: "From your statement.",
      cite: ["MCL 18.361(2)(e)(ii)", "+1"],
      question: "Was this ride to care?",
      amount: "$12.00",
      note: "Not counted",
    },
    Excluded: {
      desc: "Brightline Wireless - new phone",
      date: "Jun 20",
      reason: "A replaced phone.",
      from: "From your statement.",
      cite: ["MDHHS What Costs May Be...", null],
      amount: "$299.00",
      note: "Not counted",
    },
    "Not included": {
      desc: "Hearthstone Pharmacy - Rx copay",
      date: "Jun 15",
      reason: "A prescription copay.",
      from: "From your statement.",
      cite: null,
      rowNote: "No verified rule for this state names this kind of cost, so Tend leaves it out. An advocate or the program can tell you if it is covered.",
      amount: "$25.00",
      note: "Not counted",
    },
  };
  const TAG = { Eligible: "Eligible", "Eligible capped": "Eligible", Held: "Held", "Needs confirmation": "Needs confirmation", Excluded: "Excluded", "Not included": "Not included" };

  const deco = (c, held) => {
    // Absolute layers: the hairline under the row and, for a held line, the clay tint and bar.
    // They reach 8px past the text on each side, like the row's negative margin in flow.module.css.
    const abs = (name, x, w, y, h, cons) => {
      const r = figma.createRectangle();
      r.name = name;
      c.appendChild(r);
      r.layoutPositioning = "ABSOLUTE";
      r.x = x;
      r.y = y;
      r.resize(w, h);
      r.constraints = cons;
      return r;
    };
    const line = abs("Divider", -8, c.width + 16, c.height - 1, 1, { horizontal: "STRETCH", vertical: "MAX" });
    T.fill(line, "line");
    if (held) {
      const bg = abs("Held tint", -8, c.width + 16, 0, c.height, { horizontal: "STRETCH", vertical: "STRETCH" });
      T.fill(bg, "clay-tint");
      bg.cornerRadius = 4;
      const bar = abs("Clay bar", -8, 3, 0, c.height, { horizontal: "MIN", vertical: "STRETCH" });
      T.fill(bar, "clay");
      bar.topLeftRadius = 4;
      bar.bottomLeftRadius = 4;
      c.insertChild(0, bar);
      c.insertChild(0, bg);
    }
  };

  const buildLine = (c, status, layout) => {
    const d = LINES[status];
    const phone = layout === "Phone";
    c.resize(phone ? 358 : 704, c.height);
    c.layoutSizingHorizontal = "FIXED";
    const top = T.build(T.fr("Top", "H", { gap: "space-4", cross: "MIN", w: "FILL" }), c);
    if (!phone) {
      const date = T.build(T.fr("Date", "V", { pad: [4, 0, 0, 0] }, [T.tx(d.date, "text-xs/mono", "ink-3", { name: "Date text" })]), top);
      T.add(top, date, { w: 68 });
    }
    const main = T.build(T.fr("Main", "V", { gap: "space-1", w: "FILL" }), top);
    if (d.check) {
      const inc = T.build(T.fr("Include", "H", { gap: "space-3", cross: "MIN", pad: [2, 0, 0, 0], w: "FILL" }), main);
      T.num(inc, "minHeight", "touch-target");
      const box = T.build(T.fr("Box", "V", { pad: [3, 0, 0, 0] }, [{ t: "inst", comp: "Checkbox", variant: { Checked: "Yes", State: "Default" }, name: "Checkbox" }]), inc);
      box.name = "Box";
      T.add(inc, T.text(d.desc, "text-md/body", "ink", { name: "Description" }), { w: "FILL" });
    } else T.add(main, T.text(d.desc, "text-md/body", "ink", { name: "Description" }), { w: "FILL" });
    const reasonText = (phone && d.from ? `${d.date} · ` : "") + d.reason + (d.from ? " " + d.from : "");
    const reason = T.text(reasonText, "text-sm/body", "ink-2", { name: "Reason", ranges: d.from ? [{ find: d.from, color: "ink-3" }] : [] });
    T.add(main, reason, { w: "FILL" });
    const tags = T.build(T.fr("Tags", "H", { wrap: true, gap: "space-4", rowGap: 0, cross: "CENTER", w: "FILL" }), main);
    T.num(tags, "minHeight", 32);
    const tag = T.inst("Status tag", { Status: TAG[status] });
    tag.name = "Status";
    T.add(tags, tag);
    if (d.cite) {
      const ci = T.inst("Citation", { State: "Default" }, { Pinpoint: d.cite[0], More: d.cite[1] || "+1", "Show more": Boolean(d.cite[1]) });
      ci.name = "Citation";
      T.add(tags, ci);
      ci.isExposedInstance = true;
    }
    if (d.cap) T.add(tags, T.text(d.cap, "text-xs/body", "ink-2", { name: "Cap" }));
    if (d.rowNote) T.add(main, T.text(d.rowNote, "text-sm/body", "ink-2", { name: "Note" }), { w: "FILL" });
    if (d.held) T.add(main, T.text(d.held, "text-sm/body bold", "clay", { name: "Held note" }), { w: "FILL" });
    const amt = T.build(T.fr("Amount", "V", { gap: 2, cross: "MAX", pad: [1, 0, 0, 0] }), top);
    if (d.was) T.add(amt, T.text(d.was, "text-xs/mono", "ink-3", { name: "Was", deco: "STRIKETHROUGH" }));
    const counted = status.startsWith("Eligible");
    const held = status === "Held";
    T.add(
      amt,
      T.text(d.amount, counted || held ? "text-md/mono bold" : "text-md/mono", counted ? "ink" : held ? "clay" : "ink-3", {
        name: "Amount text",
        deco: held ? "STRIKETHROUGH" : undefined,
      }),
    );
    if (d.note) T.add(amt, T.text(d.note, held ? "text-xs/body bold" : "text-xs/body", held ? "clay" : "ink-3", { name: "Amount note" }));
    if (d.question) {
      // On wide screens the question sits under the description, past the date column.
      const holder = phone ? c : T.build(T.fr("Question row", "H", { pad: [0, 0, 0, 84], w: "FILL" }), c);
      const q = T.build(
        T.fr("Question", "H", { wrap: true, gap: "space-4", rowGap: "space-2", cross: "CENTER", pad: ["space-2", "space-2", "space-2", "space-4"], radius: "radius-btn", fill: "paper-raised", stroke: { c: "line" } }, [
          T.tx(d.question, "text-md/body bold", "ink", { name: "Question text" }),
        ]),
        holder,
      );
      q.layoutSizingHorizontal = "FILL";
      const answers = T.build(T.fr("Answers", "H", { gap: "space-2" }), q);
      for (const label of ["Yes", "No", "Not sure"]) {
        const a = T.inst("Answer button", { State: "Default" }, { Label: label });
        a.name = label;
        T.add(answers, a);
      }
      const qt = q.findOne((n) => n.name === "Question text");
      qt.layoutSizingHorizontal = "FILL";
      T.num(qt, "minWidth", 160);
    }
    deco(c, held);
  };

  await T.makeSet({
    name: "Ledger line",
    lane: "ledger",
    rows: "Status",
    cols: "Layout",
    gap: 48,
    pad: 48,
    base: { layout: "V", gap: "space-1", pad: ["space-4", 0] },
    desc: "One cost. Date in mono (inline on phones), the description, the plain reason with where it came from, then the status tag and the citation, and the amount right aligned in mono. A direct match starts checked. A guess asks a plain question with Yes, No, Not sure, and counts only after a yes. A held line gets the clay bar and clay tint, a struck amount, and Don't pay. Not covered lines stay visible with the rule that leaves them out. Edit the text layers directly; the citation is an exposed instance.",
    note: "**Ledger line.** When a line's status changes it settles from a green-tint background over 1.2s (ease cubic-bezier(0.2, 0.7, 0.2, 1)); nothing animates on load, and reduced motion cuts it to zero. Held lines never count toward the total and never grow a plant.",
    variants: Object.keys(LINES).flatMap((status) =>
      ["Phone", "Desktop"].map((layout) => ({
        props: { Status: status, Layout: layout },
        make: (c) => buildLine(c, status, layout),
      })),
    ),
  });
  made.push("Ledger line");

  // ---------- Bill line ----------
  const BILL = {
    Counts: ["1", "Emergency department visit, copay", "$75.00"],
    Held: ["2", "Medical forensic exam, deductible applied", "$325.00"],
  };
  await T.makeSet({
    name: "Bill line",
    lane: "ledger",
    cols: "Status",
    base: { layout: "H", cross: "MIN", stroke: { c: "line", sides: { b: 1 } } },
    desc: "A row of the itemized bill as Tend read it on the device: line number (mono, ink-3), the service with its status, and the amount in mono. A held row gets clay-tint, a 3px clay bar, a struck clay amount, and You should not be billed for this.",
    variants: Object.entries(BILL).map(([status, [no, service, amount]]) => ({
      props: { Status: status },
      make: (c) => {
        const held = status === "Held";
        c.resize(324, c.height);
        c.layoutSizingHorizontal = "FIXED";
        if (held) T.fill(c, "clay-tint");
        const no_ = T.build(T.fr("Line", "V", { pad: ["space-3", "space-2"] }, [T.tx(no, "text-md/mono", "ink-3", { name: "Number" })]), c);
        T.add(c, no_, { w: 40 });
        T.build(
          T.fr("Service", "V", { gap: "space-1", pad: ["space-3", "space-2"], w: "FILL" }, [
            T.tx(service, "text-md/body", "ink", { name: "Service text", w: "FILL" }),
            T.fr("Status row", "V", { gap: "space-1", w: "FILL" }, [
              { t: "inst", comp: "Status tag", variant: { Status: held ? "Held" : "Eligible" }, name: "Status" },
              held ? T.tx("You should not be billed for this.", "text-xs/body bold", "clay", { name: "Why", w: "FILL" }) : null,
            ].filter(Boolean)),
          ]),
          c,
        );
        T.build(
          T.fr("Amount", "V", { cross: "MAX", pad: ["space-3", "space-2"] }, [
            T.tx(amount, held ? "text-md/mono bold" : "text-md/mono", held ? "clay" : "ink", { name: "Amount text", deco: held ? "STRIKETHROUGH" : undefined }),
          ]),
          c,
        );
        if (held) {
          const bar = figma.createRectangle();
          bar.name = "Clay bar";
          c.appendChild(bar);
          bar.layoutPositioning = "ABSOLUTE";
          bar.x = 0;
          bar.y = 0;
          bar.resize(3, c.height);
          bar.constraints = { horizontal: "MIN", vertical: "STRETCH" };
          T.fill(bar, "clay");
        }
      },
    })),
  });
  made.push("Bill line");

  // ---------- Law quote ----------
  const RULE = {
    pinpoint: "MCL 18.355a(2)",
    id: "MI-EXAM-1",
    summary:
      "A health care provider may not bill a sexual assault survivor for any part of a forensic exam, including insurance deductibles, co-pays, or a denied insurance claim.",
    quote:
      "A health care provider shall not submit a bill for any portion of the costs of a sexual assault medical forensic examination to the victim of the sexual assault, including any insurance deductible or co-pay, denial of claim by an insurer, or any other out-of-pocket expense.",
    link: "Read this sentence on legislature.mi.gov",
    provenance: "MCL 18.355a (sexual assault medical forensic examination). Saved October 3, 2026. SHA-256 abbcefc231cd",
  };
  T.RULE_EXAM = RULE;
  T.quoteBlock = (quote, width) => {
    const q = T.frame({ name: "Quote", layout: "V", gap: 4.3, pad: [4, 0, 4, 16], stroke: { c: "green", sides: { l: 3 } } });
    const lines = T.markLines(quote, "text-md/serif quote", width - 19);
    lines.forEach((ln, i) => {
      const m = T.frame({ name: `Mark ${i + 1}`, layout: "H", pad: [1, 3], fill: "green-tint" });
      m.appendChild(T.text(ln, "text-md/serif quote line", "ink", { name: "Line" }));
      q.appendChild(m);
    });
    return q;
  };
  await T.makeSet({
    name: "Law quote",
    lane: "ledger",
    cols: "Layout",
    base: { layout: "V", gap: "space-2" },
    desc: "A rule as the survivor sees it: the pinpoint and rule id, the plain summary first, then the exact words of the law in Source Serif 4 with every line marked in green-tint behind a 3px green rule, then where the sentence lives and when Tend saved it, with its SHA-256. Quotes stay in English in every language; the Spanish screens turn on the Language note from es.ts.",
    variants: [
      ["Phone", 358],
      ["Desktop", 476],
    ].map(([layout, width]) => ({
      props: { Layout: layout },
      make: (c) => {
        c.resize(width, c.height);
        c.layoutSizingHorizontal = "FIXED";
        T.build(
          T.fr("Head", "H", { wrap: true, gap: "space-3", rowGap: "space-1", align: "SPACE_BETWEEN", textBaseline: true, w: "FILL" }, [
            T.tx(RULE.pinpoint, "text-md/body bold", "ink", { name: "Pinpoint" }),
            T.tx(RULE.id, "text-xs/mono", "ink-3", { name: "Rule id" }),
          ]),
          c,
        );
        T.add(c, T.text(RULE.summary, "text-md/body", "ink-2", { name: "Summary" }), { w: "FILL" });
        const q = T.quoteBlock(RULE.quote, width);
        T.add(c, q, { w: "FILL" });
        T.add(c, T.text("La ley se cita en su idioma original, el inglés.", "text-xs/body", "ink-3", { name: "Language note" }), { w: "FILL" });
        T.build(
          T.fr("Source", "V", { gap: 2, w: "FILL" }, [
            T.tx(RULE.link, "text-sm/body", "green", { name: "Link", deco: "UNDERLINE", w: "FILL" }),
            T.tx(RULE.provenance, "text-xs/body", "ink-3", { name: "Provenance", w: "FILL", ranges: [{ find: "abbcefc231cd", style: "text-xs/mono" }] }),
          ]),
          c,
        );
      },
    })),
    props: {
      text: [
        { name: "Pinpoint", default: RULE.pinpoint },
        { name: "Rule id", default: RULE.id },
        { name: "Summary", default: RULE.summary },
        { name: "Link", default: RULE.link },
      ],
      bool: [{ name: "Language note", default: false, layer: "Language note" }],
    },
  });
  made.push("Law quote");

  await T.refresh();
  return { made };
})()
