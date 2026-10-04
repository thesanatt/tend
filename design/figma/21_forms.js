// Components, part 2: fields, checkbox line, confirm code, notices, content note, privacy line,
// step nav, app header, site footer.
(async () => {
  const T = window.__tend;
  await T.goto("Components");
  const made = [];
  const STATES = ["Default", "Focus", "Error", "Disabled"];

  // ---------- Field/Select, Field/Date, Field/Text ----------
  const FIELDS = {
    Select: {
      label: "Which state did it happen in?",
      hint: "That state's program handles it, even if you live somewhere else.",
      value: "Michigan",
      error: "Choose a state first.",
      icon: "Chevron down",
      width: null,
      valueStyle: "text-md/body",
      desc: "A native select: 48px tall, line-strong border, 4px radius, paper-raised, up to 24rem wide. Label above (Bold 18), hint below it (16, ink-3).",
    },
    Date: {
      label: "On what date did it happen?",
      hint: "Just the date. Deadlines count from it.",
      value: "06/14/2026",
      error: "Enter a full date.",
      icon: "Calendar",
      width: 224,
      valueStyle: "text-md/body",
      desc: "A native date input, 14rem wide. Only the date, never the time or place. Disabled while I'm not sure of the date is checked.",
    },
    Text: {
      label: "Share this link with your advocate:",
      hint: "Stops working Oct 6, 3:52 PM. It opens once.",
      value: "https://youreowed.tech/share#q4T7mZk2.Hd8f0Vw3nXc5pLr1sJ9yUe6bAo2Gt7KzQ4mN1vR8wE5c",
      error: "Tend could not make the link.",
      icon: null,
      width: null,
      valueStyle: "text-xs/mono",
      desc: "A text input. The share link shows in the mono face, read only, selected on focus.",
    },
  };
  for (const [type, f] of Object.entries(FIELDS)) {
    await T.makeSet({
      name: "Field/" + type,
      lane: "forms",
      cols: "State",
      base: { layout: "V", gap: "space-2" },
      desc: `${f.desc} Errors are plain bold text behind a 3px ink bar, never red. Focus is a 3px green ring 2px outside the field.`,
      variants: STATES.map((state) => ({
        props: { State: state },
        make: (c) => {
          c.resize(358, c.height);
          c.layoutSizingHorizontal = "FIXED";
          T.build(
            T.fr("Label group", "V", { gap: "space-1", w: "FILL" }, [
              T.tx(f.label, "text-md/body bold", "ink", { name: "Label", w: "FILL" }),
              T.tx(f.hint, "text-sm/body", "ink-3", { name: "Hint", w: "FILL" }),
            ]),
            c,
          );
          const ctl = T.build(
            T.fr("Control", "H", { gap: "space-2", cross: "CENTER", pad: [0, "space-3"], radius: "radius-1", fill: "paper-raised", stroke: { c: "line-strong" }, clip: true }, [
              T.tx(f.value, f.valueStyle, "ink", { name: "Value", w: "FILL", truncate: true, maxLines: 1 }),
            ]),
            c,
          );
          T.num(ctl, "minHeight", "tap");
          if (f.width) T.add(c, ctl, { w: f.width });
          else ctl.layoutSizingHorizontal = "FILL";
          if (f.icon) {
            const i = T.inst("Icon", { Name: f.icon });
            i.name = "Icon";
            T.add(ctl, i);
          }
          if (state === "Disabled") ctl.opacity = 0.45;
          if (state === "Focus") T.focusRing(ctl, "green", 2, 4);
          if (state === "Error")
            T.build(
              T.fr("Error", "H", { pad: [0, 0, 0, "space-3"], stroke: { c: "ink", sides: { l: 3 } }, w: "FILL" }, [
                T.tx(f.error, "text-md/body bold", "ink", { name: "Error text", w: "FILL" }),
              ]),
              c,
            );
        },
      })),
      props: {
        text: [
          { name: "Label", default: f.label },
          { name: "Hint", default: f.hint },
          { name: "Value", default: f.value },
        ],
        bool: [{ name: "Show hint", default: true, layer: "Hint" }],
      },
    });
    made.push("Field/" + type);
  }

  // ---------- Checkbox line ----------
  await T.makeComp({
    name: "Checkbox line",
    lane: "forms",
    base: { layout: "H", gap: "space-3", cross: "CENTER" },
    desc: "A checkbox with its label, 44px tall, the whole row tappable. Used for I'm not sure of the date, Let it open only once, and the Still needed checklist.",
    make: (c) => {
      T.num(c, "minHeight", "touch-target");
      const b = T.inst("Checkbox", { Checked: "No", State: "Default" });
      b.name = "Box";
      T.add(c, b);
      b.isExposedInstance = true;
      T.add(c, T.text("I'm not sure of the date", "text-md/body", "ink", { name: "Label" }));
    },
    props: { text: [{ name: "Label", default: "I'm not sure of the date" }] },
  });
  made.push("Checkbox line");

  // ---------- Confirm code ----------
  const CODE = { Empty: "", Typing: "4829", Complete: "482913", "Wrong code": "482931" };
  await T.makeSet({
    name: "Confirm code",
    lane: "forms",
    cols: "State",
    base: { layout: "V", gap: "space-2", pad: "space-5", radius: "radius-2", stroke: { c: "line" } },
    desc: "Money moves only after the person types the six digits shown. The code is mono bold 28 with 0.08em tracking, split 3 and 3 for reading. The field is mono 26 with 0.2em tracking, 12rem wide, numeric keyboard. The code works once and expires; a wrong code says so plainly.",
    note: "**Confirm code.** inputMode numeric, autocomplete one-time-code, pattern [0-9]{6}. Pay stays disabled until 6 digits are typed. A 400 from the bank relay shows: That code does not match. A 410 shows: This code has expired or was already used. Screen readers hear the code digit by digit.",
    variants: Object.entries(CODE).map(([state, value]) => ({
      props: { State: state },
      make: (c) => {
        c.resize(358, c.height);
        c.layoutSizingHorizontal = "FIXED";
        T.add(c, T.text("To confirm on purpose, type this code:", "text-md/body", "ink", { name: "Intro", w: "FILL" }), { w: "FILL" });
        T.add(c, T.text("482 913", "text-2xl/phone mono bold", "ink", { name: "Code" }));
        T.add(c, T.text("Confirmation code", "text-md/body bold", "ink", { name: "Label" }));
        const ctl = T.build(
          T.fr("Control", "H", { cross: "CENTER", pad: [0, "space-3"], radius: "radius-1", fill: "paper-raised", stroke: { c: "line-strong" } }, [
            T.tx(value || " ", "text-xl/mono", "ink", { name: "Value" }),
          ]),
          c,
        );
        T.num(ctl, "minHeight", "tap");
        T.add(c, ctl, { w: 192 });
        if (state === "Typing") T.focusRing(ctl, "green", 2, 4);
        T.add(c, T.text("The code works once and expires at Oct 3, 3:40 PM.", "text-xs/body", "ink-3", { name: "Expiry", w: "FILL" }), {
          w: "FILL",
        });
        if (state === "Wrong code")
          T.build(
            T.fr("Error", "H", { pad: [0, 0, 0, "space-3"], stroke: { c: "ink", sides: { l: 3 } }, w: "FILL" }, [
              T.tx("That code does not match. Check the six digits and try again.", "text-md/body bold", "ink", { name: "Error text", w: "FILL" }),
            ]),
            c,
          );
      },
    })),
    props: {
      text: [
        { name: "Code", default: "482 913" },
        { name: "Expiry", default: "The code works once and expires at Oct 3, 3:40 PM." },
      ],
    },
  });
  made.push("Confirm code");

  // ---------- Notice ----------
  const NOTICE = {
    Note: ["The bank here is Nessie, Capital One's mock bank. Paying writes a record there. No real money moves.", "paper-sunk", "text-sm/body"],
    Problem: ["Tend could not reach its server. Check your connection and try again. No link was made.", null, "text-md/body bold"],
    Offline: ["You are offline. Check, the ledger, and the packet still work on this device.", "paper-sunk", "text-sm/body"],
  };
  await T.makeSet({
    name: "Notice",
    lane: "forms",
    cols: "Tone",
    base: { layout: "H", gap: "space-2", cross: "MIN" },
    desc: "Plain statements behind a 3px ink bar, never red and never an alarm. Note: demo and bank facts on paper-sunk. Problem: what went wrong and what still works, in bold. Offline: says which steps keep working on the device.",
    variants: Object.entries(NOTICE).map(([tone, [text, fill, style]]) => ({
      props: { Tone: tone },
      make: (c) => {
        c.resize(358, c.height);
        c.layoutSizingHorizontal = "FIXED";
        T.stroke(c, "ink", 3, "INSIDE", { l: 3 });
        if (fill) {
          T.fill(c, fill);
          T.num(c, "paddingTop", "space-3");
          T.num(c, "paddingBottom", "space-3");
          T.num(c, "paddingLeft", "space-4");
          T.num(c, "paddingRight", "space-4");
        } else T.num(c, "paddingLeft", "space-3");
        T.add(c, T.text(text, style, "ink", { name: "Text" }), { w: "FILL" });
        if (tone === "Offline") {
          const t = c.findOne((n) => n.name === "Text");
          t.setRangeTextStyleId(0, "You are offline.".length, T.ts["text-sm/body bold"].id);
        }
      },
    })),
  });
  made.push("Notice");

  // ---------- Content note ----------
  await T.makeComp({
    name: "Content note",
    lane: "forms",
    base: { layout: "V", gap: "space-4", pad: "space-6", radius: "radius-1", fill: "paper-raised", stroke: { c: "line" } },
    desc: "Holds sensitive content behind a plain note until the person chooses to see it, once per tab. Ink bar on the left, a serif title, the note in ink-2, one button to continue.",
    make: (c) => {
      c.resize(358, c.height);
      c.layoutSizingHorizontal = "FIXED";
      const bar = figma.createRectangle();
      bar.name = "Ink bar";
      c.appendChild(bar);
      bar.layoutPositioning = "ABSOLUTE";
      bar.x = 0;
      bar.y = 0;
      bar.resize(4, 100);
      T.fill(bar, "ink");
      bar.topLeftRadius = 4;
      bar.bottomLeftRadius = 4;
      bar.constraints = { horizontal: "MIN", vertical: "STRETCH" };
      T.add(c, T.text("Before you look", "text-xl/serif", "ink", { name: "Title" }), { w: "FILL" });
      T.add(
        c,
        T.text(
          "The next screens list medical bills and other costs from after a sexual assault, including a forensic exam. You can leave at any time with Exit this page in the corner, or by pressing Esc twice.",
          "text-md/body",
          "ink-2",
          { name: "Body" },
        ),
        { w: "FILL" },
      );
      const b = T.inst("Button", { Variant: "Primary", State: "Default" }, { Label: "Show it" });
      b.name = "Action";
      T.add(c, b);
      b.isExposedInstance = true;
      bar.resize(4, c.height);
    },
    props: {
      text: [
        { name: "Title", default: "Before you look" },
        {
          name: "Body",
          default:
            "The next screens list medical bills and other costs from after a sexual assault, including a forensic exam. You can leave at any time with Exit this page in the corner, or by pressing Esc twice.",
        },
      ],
    },
  });
  made.push("Content note");

  // ---------- Privacy line ----------
  const PRIV = {
    Quiet: ["On this device. Nothing has left it.", "ink-2"],
    Sent: ["On this device, except what you chose to send: a payment and a request to the bank.", "ink"],
  };
  await T.makeSet({
    name: "Privacy line",
    lane: "forms",
    rows: "Size",
    cols: "State",
    base: { layout: "H", align: "CENTER", fill: "paper-raised", stroke: { c: "line", sides: { b: 1 } } },
    desc: "One calm sentence under the header on every screen saying where the data is. It changes only when something actually left the device because the person chose to send it: a payment they confirmed, a locked share link, a request to the bank. The info button opens What stays on this device (on phones the words become the icon's accessible name).",
    note: "**Privacy line.** role=status, so a change is announced once. Quiet text is ink-2; once anything has been sent it turns ink. The sheet lists every send with its time.",
    variants: ["Phone", "Desktop"].flatMap((size) =>
      Object.entries(PRIV).map(([state, [text, color]]) => ({
        props: { State: state, Size: size },
        make: (c) => {
          const phone = size === "Phone";
          c.resize(phone ? 390 : 1440, c.height);
          c.layoutSizingHorizontal = "FIXED";
          const inner = T.build(
            T.fr("Inner", "H", { gap: "space-2", cross: "CENTER", pad: [4, phone ? "gutter-phone" : "gutter-desktop"] }, []),
            c,
          );
          T.num(inner, "minHeight", "touch-target");
          if (phone) inner.layoutSizingHorizontal = "FILL";
          else T.add(c, inner, { w: 1152 });
          const shield = T.inst("Icon", { Name: "Shield" });
          shield.name = "Shield";
          T.add(inner, shield);
          T.add(inner, T.text(text, "text-sm/body", color, { name: "Text" }), { w: "FILL" });
          const more = T.build(T.fr("What stays here", "H", { gap: "space-2", cross: "CENTER", align: "CENTER", pad: [0, "space-1"], radius: "radius-1" }, []), inner);
          T.num(more, "minHeight", "touch-target");
          T.num(more, "minWidth", "touch-target");
          const info = T.inst("Icon", { Name: "Info" });
          info.name = "Info";
          T.add(more, info);
          info.rescale(18 / 16);
          if (!phone) T.add(more, T.text("What stays here", "text-xs/body bold", "green", { name: "Label", deco: "UNDERLINE" }));
        },
      })),
    ),
  });
  made.push("Privacy line");

  // ---------- Step nav ----------
  const STEPS = ["Check", "Gather", "Packet", "Track"];
  await T.makeSet({
    name: "Step nav",
    lane: "forms",
    rows: "Current",
    cols: "Size",
    gap: 40,
    desc: "Check, Gather, Packet, Track, with the current step bold, a green number, and a 2px green rule. Steps replace history instead of pushing it, so Back leaves Tend rather than walking through costs. The save status sits at the end: Not saved yet and Save this (a link on phones, a quiet button on wider screens).",
    variants: ["Phone", "Desktop"].flatMap((size) =>
      STEPS.map((current) => ({
        props: { Current: current, Size: size },
        make: (c) => {
          const phone = size === "Phone";
          T.style(c, { layout: phone ? "V" : "H", align: phone ? "MIN" : "SPACE_BETWEEN", cross: phone ? "MIN" : "CENTER", stroke: { c: "line", sides: { b: 1 } } });
          c.resize(phone ? 358 : 1072, c.height);
          c.layoutSizingHorizontal = "FIXED";
          const list = T.build(T.fr("Steps", "H", { gap: phone ? "space-3" : "space-5" }), c);
          STEPS.forEach((s, i) => {
            const on = s === current;
            const step = T.build(
              T.fr(s, "H", { gap: phone ? 6 : "space-2", cross: "CENTER", stroke: on ? { c: "green", w: 2, sides: { b: 2 } } : undefined }, []),
              list,
            );
            T.num(step, "minHeight", "tap");
            const n = T.build(
              T.fr("Number", "H", { align: "CENTER", cross: "CENTER", radius: 11, fill: on ? "green" : null, stroke: { c: on ? "green" : "line-strong" } }, [
                T.tx(String(i + 1), "text-2xs/mono bold", on ? "on-green" : "ink", { name: "Digit" }),
              ]),
              step,
            );
            n.layoutSizingHorizontal = "FIXED";
            n.layoutSizingVertical = "FIXED";
            n.resize(phone ? 20 : 22, phone ? 20 : 22);
            T.add(step, T.text(s, on ? "text-sm/body bold" : "text-sm/body", on ? "ink" : "ink-2", { name: "Label" }));
          });
          const save = T.build(T.fr("Save status", "H", { gap: "space-3", cross: "CENTER", align: phone ? "MAX" : "MIN" }, []), c);
          if (phone) save.layoutSizingHorizontal = "FILL";
          T.num(save, "minHeight", "tap");
          T.add(save, T.text("Not saved yet", "text-xs/body", "ink-3", { name: "Not saved yet" }));
          if (phone) {
            const link = T.build(T.fr("Save this", "H", { cross: "CENTER", pad: [0, "space-1"] }, [T.tx("Save this", "text-sm/body semibold", "green", { name: "Label", deco: "UNDERLINE" })]), save);
            T.num(link, "minHeight", "touch-target");
          } else {
            const b = T.inst("Button", { Variant: "Quiet", State: "Default" }, { Label: "Save this" });
            b.name = "Save this";
            T.add(save, b);
          }
        },
      })),
    ),
    props: { bool: [{ name: "Not saved yet", default: true, layer: "Not saved yet" }] },
  });
  made.push("Step nav");

  // ---------- App header ----------
  await T.makeSet({
    name: "App header",
    lane: "forms",
    rows: "Size",
    cols: "Current",
    gap: 40,
    desc: "Wordmark, Law garden, the flow link (Start a check, or Your claim once there is progress), and the language switch. The current page is bold with a 2px green rule. On phones the nav wraps under the wordmark and the right side stays clear for Exit this page, which is fixed and not part of the header.",
    variants: ["Phone", "Desktop"].flatMap((size) =>
      ["Flow", "Law garden"].map((current) => ({
        props: { Current: current, Size: size },
        make: (c) => {
          const phone = size === "Phone";
          T.style(c, { layout: phone ? "V" : "H", align: phone ? "MIN" : "CENTER", gap: phone ? "space-1" : 0, pad: phone ? ["space-2", "gutter-phone"] : 0, stroke: { c: "line", sides: { b: 1 } } });
          c.resize(phone ? 390 : 1440, c.height);
          c.layoutSizingHorizontal = "FIXED";
          const holder = phone ? c : T.build(T.fr("Inner", "H", { gap: "space-6", cross: "CENTER", pad: ["space-2", 176, "space-2", "gutter-desktop"] }, []), c);
          if (!phone) {
            T.add(c, holder, { w: 1152 });
            T.num(holder, "minHeight", 64);
          }
          const wm = T.inst("Tend wordmark");
          wm.name = "Wordmark";
          T.add(holder, wm);
          const nav = T.build(T.fr("Nav", "H", { gap: phone ? "space-4" : "space-5", cross: "CENTER" }, []), holder);
          if (phone) nav.layoutSizingHorizontal = "FILL";
          const link = (label, on, name) => {
            const l = T.build(T.fr(name, "H", { cross: "CENTER", stroke: on ? { c: "green", w: 2, sides: { b: 2 } } : undefined }, [T.tx(label, on ? "text-sm/body bold" : "text-sm/body", on ? "ink" : "ink-2", { name: "Label" })]), nav);
            T.num(l, "minHeight", "touch-target");
            return l;
          };
          link("Law garden", current === "Law garden", "Law garden");
          link("Your claim", current === "Flow", "Flow link");
          if (phone) T.add(nav, T.frame({ name: "Spacer" }), { w: "FILL", h: 1 }).fills = [];
          const lang = T.build(T.fr("Language", "H", { cross: "CENTER", pad: [0, "space-3"], radius: "radius-btn", stroke: { c: "line-strong" } }, [T.tx("Español", "text-sm/body semibold", "ink", { name: "Label" })]), nav);
          T.num(lang, "minHeight", "touch-target");
        },
      })),
    ),
  });
  // Text properties: every variant shares these words, so they can be wired safely.
  const header = T.comps["App header"];
  const kFlow = header.addComponentProperty("Flow link", "TEXT", "Your claim");
  const kLang = header.addComponentProperty("Language", "TEXT", "Español");
  for (const v of header.children) {
    v.findOne((n) => n.name === "Flow link").findOne((n) => n.type === "TEXT").componentPropertyReferences = { characters: kFlow };
    v.findOne((n) => n.name === "Language").findOne((n) => n.type === "TEXT").componentPropertyReferences = { characters: kLang };
  }
  made.push("App header");

  // ---------- Site footer ----------
  const HELP = "If you are in danger, call 911. To talk with someone now, call the National Sexual Assault Hotline, any time: 800-656-4673.";
  await T.makeSet({
    name: "Site footer",
    lane: "forms",
    cols: "Size",
    base: { layout: "H", align: "CENTER", fill: "paper-sunk", stroke: { c: "line", sides: { t: 1 } } },
    desc: "The hotline first, in bold, on every page. Then the plain demo note and where the law math ran. 96px above it on every page.",
    variants: ["Phone", "Desktop"].map((size) => ({
      props: { Size: size },
      make: (c) => {
        const phone = size === "Phone";
        c.resize(phone ? 390 : 1440, c.height);
        c.layoutSizingHorizontal = "FIXED";
        const inner = T.build(
          T.fr("Inner", "V", { gap: "space-3", pad: ["space-6", phone ? "gutter-phone" : "gutter-desktop", "space-7"] }, [
            T.tx(HELP, "text-md/body bold", "ink", { name: "Help", w: "FILL", ranges: [{ find: "800-656-4673", color: "green", deco: "UNDERLINE" }] }),
            T.tx(
              "Demo data is fictional. The demo bank is Capital One's Nessie, a mock bank, so no real money moves. Tend is not legal advice. The program decides every claim.",
              "text-xs/body",
              "ink-3",
              { name: "Demo note", w: "FILL" },
            ),
            T.tx("Law math: on this device (WebAssembly)", "text-xs/body", "ink-3", { name: "Engine", w: "FILL" }),
          ]),
          c,
        );
        if (phone) inner.layoutSizingHorizontal = "FILL";
        else T.add(c, inner, { w: 1152 });
        for (const t of inner.findAll((n) => n.type === "TEXT")) t.layoutSizingHorizontal = "FILL";
        if (!phone) for (const t of inner.findAll((n) => n.type === "TEXT")) try { T.num(t, "maxWidth", 760); } catch (e) {}
      },
    })),
  });
  made.push("Site footer");

  await T.refresh();
  return { made };
})()
