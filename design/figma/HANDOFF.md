# Figma file handoff (for Codex)

Goal: win Figma's "Best Design" prize at MHacks 2026 (1st place is a LEGO set). Judges look at the
Figma file and the live app. The bar is a file a Figma designer would respect: real components with
variants and properties, auto layout everywhere, variables bound to fills and strokes with Light and
Dark modes, text styles, a clickable prototype, meaningful layer names, organized pages. No
screenshots pasted in as the design.

## The file

- URL: https://www.figma.com/design/kPZUqX0ptO138LzG1ah9hk (still named "Untitled"; rename it to
  "Tend: design system and survivor flow").
- Team: "Sanat Gupta's team", upgraded Oct 3 to the free Education plan. That allows more than one
  variable mode and more than 3 pages. Reload the file tab once so the plan applies.
- Link access is currently "anyone with the link can view". Leave sharing alone; Sanat decides.
  Do not publish to the Community, invite anyone, or create share links.

## How it is driven

- The persistent Chrome (CDP on 127.0.0.1:9222, profile ~/.claude-chrome-profile, signed in to
  Figma) has the file open. Never delete that profile.
- The Figma Plugin API is live in that tab as `window.figma` (createFrame, variables, text styles,
  components, reactions all work from page context).
- `node design/figma/run.mjs 21_forms.js [more.js ...]` runs generator scripts in that tab through
  CDP. It always runs `00_helpers.js` first, which defines `window.__tend` (fonts, variable and style
  registries, component lookup). Each script is an async IIFE that returns a summary.
- `node design/figma/shot.mjs "<page>" "<node name>" out.png [scale] [maxSide]` exports a node to
  PNG for a visual check. Look at every page this way and fix clipping, overflow, and overlaps.
- `plant_keys.mjs` reproduces the app's seeded plant shapes (web/components/Plant.tsx) so a plant
  drawn in Figma matches the one the app draws for the same key.

## Done (as of Oct 3, about 8:05 PM)

- Variables: "Tend color" (18 variables, Light mode only so far) and "Tend space" (19: space-1 to
  space-9, radii, 44 touch target, 48 button height). Names match web/DESIGN.md.
- 36 text styles (text-2xs ... text-display, body/serif/mono variants, card styles), effect styles
  shadow-sheet and shadow-sheet-side, grid styles grid/phone 390 and grid/desktop 1440.
- 9 pages created: Cover, Foundations, Components, Survivor flow / Phone, Survivor flow / Desktop,
  Espanol, Public, Dark mode, Accessibility.
- Components page: 35 documented sections, 24 component sets, 117 components (Tend mark and
  wordmark, Icon, Key cap, Status shape and Status tag, Button, Text link, Exit this page, Citation,
  Answer button, Checkbox, Radio, Choice card, Field/Select, Field/Date, Field/Text, Checkbox line,
  Confirm code, Notice, Content note, Privacy line, Step nav, App header, Site footer, Ledger bed
  header, Ledger line, Bill line, Law quote, Sheet contents for Law, Letter, Pay, Payment result,
  Privacy, and Sheet). Visual checks are in design/figma/shots/ (not committed).

## Left to do

1. Dark mode: add mode "Dark" to "Tend color", fill the dark values from web/DESIGN.md (they match
   web/app/globals.css), and confirm every fill and stroke is variable-bound so a frame flips by
   switching its mode.
2. Remaining components: Plant (Seed, Sprouting, Leafing, Budding, In bloom; line art in green with
   green-tint leaves on a 40 x 56 box, ground line at y 53), law-garden tile, Share card (1200 x 630).
3. Cover (1920 x 1080, paper and ink, not a gradient; set it as the file thumbnail) and Foundations
   (swatches bound to variables, contrast numbers from DESIGN.md, type specimen, spacing, grids).
4. Survivor flow / Phone (390 x 844, built from instances, real copy): start and privacy promise,
   Check questions, Check result for Michigan, Gather statement, Gather ledger, Bill with the $325
   hold and letter, Pay $118 with the 6-digit code, payment done, Packet, Share link for an advocate,
   Track garden, the Exit-this-page blank state, and an offline state.
5. Survivor flow / Desktop (1440): Check result, Bill hold, Packet, Track.
6. Espanol: 4 key phone screens from web/lib/i18n/es.ts.
7. Public: Michigan state page (phone and desktop), the national law garden (11 x 8 tile map), the
   Michigan share card.
8. Dark mode page: the same 4 phone screens with the Dark mode set on the frames.
9. Accessibility page: contrast table, focus states, 44px targets, reduced motion, status shapes that
   do not rely on color, quick exit behavior, plain-language rules.
10. Prototype: ON_CLICK -> NAVIGATE on the real buttons (primary buttons advance; Exit this page goes
    to the blank state), 320ms with the DESIGN.md easing, flow starting points "Survivor flow" and
    one for Espanol. Read the reactions back to verify.

## Sources of truth

- web/DESIGN.md (tokens, components, plants, voice), web/app/globals.css, web/components/**/*.module.css.
- Real screens and copy: web/components/flow/** and web/lib/i18n/en.ts, es.ts on main.
- Demo character is fictional: Rowan, Michigan, incident 2026-06-14, exam yes, police report no.
  Riverbend General bill $443.00; the $325.00 forensic exam line is held under MCL 18.355a(2);
  the payment is $118.00.

## Rules (Sanat's)

No em dashes or en dashes anywhere, straight quotes, no exclamation marks, no hype words. Copy
speaks to "you"; any amount that can be asked for carries "The program decides."; nothing asks what
happened. No gradients, glassmorphism, glows, emoji icons, sparkle glyphs, default indigo/violet,
Inter-only type, lorem ipsum, or placeholder "Button" labels. Paper, ink, green, and clay only.

Repo note: other agents are merging branches in this checkout. Work only in design/figma/, stage
only that path when you commit, and do not push without Sanat.
