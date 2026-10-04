// Shared helpers for the Tend Figma generator. Defines window.__tend (T) and refreshes its registries.
// Every later script assumes this ran first in the same tab (run.mjs runs it automatically).
(async () => {
  const T = (window.__tend = window.__tend || {});
  const F = (T.F = {
    serif: "Source Serif 4",
    sans: "Atkinson Hyperlegible Next",
    mono: "Atkinson Hyperlegible Mono",
  });

  if (figma.loadAllPagesAsync) await figma.loadAllPagesAsync();

  const fonts = [
    [F.serif, "Regular"],
    [F.serif, "Medium"],
    [F.serif, "SemiBold"],
    [F.serif, "Bold"],
    [F.serif, "Italic"],
    [F.sans, "Regular"],
    [F.sans, "Medium"],
    [F.sans, "SemiBold"],
    [F.sans, "Bold"],
    [F.sans, "Italic"],
    [F.mono, "Regular"],
    [F.mono, "SemiBold"],
    [F.mono, "Bold"],
    ["Inter", "Regular"],
  ];
  await Promise.all(fonts.map(([family, style]) => figma.loadFontAsync({ family, style })));

  // ---------- registries ----------
  T.refresh = async () => {
    T.colls = {};
    T.v = {};
    for (const c of await figma.variables.getLocalVariableCollectionsAsync()) T.colls[c.name] = c;
    for (const v of await figma.variables.getLocalVariablesAsync()) T.v[v.name] = v;
    T.ts = {};
    for (const s of await figma.getLocalTextStylesAsync()) T.ts[s.name] = s;
    T.es = {};
    for (const s of await figma.getLocalEffectStylesAsync()) T.es[s.name] = s;
    T.gs = {};
    for (const s of await figma.getLocalGridStylesAsync()) T.gs[s.name] = s;
    T.comps = {};
    for (const p of figma.root.children) {
      if (p.name !== "Components") continue;
      for (const n of p.findAll((n) => n.type === "COMPONENT_SET" || (n.type === "COMPONENT" && n.parent.type !== "COMPONENT_SET")))
        T.comps[n.name] = n;
    }
  };
  await T.refresh();

  T.page = (name) => figma.root.children.find((p) => p.name === name);

  // ---------- color ----------
  T.hex = (h) => {
    const s = h.replace("#", "");
    return { r: parseInt(s.slice(0, 2), 16) / 255, g: parseInt(s.slice(2, 4), 16) / 255, b: parseInt(s.slice(4, 6), 16) / 255 };
  };
  T.toHex = (c) =>
    "#" + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  T.solid = (hex, opacity = 1) => ({ type: "SOLID", color: T.hex(hex), opacity });
  T.paint = (name, opacity = 1) => {
    const v = T.v[name];
    if (!v) throw new Error("no color variable " + name);
    return figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity }, "color", v);
  };
  T.fill = (node, name, opacity) => {
    node.fills = name ? [T.paint(name, opacity ?? 1)] : [];
  };
  // sides: {t,r,b,l} weights for one-sided rules (a 1.5px ink rule on top, a clay bar on the left)
  T.stroke = (node, name, weight = 1, align = "INSIDE", sides, dash) => {
    node.strokes = name ? [T.paint(name)] : [];
    node.strokeAlign = align;
    if (sides) {
      node.strokeTopWeight = sides.t ?? 0;
      node.strokeRightWeight = sides.r ?? 0;
      node.strokeBottomWeight = sides.b ?? 0;
      node.strokeLeftWeight = sides.l ?? 0;
    } else node.strokeWeight = weight;
    if (dash) node.dashPattern = dash;
  };

  // ---------- numbers bound to "Tend space" ----------
  T.val = (v) => v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  T.num = (node, field, val) => {
    if (val == null) return;
    if (typeof val === "string") {
      const v = T.v[val];
      if (!v) throw new Error("no number variable " + val);
      node[field] = T.val(v);
      node.setBoundVariable(field, v);
    } else node[field] = val;
  };
  T.radius = (node, r) => {
    if (Array.isArray(r)) {
      const f = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
      r.forEach((x, i) => T.num(node, f[i], x));
    } else if (typeof r === "string") {
      for (const f of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) T.num(node, f, r);
    } else node.cornerRadius = r;
  };
  T.pads = (p) => {
    if (p == null) return [0, 0, 0, 0];
    if (!Array.isArray(p)) return [p, p, p, p];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 3) return [p[0], p[1], p[2], p[1]];
    return p;
  };

  // ---------- frames ----------
  T.style = (f, s) => {
    if (s.layout && s.layout !== "NONE") {
      f.layoutMode = s.layout === "H" ? "HORIZONTAL" : s.layout === "V" ? "VERTICAL" : s.layout;
      f.primaryAxisSizingMode = "AUTO";
      f.counterAxisSizingMode = "AUTO";
      if (s.wrap) f.layoutWrap = "WRAP";
      T.num(f, "itemSpacing", s.gap ?? 0);
      if (s.wrap) T.num(f, "counterAxisSpacing", s.rowGap ?? s.gap ?? 0);
      const p = T.pads(s.pad);
      T.num(f, "paddingTop", p[0]);
      T.num(f, "paddingRight", p[1]);
      T.num(f, "paddingBottom", p[2]);
      T.num(f, "paddingLeft", p[3]);
      if (s.align) f.primaryAxisAlignItems = s.align;
      if (s.cross) f.counterAxisAlignItems = s.cross;
      if (s.textBaseline) f.counterAxisAlignItems = "BASELINE";
    }
    if ("fill" in s) T.fill(f, s.fill, s.fillOpacity);
    if (s.stroke) T.stroke(f, s.stroke.c, s.stroke.w ?? 1, s.stroke.align ?? "INSIDE", s.stroke.sides, s.stroke.dash);
    if (s.radius != null) T.radius(f, s.radius);
    if (s.opacity != null) f.opacity = s.opacity;
    if (s.effect) f.effectStyleId = T.es[s.effect].id;
    if (s.clip != null) f.clipsContent = s.clip;
  };
  T.frame = (s = {}) => {
    const f = figma.createFrame();
    f.name = s.name || "Frame";
    f.fills = [];
    f.clipsContent = false;
    T.style(f, s);
    return f;
  };

  // Append and size. w/h: number (fixed), "FILL", or "HUG".
  T.add = (parent, node, s = {}) => {
    parent.appendChild(node);
    const auto = parent.type !== "PAGE" && parent.type !== "SECTION" && parent.layoutMode && parent.layoutMode !== "NONE";
    if (s.abs && auto) node.layoutPositioning = "ABSOLUTE";
    if (s.abs) {
      node.x = s.abs.x;
      node.y = s.abs.y;
      if (s.abs.c) node.constraints = s.abs.c;
    }
    if (s.at) {
      node.x = s.at[0];
      node.y = s.at[1];
    }
    const sizable = "layoutSizingHorizontal" in node;
    if (s.w === "FILL") node.layoutSizingHorizontal = "FILL";
    else if (typeof s.w === "number") {
      node.resize(s.w, Math.max(0.01, node.height));
      if (sizable && (auto || node.layoutMode)) node.layoutSizingHorizontal = "FIXED";
    } else if (s.w === "HUG" && sizable) node.layoutSizingHorizontal = "HUG";
    if (s.h === "FILL") node.layoutSizingVertical = "FILL";
    else if (typeof s.h === "number") {
      node.resize(node.width, s.h);
      if (sizable && (auto || node.layoutMode)) node.layoutSizingVertical = "FIXED";
    } else if (s.h === "HUG" && sizable) node.layoutSizingVertical = "HUG";
    if (s.minW != null) T.num(node, "minWidth", s.minW);
    if (s.maxW != null) T.num(node, "maxWidth", s.maxW);
    if (s.minH != null) T.num(node, "minHeight", s.minH);
    if (s.grow) node.layoutGrow = 1;
    if (s.selfAlign) node.layoutAlign = s.selfAlign;
    return node;
  };

  // ---------- text ----------
  T.text = (chars, style, color, s = {}) => {
    const t = figma.createText();
    const st = T.ts[style];
    if (!st) throw new Error("no text style " + style);
    t.fontName = st.fontName;
    t.textStyleId = st.id;
    t.characters = chars;
    if (color) t.fills = [T.paint(color)];
    t.name = s.name || chars.slice(0, 48);
    t.textAutoResize = "WIDTH_AND_HEIGHT";
    if (s.align) t.textAlignHorizontal = s.align;
    if (s.deco) t.textDecoration = s.deco;
    if (s.deco === "UNDERLINE" && t.setRangeTextDecorationOffset) {
      try {
        t.setRangeTextDecorationOffset(0, chars.length, { value: 20, unit: "PERCENT" });
        t.setRangeTextDecorationThickness(0, chars.length, { value: 1, unit: "PIXELS" });
      } catch (e) {}
    }
    if (s.ranges)
      for (const r of s.ranges) {
        const a = r.start ?? chars.indexOf(r.find);
        if (a < 0) throw new Error("range not found: " + r.find);
        const b = r.end ?? a + (r.find ? r.find.length : 0);
        if (r.style) t.setRangeTextStyleId(a, b, T.ts[r.style].id);
        if (r.color) t.setRangeFills(a, b, [T.paint(r.color)]);
        if (r.deco) {
          t.setRangeTextDecoration(a, b, r.deco);
          if (r.deco === "UNDERLINE" && t.setRangeTextDecorationOffset) {
            try {
              t.setRangeTextDecorationOffset(a, b, { value: 20, unit: "PERCENT" });
              t.setRangeTextDecorationThickness(a, b, { value: 1, unit: "PIXELS" });
            } catch (e) {}
          }
        }
      }
    if (s.truncate) {
      t.textTruncation = "ENDING";
      if (s.maxLines) t.maxLines = s.maxLines;
    }
    return t;
  };

  T.decorate = (t, deco) => {
    t.textDecoration = deco;
    if (deco === "UNDERLINE" && t.setRangeTextDecorationOffset) {
      try {
        t.setRangeTextDecorationOffset(0, t.characters.length, { value: 20, unit: "PERCENT" });
        t.setRangeTextDecorationThickness(0, t.characters.length, { value: 1, unit: "PIXELS" });
      } catch (e) {}
    }
  };

  // ---------- components and instances ----------
  T.comp = (name) => {
    const c = T.comps[name];
    if (!c) throw new Error("no component " + name);
    return c;
  };
  T.variant = (name, variant = {}) => {
    const set = T.comp(name);
    if (set.type !== "COMPONENT_SET") return set;
    const want = Object.entries(variant);
    if (!want.length) return set.defaultVariant;
    const c = set.children.find((ch) => want.every(([k, v]) => ch.variantProperties && ch.variantProperties[k] === v));
    if (!c) throw new Error(`no variant ${name} ${JSON.stringify(variant)}`);
    return c;
  };
  T.setProps = (inst, props) => {
    if (!props) return;
    const defs = inst.componentProperties;
    const out = {};
    for (const [k, v] of Object.entries(props)) {
      const key = Object.keys(defs).find((d) => d === k || d.split("#")[0] === k);
      if (!key) throw new Error(`no property ${k} on ${inst.name}; has ${Object.keys(defs).join(", ")}`);
      out[key] = v;
    }
    if (Object.keys(out).length) inst.setProperties(out);
  };
  T.inst = (name, variant, props) => {
    const i = T.variant(name, variant).createInstance();
    T.setProps(i, props);
    return i;
  };
  // Change a text layer inside an instance by layer name (a plain override, kept on swaps by name).
  T.setText = (root, layerName, chars) => {
    const t = root.findOne((n) => n.type === "TEXT" && n.name === layerName);
    if (!t) throw new Error(`no text layer ${layerName} in ${root.name}`);
    t.characters = chars;
    return t;
  };
  T.nested = (inst, name) => {
    const n = inst.findOne((x) => x.type === "INSTANCE" && x.name === name);
    if (!n) throw new Error(`no nested instance ${name} in ${inst.name}`);
    return n;
  };

  // ---------- declarative builder ----------
  // { t: "frame" | "text" | "inst" | "rect" | "node", name, children, ...style, ...sizing }
  T.build = (s, parent) => {
    if (!s) return null;
    let n;
    if (s.t === "frame") n = T.frame(s);
    else if (s.t === "text") n = T.text(s.text, s.style, s.color, s);
    else if (s.t === "inst") {
      n = T.inst(s.comp, s.variant, s.props);
      if (s.name) n.name = s.name;
      if (s.texts) for (const [layer, chars] of Object.entries(s.texts)) T.setText(n, layer, chars);
    } else if (s.t === "rect") {
      n = figma.createRectangle();
      n.name = s.name || "Rectangle";
      n.resize(s.size ? s.size[0] : 10, s.size ? s.size[1] : 10);
      n.fills = [];
      T.style(n, s);
    } else if (s.t === "node") n = s.node;
    else throw new Error("unknown node type " + s.t);
    if (parent) T.add(parent, n, s);
    if (s.children) for (const c of s.children) T.build(c, n);
    if (s.after) s.after(n);
    if (s.scale) n.rescale(s.scale);
    return n;
  };

  // Shorthands used in specs.
  T.tx = (text, style, color, extra = {}) => ({ t: "text", text, style, color, ...extra });
  T.fr = (name, layout, extra = {}, children = []) => ({ t: "frame", name, layout, ...extra, children });

  // ---------- SVG import with sentinel colors mapped to variables ----------
  // map: { "#010101": { fill: "green" } | { stroke: "green" } | "green" }
  T.svg = (markup, map = {}) => {
    const root = figma.createNodeFromSvg(markup);
    const swap = (paints) =>
      paints.map((p) => {
        if (p.type !== "SOLID") return p;
        const m = map[T.toHex(p.color)];
        return m ? T.paint(m, p.opacity ?? 1) : p;
      });
    for (const n of root.findAll(() => true)) {
      if ("fills" in n && Array.isArray(n.fills) && n.fills.length) n.fills = swap(n.fills);
      if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) n.strokes = swap(n.strokes);
    }
    root.fills = [];
    return root;
  };

  // ---------- plants (lib/garden.ts, ported line for line) ----------
  const r1 = (n) => Math.round(n * 10) / 10;
  T.seeded = (key) => {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  T.VIEW = { w: 40, h: 56, ground: 53, cx: 20 };
  T.plantShape = (stage, growth, key) => {
    const VIEW = T.VIEW;
    const rand = T.seeded(key);
    const g = Math.max(0, Math.min(1, growth));
    const lean = (rand() - 0.5) * 5;
    const height = { seed: 0, sprout: 11 + 5 * g, leaf: 21 + 8 * g, bud: 27 + 6 * g, bloom: 30 + 6 * g }[stage];
    const x0 = VIEW.cx;
    const y0 = VIEW.ground;
    const x2 = x0 + lean;
    const y2 = y0 - height;
    const cx = x0 + lean * 0.15;
    const cy = y0 - height * 0.55;
    const at = (t) => ({
      x: (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x2,
      y: (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y2,
    });
    const count = { seed: 0, sprout: 0, leaf: 2 + Math.round(2 * g), bud: 4 + Math.round(g), bloom: 4 + Math.round(2 * g) }[stage];
    const leaves = [];
    for (let i = 0; i < count; i++) {
      const t = 0.16 + (i * 0.6) / Math.max(1, count - 1);
      const p = at(t);
      const side = i % 2 === 0 ? 1 : -1;
      leaves.push({
        x: r1(p.x),
        y: r1(p.y),
        side,
        angle: r1(-32 - (rand() - 0.5) * 14),
        length: r1(Math.max(6.5, 12.5 - i * 1.1 + (rand() - 0.5) * 1.6)),
      });
    }
    return {
      lean,
      stem: stage === "seed" ? null : `M${x0} ${y0} Q${r1(cx)} ${r1(cy)} ${r1(x2)} ${r1(y2)}`,
      top: { x: r1(x2), y: r1(y2) },
      leaves,
      cotyledons: stage === "sprout" || stage === "leaf",
      bud: stage === "bud",
      petals: stage === "bloom" ? (rand() < 0.5 ? 5 : 6) : 0,
    };
  };
  T.leafPath = (L) => {
    const W = L * 0.42;
    return `M0 0 C${r1(L * 0.25)} ${r1(-W)} ${r1(L * 0.7)} ${r1(-W)} ${r1(L)} 0 C${r1(L * 0.7)} ${r1(W * 0.75)} ${r1(L * 0.25)} ${r1(W * 0.75)} 0 0Z`;
  };
  // Sentinels: stroke green #010101, leaf fill #020202, petal fill #030303, seed #040404, ground #050505.
  // opts.weights scales strokes for the share card (thinner lines at large size).
  T.plantSvg = (stage, growth, key, opts = {}) => {
    const { w, h, ground, cx } = T.VIEW;
    const k = opts.weights ?? 1;
    const s = T.plantShape(stage, growth, key);
    const top = s.top;
    const parts = [];
    const showGround = opts.ground !== false || stage === "seed";
    if (showGround)
      parts.push(
        `<path id="Ground" d="M${cx - 11} ${ground + 0.5}H${cx + 11}" stroke="#050505" stroke-width="${1 * k}" stroke-linecap="round" fill="none"${stage === "seed" ? ' stroke-dasharray="2 2.4"' : ""}/>`,
      );
    if (stage === "seed")
      parts.push(
        `<ellipse id="Seed" cx="${cx}" cy="${ground - 2.6}" rx="3" ry="2" transform="rotate(-18 ${cx} ${ground - 2.6})" fill="#040404"/>`,
      );
    if (s.stem) parts.push(`<path id="Stem" d="${s.stem}" stroke="#010101" stroke-width="${1.7 * k}" stroke-linecap="round" fill="none"/>`);
    s.leaves.forEach((leaf, i) => {
      const tr = `translate(${leaf.x} ${leaf.y}) scale(${leaf.side} 1) rotate(${leaf.angle})`;
      parts.push(
        `<path id="Leaf ${i + 1}" d="${T.leafPath(leaf.length)}" transform="${tr}" fill="#020202" stroke="#010101" stroke-width="${1.15 * k}" stroke-linejoin="round"/>`,
      );
      parts.push(
        `<path id="Leaf ${i + 1} rib" d="M0.6 0Q${leaf.length * 0.5} ${-leaf.length * 0.06} ${leaf.length * 0.88} 0" transform="${tr}" fill="none" stroke="#010101" stroke-opacity="0.8" stroke-width="${0.7 * k}" stroke-linecap="round"/>`,
      );
    });
    if (s.cotyledons) {
      parts.push(
        `<path id="Seed leaf left" d="M${top.x} ${top.y}c-3-0.5-7.2-2.8-7.6-6.6c3.8-0.6 7.2 2 7.6 6.6z" fill="#020202" stroke="#010101" stroke-width="${1.15 * k}" stroke-linejoin="round"/>`,
      );
      parts.push(
        `<path id="Seed leaf right" d="M${top.x} ${top.y}c3-0.5 7.2-2.8 7.6-6.6c-3.8-0.6-7.2 2-7.6 6.6z" fill="#020202" stroke="#010101" stroke-width="${1.15 * k}" stroke-linejoin="round"/>`,
      );
    }
    if (s.bud) {
      parts.push(`<path id="Bud" d="M${top.x} ${top.y + 1}c-4-1.8-4.4-8.6 0-12.6c4.4 4 4 10.8 0 12.6z" fill="#010101"/>`);
      if (!opts.noSepal)
        parts.push(
          `<path id="Sepal" d="M${top.x} ${top.y + 1.2}c-2.6-0.2-4.6-1.8-5-4.2M${top.x} ${top.y + 1.2}c2.6-0.2 4.6-1.8 5-4.2" fill="none" stroke="#010101" stroke-width="${1.1 * k}" stroke-linecap="round"/>`,
        );
    }
    if (s.petals) {
      const tx = top.x;
      const ty = top.y - 5.4;
      for (let i = 0; i < s.petals; i++) {
        const rot = (360 / s.petals) * i + 12;
        parts.push(
          `<ellipse id="Petal ${i + 1}" cx="0" cy="-5.3" rx="3.2" ry="4.8" transform="translate(${tx} ${ty}) rotate(${rot})" fill="#030303" stroke="#010101" stroke-width="${1.1 * k}"/>`,
        );
      }
      parts.push(`<circle id="Heart" cx="${tx}" cy="${ty}" r="2.7" fill="#010101"/>`);
    }
    return { markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`, shape: s };
  };
  T.PLANT_MAP = { "#010101": "green", "#020202": "leaf-fill", "#030303": "petal-fill", "#040404": "ink-3", "#050505": "line-strong" };

  // ---------- highlighted quote (a <mark> per line, like the app) ----------
  // Greedy line breaking measured with real text nodes, so each line gets its own green-tint box.
  T.markLines = (quote, style, width) => {
    const probe = T.text("x", style, "ink");
    const words = quote.split(" ");
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? cur + " " + w : w;
      probe.characters = next;
      if (probe.width > width - 6 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    probe.remove();
    return lines;
  };

  T.find = (root, name) => root.findOne((n) => n.name === name);
  T.done = (extra = {}) => ({ ok: true, ...extra });

  // ---------- component documentation sections ----------
  // Lanes are columns on the Components page; each component gets a section stacked in its lane.
  T.LANES = { atoms: 0, forms: 2300, ledger: 5800, sheets: 7700, garden: 10400 };
  T.goto = async (pageName) => {
    const p = T.page(pageName);
    if (!p) throw new Error("no page " + pageName);
    await figma.setCurrentPageAsync(p);
    return p;
  };
  T.dropSection = (page, name) => {
    for (const n of page.children.filter((x) => x.type === "SECTION" && x.name === name)) n.remove();
  };
  T.laneY = (page, lane, except) => {
    const x0 = T.LANES[lane];
    let y = 0;
    for (const n of page.children)
      if (n !== except && n.type === "SECTION" && Math.abs(n.x - x0) < 1) y = Math.max(y, n.y + n.height + 120);
    return y;
  };
  // Restack every lane from the top, keeping the build order, 120px apart.
  T.compactLanes = () => {
    const page = T.page("Components");
    for (const x0 of Object.values(T.LANES)) {
      const secs = page.children.filter((n) => n.type === "SECTION" && Math.abs(n.x - x0) < 1).sort((a, b) => a.y - b.y);
      let y = 0;
      for (const s of secs) {
        s.y = y;
        y += s.height + 120;
      }
    }
  };
  // A section holding a title, a description, and the component (set) below them.
  T.docSection = (page, name, lane, desc, node, extra = []) => {
    T.dropSection(page, name);
    const sec = figma.createSection();
    sec.name = name;
    page.appendChild(sec);
    sec.fills = [T.paint("paper-sunk")];
    const head = T.build(
      T.fr("About " + name, "V", { gap: "space-2" }, [
        T.tx(name, "text-2xl/desktop serif", "ink", { name: "Title" }),
        T.tx(desc, "text-sm/body", "ink-2", { name: "Description", w: 760 }),
        ...extra,
      ]),
      sec,
    );
    head.x = 48;
    head.y = 48;
    sec.appendChild(node);
    node.x = 48;
    node.y = head.y + head.height + 32;
    const w = Math.max(head.width, node.width) + 96;
    const h = node.y + node.height + 56;
    sec.resizeWithoutConstraints(Math.max(w, 900), h);
    sec.y = T.laneY(page, lane, sec);
    sec.x = T.LANES[lane];
    return sec;
  };

  // Variants in a grid: one row per value of `rows`, one column per value of `cols`.
  T.gridVariants = (set, rows, cols, gap = 32, pad = 40) => {
    const kids = set.children;
    const key = (k, p) => (p ? k.variantProperties[p] : "_");
    const rowVals = [...new Set(kids.map((k) => key(k, rows)))];
    const colVals = [...new Set(kids.map((k) => key(k, cols)))];
    const colW = colVals.map((cv) => Math.max(...kids.filter((k) => key(k, cols) === cv).map((k) => k.width)));
    const rowH = rowVals.map((rv) => Math.max(...kids.filter((k) => key(k, rows) === rv).map((k) => k.height)));
    for (const k of kids) {
      const ri = rowVals.indexOf(key(k, rows));
      const ci = colVals.indexOf(key(k, cols));
      k.x = pad + colW.slice(0, ci).reduce((a, b) => a + b + gap, 0);
      k.y = pad + rowH.slice(0, ri).reduce((a, b) => a + b + gap, 0);
    }
    const W = pad * 2 + colW.reduce((a, b) => a + b, 0) + gap * (colW.length - 1);
    const H = pad * 2 + rowH.reduce((a, b) => a + b, 0) + gap * (rowH.length - 1);
    set.resizeWithoutConstraints(W, H);
  };

  // Text, boolean, and instance-swap properties wired to layers by name in every variant.
  T.wireProps = (owner, props = {}) => {
    const comps = owner.type === "COMPONENT_SET" ? owner.children : [owner];
    for (const p of props.text || []) {
      const k = owner.addComponentProperty(p.name, "TEXT", p.default);
      for (const c of comps)
        for (const n of c.findAll((x) => x.type === "TEXT" && x.name === (p.layer || p.name))) {
          // Binding characters resets text decoration, so keep underlines and strikes.
          const deco = n.textDecoration;
          n.componentPropertyReferences = { ...(n.componentPropertyReferences || {}), characters: k };
          if (deco && deco !== figma.mixed && deco !== "NONE") T.decorate(n, deco);
        }
    }
    for (const p of props.bool || []) {
      const k = owner.addComponentProperty(p.name, "BOOLEAN", p.default);
      for (const c of comps)
        for (const n of c.findAll((x) => x.name === (p.layer || p.name)))
          n.componentPropertyReferences = { ...(n.componentPropertyReferences || {}), visible: k };
    }
    for (const p of props.swap || []) {
      const k = owner.addComponentProperty(p.name, "INSTANCE_SWAP", p.default, {
        preferredValues: (p.preferred || []).map((c) => ({ type: c.type === "COMPONENT_SET" ? "COMPONENT_SET" : "COMPONENT", key: c.key })),
      });
      for (const c of comps)
        for (const n of c.findAll((x) => x.type === "INSTANCE" && x.name === (p.layer || p.name)))
          n.componentPropertyReferences = { ...(n.componentPropertyReferences || {}), mainComponent: k };
    }
  };

  // Build a component set. variants: [{ props: {Variant: "Primary"}, make(c) }]
  T.makeSet = async (o) => {
    const page = await T.goto("Components");
    const comps = [];
    for (const v of o.variants) {
      const c = figma.createComponent();
      c.name = Object.entries(v.props)
        .map(([k, val]) => `${k}=${val}`)
        .join(", ");
      c.fills = [];
      c.clipsContent = false;
      T.style(c, o.base || {});
      v.make(c);
      if (o.after) o.after(c, v.props);
      comps.push(c);
    }
    const set = figma.combineAsVariants(comps, page);
    set.name = o.name;
    set.fills = [T.paint("paper")];
    T.stroke(set, "line-strong", 1, "INSIDE", null, [4, 4]);
    set.cornerRadius = 8;
    T.gridVariants(set, o.rows, o.cols, o.gap ?? 32, o.pad ?? 40);
    T.wireProps(set, o.props);
    set.description = o.desc;
    if (o.note) set.annotations = [{ labelMarkdown: o.note }];
    T.docSection(page, o.name, o.lane, o.doc || o.desc, set, o.docExtra || []);
    T.comps[o.name] = set;
    return set;
  };
  T.makeComp = async (o) => {
    const page = await T.goto("Components");
    const c = figma.createComponent();
    c.name = o.name;
    c.fills = [];
    c.clipsContent = false;
    T.style(c, o.base || {});
    o.make(c);
    T.wireProps(c, o.props);
    c.description = o.desc;
    if (o.note) c.annotations = [{ labelMarkdown: o.note }];
    // a plain backdrop so the component reads on the section
    const holder = c;
    T.docSection(page, o.name, o.lane, o.doc || o.desc, holder, o.docExtra || []);
    T.comps[o.name] = c;
    return c;
  };
  // Focus ring: 3px, 2px outside the edge (outline-offset), drawn as a stretched rectangle.
  T.focusRing = (parent, color = "green", offset = 2, baseRadius = 6) => {
    const r = figma.createRectangle();
    r.name = "Focus ring";
    parent.appendChild(r);
    if (parent.layoutMode && parent.layoutMode !== "NONE") r.layoutPositioning = "ABSOLUTE";
    const o = offset + 3;
    r.x = -o;
    r.y = -o;
    r.resize(parent.width + o * 2, parent.height + o * 2);
    r.fills = [];
    T.stroke(r, color, 3, "INSIDE");
    r.cornerRadius = baseRadius + o;
    r.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };
    return r;
  };
  return {
    vars: Object.keys(T.v).length,
    textStyles: Object.keys(T.ts).length,
    comps: Object.keys(T.comps).length,
    pages: figma.root.children.map((p) => p.name),
  };
})()
