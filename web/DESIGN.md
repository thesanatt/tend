# Tend design system

The people using Tend may be in a hard moment. The interface stays calm, plain, and fast: paper and
ink, one deep green for action and growth, and a muted clay that appears only on held bills. Motion
marks a change of state and nothing else. Every token below lives in `app/globals.css`; build the
Figma styles with the same names.

## Color

| Token           | Light     | Dark      | Use                                                    |
| --------------- | --------- | --------- | ------------------------------------------------------ |
| `paper`         | `#F6F2E9` | `#141412` | Page background                                        |
| `paper-raised`  | `#FBF8F2` | `#1C1C19` | Sheets, the bill, summary panels                       |
| `paper-sunk`    | `#ECE6DA` | `#22221E` | Footer, code listings, scripts to read aloud           |
| `ink`           | `#1C1B18` | `#ECE7DC` | Body text, ledger rules, Exit this page button         |
| `ink-2`         | `#4A463E` | `#BEB8AB` | Secondary text                                         |
| `ink-3`         | `#6A655B` | `#989284` | Meta text, not-counted amounts                         |
| `line`          | `#D8D1C3` | `#36352F` | Hairlines                                              |
| `line-strong`   | `#857E70` | `#77726A` | Form field borders (3:1 against paper)                 |
| `green`         | `#1F5136` | `#8CC4A0` | Primary action, links, eligible, every plant           |
| `green-strong`  | `#163D28` | `#A9D6B8` | Primary hover                                          |
| `green-tint`    | `#E2EADF` | `#1D2C22` | Quote highlight, selected answer, leaf fill            |
| `clay`          | `#9B4E33` | `#DA9677` | Held bills only                                        |
| `clay-tint`     | `#F2E2D8` | `#36241C` | Held bill row background                               |

Contrast, light theme, against `paper`: ink 15.4, ink-2 8.4, ink-3 5.2, green 8.2, clay 5.3.
Dark theme: ink 15.0, ink-2 9.3, ink-3 6.0, green 9.2, clay 7.6. Every text pair passes WCAG AA.
Status never relies on color alone: each status tag has its own shape and a word.

## Type

Three families, all self-hosted through `next/font` (the browser never calls Google):

- **Source Serif 4** (variable, optical sizes): headings, big totals, quoted law.
- **Atkinson Hyperlegible Next** (the 2025 revision of Atkinson Hyperlegible): all body and UI text.
- **Atkinson Hyperlegible Mono**: ledger amounts, dates, codes, the compiled law listing, so columns line up.

| Token          | Size                      | Line height | Use                                 |
| -------------- | ------------------------- | ----------- | ----------------------------------- |
| `text-xs`      | 14px                      | 1.45        | Meta, tags, captions                |
| `text-sm`      | 16px                      | 1.5         | Secondary UI, tables                |
| `text-md`      | 18px                      | 1.6         | Body (the base size)                |
| `text-lg`      | 21px                      | 1.5         | Lead paragraphs                     |
| `text-xl`      | 26px                      | 1.15        | Bed and section titles (serif)      |
| `text-2xl`     | 28 to 34px (fluid)        | 1.15        | Page sections (serif)               |
| `text-3xl`     | 36 to 52px (fluid)        | 1.06        | Page titles (serif, weight 560)     |
| `text-display` | 44 to 72px (fluid)        | 1.0         | The claim total (serif, weight 500) |

Prose amounts use the body face; amounts in tables and ledgers use the mono face.

## Space, shape, size

Spacing steps on a 4px base: `4, 8, 12, 16, 24, 32, 48, 64, 96` (`space-1` to `space-9`).
Radii: `4px` for fields and tags, `6px` for buttons, `8px` for panels. No drop shadows except on
sheets. Reading measure `40rem`; page width `72rem`; side gutter 16px on phones up to 40px.
Touch targets are at least 44px, buttons 48px.

## Motion

Durations `160ms`, `320ms`, `640ms`, easing `cubic-bezier(0.2, 0.7, 0.2, 1)`. Motion appears only when
something changes: a ledger line settles from a green tint when its status changes, a plant grows when
its stage rises, a sheet slides in when opened. Nothing animates on page load. Under
`prefers-reduced-motion: reduce` every animation and transition is cut to zero.

## Components

- **Buttons.** Primary: green fill, paper text. Secondary: green outline. Quiet: ink-3 outline.
- **Exit this page.** Ink fill, fixed top right on every screen, repeated inside every sheet. Esc
  twice does the same. It blanks the page, clears the tab's storage, and replaces the history entry.
- **Status tags.** Eligible: filled circle, green. Held: filled square, clay. Excluded: struck circle.
  Needs confirmation: dashed circle, ink. Not included: open circle, ink-3.
- **Citation.** The pinpoint (for example `MCL 18.355a(2)`) as an underlined button. It opens a sheet
  with the plain summary, the verbatim quote highlighted in `green-tint`, and a link that opens the
  official page scrolled to that sentence.
- **Ledger.** Beds per kind of cost, each under a 1.5px ink rule. Line grid: date (mono), description
  with tag and citation, amount right aligned. Held lines get a clay bar and clay tint.
- **Sheet.** Bottom sheet on phones, 540px side panel from 900px up. Native `dialog`.
- **Content note.** Ink bar on the left, plain statement, one button to continue.

## Plants

Line drawings in `green` with `green-tint` leaves on a 40 x 56 viewBox, ground line at y 53. Each plant
is seeded by its key, so a state or a cost always grows the same way.

- **Law garden** (one per state, on an 11 x 8 tile map of the country): seed (no verified rules),
  sprouting (1 to 14 rules), leafing (15 to 24), budding (25 to 34), in bloom (35 or more).
- **Your garden** (one per cost that can bring money back): sprout when you confirm it, leaf when a
  receipt is attached, bud when the claim is filed, bloom when the program pays. Height follows the
  amount on a log scale. Held bills never grow a plant; they show as a clay note.

## Voice

First person plural is avoided; Tend speaks to "you". Short sentences, no hype words, no em dashes,
no exclamation marks. Every amount that can be asked for carries "The program decides." Nothing asks
what happened.
