// Components, part 4: sheet contents and the Sheet (bottom sheet on phones, side panel from 900px).
(async () => {
  const T = window.__tend;
  await T.goto("Components");
  const made = [];

  // dt over dd on phones (flow.module.css .terms at 560px and below)
  const term = (label, value, opts = {}) =>
    T.fr(label, "V", { gap: 2, pad: [0, 0, "space-3", 0], stroke: { c: "line", sides: { b: 1 } }, w: "FILL" }, [
      T.tx(label, "text-sm/body", "ink-3", { name: "Term" }),
      T.tx(value, opts.style || "text-md/body bold", "ink", { name: "Value", w: "FILL" }),
    ]);

  const content = async (name, desc, children) =>
    T.makeComp({
      name: "Sheet content/" + name,
      lane: "sheets",
      base: { layout: "V", gap: "space-5" },
      desc,
      make: (c) => {
        c.resize(358, c.height);
        c.layoutSizingHorizontal = "FIXED";
        for (const ch of children()) T.build(ch, c);
      },
    });

  // ---------- Law behind a line ----------
  await content(
    "Law",
    "What a citation opens: the subject, one plain sentence on why it matters, then each rule with its quote. Used with Sheet Tone=Held for a held line.",
    () => [
      T.fr("Intro", "V", { gap: "space-2", w: "FILL" }, [
        T.tx("Medical forensic exam, deductible applied, June 14, 2026", "text-md/body bold", "ink", { name: "Subject", w: "FILL" }),
        T.tx("The law says you should not be billed for this. Don't pay it.", "text-md/body", "ink", { name: "Explain", w: "FILL" }),
      ]),
      T.fr("Rule", "V", { gap: "space-4", pad: ["space-4", 0, 0, 0], stroke: { c: "line", sides: { t: 1 } }, w: "FILL" }, [
        { t: "inst", comp: "Law quote", variant: { Layout: "Phone" }, name: "Law quote", w: "FILL" },
      ]),
      T.tx("Every rule Tend verified for Michigan", "text-xs/body", "green", { name: "All rules", deco: "UNDERLINE" }),
    ],
  );
  made.push("Sheet content/Law");

  // ---------- Letter for the billing office ----------
  const LETTER = [
    "[Date]",
    "",
    "To: Billing office, [hospital or clinic name]",
    "About: Account [account number]",
    "",
    "I am writing about this charge on my account for a sexual assault forensic exam:",
    "",
    "    Medical forensic exam, deductible applied, June 14, 2026: $325.00",
    "",
    "Michigan law says I should not be billed for this exam:",
    "",
    `"${T.RULE_EXAM ? T.RULE_EXAM.quote : "A health care provider shall not submit a bill for any portion of the costs of a sexual assault medical forensic examination to the victim of the sexual assault, including any insurance deductible or co-pay, denial of claim by an insurer, or any other out-of-pocket expense."}" (MCL 18.355a(2))`,
    "",
    "Please remove the exam charge from my account, stop any collection on it, and send me an updated statement.",
    "",
    "The law names who pays for the exam instead:",
    "",
    '"The commission shall pay a health care provider not more than $1,200.00 for the cost of performing a sexual assault medical forensic examination" (MCL 18.355a(7))',
    "",
    "If you have questions, please contact me in writing.",
    "",
    "Thank you,",
    "[Your name]",
    "[A safe way to reach you]",
  ].join("\n");
  T.LETTER = LETTER;
  await content(
    "Letter",
    "The billing letter from lib/packet/letters.ts, in the survivor's voice with the law quoted. Names, dates, and account numbers stay as [placeholders]: Tend never knows them and never sends the letter.",
    () => [
      T.tx("Ready to send. Copy it into an email or a letter, or save it as a file.", "text-md/body", "ink", { name: "Lead", w: "FILL" }),
      T.fr("Letter", "V", { pad: ["space-4", "space-5"], fill: "paper-sunk", stroke: { c: "ink", sides: { l: 3 } }, w: "FILL" }, [
        T.tx(LETTER, "text-sm/body", "ink", { name: "Letter text", w: "FILL" }),
      ]),
      T.fr("Quotes", "H", { wrap: true, gap: "space-2", cross: "CENTER", w: "FILL" }, [
        T.tx("It quotes:", "text-xs/body", "ink-3", { name: "Label" }),
        { t: "inst", comp: "Citation", variant: { State: "Default" }, props: { Pinpoint: "MCL 18.355a(2)", More: "+1" }, name: "Citation" },
      ]),
      T.tx("Tend does not send anything for you. You choose if and when.", "text-xs/body", "ink-3", { name: "Never sent", w: "FILL" }),
    ],
  );
  made.push("Sheet content/Letter");

  // ---------- Pay the rest of this bill ----------
  await content(
    "Pay",
    "The confirm step. The person sees the exact amount, the account it comes from, who receives it, what it is for, and what stays unpaid, then types the six-digit code. Nothing moves before that.",
    () => [
      T.fr("Terms", "V", { gap: "space-3", w: "FILL" }, [
        term("Amount", "$118.00", { style: "text-2xl/phone serif" }),
        term("From", "Checking 0011"),
        term("To", "Riverbend General Hospital"),
        term("For", "Emergency department visit, copay, Laboratory services, coinsurance"),
        term("Not paid", "Medical forensic exam, deductible applied, $325.00. It stays held."),
      ]),
      { t: "inst", comp: "Notice", variant: { Tone: "Note" }, name: "Bank note", w: "FILL" },
      { t: "inst", comp: "Confirm code", variant: { State: "Complete" }, name: "Confirm code", w: "FILL" },
    ],
  );
  made.push("Sheet content/Pay");

  // ---------- Payment result ----------
  await content(
    "Payment result",
    "After the bank answers: the amount paid, from and to, the bank's own record id, and whether Tend read the record back from the bank and it matched.",
    () => [
      T.tx("Paid $118.00.", "text-2xl/phone serif", "ink", { name: "Result" }),
      T.fr("Terms", "V", { gap: "space-3", w: "FILL" }, [
        term("From", "Checking 0011"),
        term("To", "Riverbend General Hospital"),
        term("Bank record", "66a1f9d7e4b0a7d1c3f5b310", { style: "text-sm/mono" }),
        term("Checked with the bank", "The bank's record matches this payment."),
      ]),
    ],
  );
  made.push("Sheet content/Payment result");

  // ---------- What stays on this device ----------
  const FACTS = [
    "Your answers, your costs, and your files stay in this browser. Tend reads statements and bills here, and the law engine runs here.",
    "Something leaves only when you choose to send it: a payment you confirm, or a packet you share. A shared packet is locked before it leaves, and the key stays in the link.",
    "Tend never asks what happened, where, or who.",
    "If you save, your progress is locked with Touch ID or a passcode. Exit this page, or press Esc twice, to leave fast.",
  ];
  T.PRIVACY_FACTS = FACTS;
  await content(
    "Privacy",
    "What the privacy line's info button opens: the four facts, then every send with its time. It lists only what the person chose to send.",
    () => [
      T.fr("Facts", "V", { gap: "space-3", w: "FILL" }, FACTS.map((f, i) => T.fr(`Fact ${i + 1}`, "H", { gap: "space-3", w: "FILL" }, [
        T.fr("Dot", "V", { pad: [10, 0, 0, 0] }, [{ t: "rect", name: "Bullet", size: [5, 5], fill: "ink-3", radius: 3 }]),
        T.tx(f, "text-md/body", "ink", { name: "Fact", w: "FILL" }),
      ]))),
      T.fr("Sent", "V", { gap: "space-2", pad: ["space-4", 0, 0, 0], stroke: { c: "line", sides: { t: 1 } }, w: "FILL" }, [
        T.tx("What you sent", "text-sm/body bold", "ink-2", { name: "Title" }),
        T.tx("Oct 3, 3:31 PM: a payment of $118.00 to Riverbend General Hospital. It went to the bank.", "text-md/body", "ink", { name: "Event", w: "FILL" }),
      ]),
    ],
  );
  made.push("Sheet content/Privacy");

  // ---------- Sheet ----------
  const contents = ["Law", "Letter", "Pay", "Payment result", "Privacy"].map((n) => T.comps["Sheet content/" + n]);
  await T.makeSet({
    name: "Sheet",
    lane: "sheets",
    rows: "Tone",
    cols: "Type",
    gap: 64,
    desc: "A native dialog. Bottom sheet on phones (paper-raised, 12px top corners, the sheet shadow, up to 90% of the height); a 540px side panel from 900px wide (DESIGN.md; components/flow/sheet.module.css currently uses 560px). Close and Exit this page sit at the top, because a modal makes the corner button unreachable. Held tone adds a 4px clay rule on the top (phone) or left (panel). Swap the Content slot for any Sheet content component.",
    note: "**Sheet.** showModal() traps focus; Esc closes it (Esc twice still exits Tend). Clicking the scrim closes it. Opening slides it 24px up (phone) or 28px in (panel) over 320ms with cubic-bezier(0.2, 0.7, 0.2, 1); reduced motion makes it appear at once. While a sheet is open the corner Exit this page is hidden and the sheet's own copy is used.",
    variants: ["Bottom sheet", "Side panel"].flatMap((type) =>
      ["Default", "Held"].map((tone) => ({
        props: { Type: type, Tone: tone },
        make: (c) => {
          const phone = type === "Bottom sheet";
          T.style(c, { layout: "V", fill: "paper-raised", effect: phone ? "shadow-sheet" : "shadow-sheet-side", clip: true });
          c.resize(phone ? 390 : 540, phone ? 640 : 900);
          c.layoutSizingHorizontal = "FIXED";
          c.layoutSizingVertical = "FIXED";
          if (phone) T.radius(c, ["radius-sheet", "radius-sheet", 0, 0]);
          if (tone === "Held") T.stroke(c, "clay", 4, "INSIDE", phone ? { t: 4 } : { l: 4 });
          // Head
          const head = T.build(
            T.fr("Head", phone ? "V" : "H", {
              gap: phone ? "space-3" : "space-4",
              align: phone ? "MIN" : "SPACE_BETWEEN",
              cross: "MIN",
              pad: ["space-3", phone ? "space-4" : "space-5"],
              stroke: { c: "line", sides: { b: 1 } },
              w: "FILL",
            }),
            c,
          );
          const title = T.fr("Title", "V", { pad: [6, 0, 0, 0] }, [T.tx("Letter for the billing office", "text-xl/serif", "ink", { name: "Title text", w: "FILL" })]);
          const actions = T.fr("Actions", "H", { gap: "space-2", align: "MAX", cross: "CENTER" }, []);
          if (phone) {
            const a = T.build(actions, head);
            a.layoutSizingHorizontal = "FILL";
            const t = T.build(title, head);
            t.layoutSizingHorizontal = "FILL";
          } else {
            const t = T.build(title, head);
            t.layoutSizingHorizontal = "FILL";
            T.num(t, "minWidth", 240);
            T.build(actions, head);
          }
          const act = head.findOne((n) => n.name === "Actions");
          const close = T.inst("Button", { Variant: "Quiet", State: "Default" }, { Label: "Close" });
          close.name = "Close";
          T.add(act, close);
          T.num(close, "paddingLeft", "space-4");
          T.num(close, "paddingRight", "space-4");
          T.num(close, "minHeight", "touch-target");
          const exit = T.inst("Exit this page", { State: "Default" }, { "Esc hint": false });
          exit.name = "Exit this page";
          T.add(act, exit);
          // Body with the content slot
          const body = T.build(T.fr("Body", "V", { gap: "space-5", pad: ["space-5", phone ? "space-4" : "space-5"], clip: true }), c);
          body.layoutSizingHorizontal = "FILL";
          body.layoutSizingVertical = "FILL";
          const slot = contents[1].createInstance();
          slot.name = "Content";
          T.add(body, slot, { w: "FILL" });
          // Foot
          const foot = T.build(
            T.fr("Foot", "H", { gap: "space-3", wrap: true, pad: ["space-4", phone ? "space-4" : "space-5"], fill: "paper-raised", stroke: { c: "line", sides: { t: 1 } }, w: "FILL" }),
            c,
          );
          const p = T.inst("Button", { Variant: "Primary", State: "Default" }, { Label: "Copy the letter" });
          p.name = "Primary";
          T.add(foot, p);
          p.isExposedInstance = true;
          const s = T.inst("Button", { Variant: "Secondary", State: "Default" }, { Label: "Save as a file" });
          s.name = "Secondary";
          T.add(foot, s);
          s.isExposedInstance = true;
        },
      })),
    ),
    props: {
      text: [{ name: "Title", default: "Letter for the billing office", layer: "Title text" }],
      bool: [
        { name: "Footer", default: true, layer: "Foot" },
        { name: "Secondary action", default: true, layer: "Secondary" },
      ],
      swap: [{ name: "Content", layer: "Content", default: contents[1].id, preferred: contents }],
    },
  });
  made.push("Sheet");
  T.compactLanes();
  await T.refresh();
  return { made };
})()
