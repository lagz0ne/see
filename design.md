# Design — Static App Share ("Blueprint")

A locked design system for this app. Every surface — the React Upload console and
Viewer chrome, the server-rendered message pages, and the standalone generated
index — reads this file before emitting code. Do not regenerate per surface;
**extend or amend this file** when the system needs to grow.

The thesis: this is a developer utility for shipping and previewing static apps,
so it should read like a **drafting console / spec sheet**, not a marketing
landing page. Hairline rules instead of drop-shadows. A monospace voice for every
piece of machine data (dimensions, byte sizes, retention, revisions, tokens, file
paths). Tabular numerals. One warm accent doing all the signalling.

## Genre

modern-minimal (developer utility). Function carries the page. No marketing
nav/footer archetypes — the app has a brand mark and a tool, nothing to scroll.

## Macrostructure family

Pages share shape by type; they vary only in archetype, never in theme.

- **App pages** — *Workbench*. The Upload page is a focused console (spec-sheet
  header strip + ruled form sections). The Viewer is a thin control rail above a
  device stage. App pages MUST NOT use hero enrichment — the tool is the page.
- **Message pages** — *Plain Block*. Expired / 404 / error / generated-index are a
  single left-aligned, hairline-ruled block with a mono eyebrow. No centered
  drop-shadow card.

## Theme — warm amber on neutral

Grounded in the original neutral OKLCH base; one new accent (marigold amber)
carries every signal. Light and dark are both first-class (the Viewer toggles
`.dark` on `<html>`).

### Light
- `--color-paper`      oklch(0.994 0 0)   — page background
- `--color-paper-2`    oklch(0.975 0 0)   — muted surface / inset
- `--color-paper-3`    oklch(0.955 0 0)   — hover / pressed surface
- `--color-card`       oklch(1 0 0)        — raised surface (hairline, not shadow)
- `--color-ink`        oklch(0.18 0 0)     — primary text
- `--color-ink-2`      oklch(0.50 0 0)     — muted text / mono metadata
- `--color-rule`       oklch(0.90 0 0)     — hairline borders
- `--color-accent`     oklch(0.72 0.155 62) — marigold amber (fills, active)
- `--color-accent-ink` oklch(0.24 0.05 62)  — warm near-black text on amber fills
- `--color-focus`      oklch(0.58 0.16 55)  — deeper amber, ≥3:1 ring on paper

### Dark
- `--color-paper`      oklch(0.165 0 0)
- `--color-paper-2`    oklch(0.205 0 0)
- `--color-paper-3`    oklch(0.255 0 0)
- `--color-card`       oklch(0.205 0 0)
- `--color-ink`        oklch(0.97 0 0)
- `--color-ink-2`      oklch(0.68 0 0)
- `--color-rule`       oklch(1 0 0 / 12%)
- `--color-accent`     oklch(0.76 0.15 65)
- `--color-accent-ink` oklch(0.20 0.05 62)
- `--color-focus`      oklch(0.72 0.15 62)

Accent budget: ≤ ~8% of any viewport. The accent is the primary button, the
active toggle, the focus ring, the brand tile, the drop-zone "armed" state, and
the safe-area guide. Everything else is neutral + hairline.

## Typography

2 + 1 discipline, all system stacks — **no web-font dependency added**.

- **Display & Body** — Inter (`Inter, ui-sans-serif, system-ui, -apple-system,
  "Segoe UI", sans-serif`). Hierarchy comes from weight + tracking, not a second
  display face. Headings: 600–700, tracking `-0.02em`. Body: 400–500.
- **Mono** — `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, "Liberation Mono",
  monospace`. Used for ALL machine data: device dimensions, byte sizes, retention
  windows, revision numbers, edit tokens, file paths, viewer URLs, percentages.
  Mono eyebrows are uppercase, tracking `0.12em`, `--color-ink-2`.
- **Type scale anchor**: page H1 `clamp(2rem, 4vw, 2.75rem)`, weight 700.

## Spacing

4-point named scale (in `tokens.css`). Surfaces use named tokens, never raw
values. Generous whitespace; let the ruled sections breathe.

## Radius

`--radius: 0.5rem` (tightened from 0.625rem — crisper, more drafting-table).
Pills (badges) stay fully rounded; the device-frame bezel keeps its own large
radius.

## Motion

- Easings: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-in-out`.
  Never the browser default `ease`; never bounce/overshoot on UI state.
- Durations: hover/active 150–220ms.
- Reveal pattern: **none** — no scroll reveals. State changes only.
- Reduced-motion: spatial motion collapses to ≤150ms opacity crossfade.

## Microinteractions stance

- Silent success (no celebratory toasts). Copy buttons flip label to "Copied"
  inline for ~1.2s, then reset.
- `:focus-visible` ring shows instantly (never animated), ≥3:1 contrast.
- Hover tooltips delay ~600–800ms; focus tooltips 0ms.
- Optimistic resource add/delete over confirmation dialogs.

## CTA voice

- **Primary** — amber fill, warm-near-black text, weight 600, radius `--radius`.
  Verb-led ("Upload & get link", "Add or replace").
- **Secondary** — neutral surface or hairline-outline, ink text.
- **Icon controls** (Viewer rail) — ghost/outline square buttons, tooltip-labelled.

## Per-surface allowances

- App pages (Upload, Viewer): no enrichment, no illustration. Function carries it.
- Message pages: typography only.
- The Viewer chrome MUST stay subtle — uploaded content is the primary UI. The
  rail is one hairline-bordered row; never let it compete with the stage.

## What every surface MUST share

- The brand mark: an amber tile (radius `--radius`) holding a Lucide glyph, beside
  a mono uppercase "STATIC APP SHARE" eyebrow.
- The accent hue and its placement budget (≤ ~8% per viewport).
- Inter (display+body) + the mono stack for machine data.
- The CTA voice (amber fill, warm-ink text, radius `--radius`).
- Hairline rules over drop-shadows; tabular-nums on all figures.

## What surfaces MAY differ on

- Macrostructure within the family (Workbench for app, Plain Block for messages).
- Density (the Viewer rail is compact; the Upload console is roomy).

## Exports

Drop-in formats for re-using this design system. Light-mode values shown; the
dark overrides live in `tokens.css` / `styles.css` under `.dark`.

### tokens.css
```css
:root {
  --color-paper:      oklch(0.994 0 0);
  --color-paper-2:    oklch(0.975 0 0);
  --color-paper-3:    oklch(0.955 0 0);
  --color-card:       oklch(1 0 0);
  --color-ink:        oklch(0.18 0 0);
  --color-ink-2:      oklch(0.50 0 0);
  --color-rule:       oklch(0.90 0 0);
  --color-accent:     oklch(0.72 0.155 62);
  --color-accent-ink: oklch(0.24 0.05 62);
  --color-focus:      oklch(0.58 0.16 55);

  --font-display: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-body:    Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono:    ui-monospace, "SF Mono", "JetBrains Mono", Menlo, "Liberation Mono", monospace;

  --space-3xs: 0.25rem;  --space-2xs: 0.5rem;  --space-xs: 0.75rem;
  --space-sm:  1rem;     --space-md:  1.5rem;  --space-lg: 2rem;
  --space-xl:  3rem;     --space-2xl: 4.5rem;  --space-3xl: 7rem;

  --text-xs: 0.75rem;  --text-sm: 0.875rem; --text-md: 1.125rem;
  --text-lg: 1.375rem; --text-xl: 1.75rem;  --text-2xl: 2.25rem;

  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-short:   180ms;
  --radius:      0.5rem;
}
```

### Tailwind v4 `@theme`
```css
@theme {
  --color-paper:   oklch(0.994 0 0);
  --color-ink:     oklch(0.18 0 0);
  --color-accent:  oklch(0.72 0.155 62);
  --font-sans:     Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono:     ui-monospace, "SF Mono", "JetBrains Mono", Menlo, "Liberation Mono", monospace;
  --spacing-md:    1.5rem;
  --text-md:       1.125rem;
  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG `tokens.json`
```json
{
  "color": {
    "paper":  { "$value": "oklch(0.994 0 0)", "$type": "color" },
    "ink":    { "$value": "oklch(0.18 0 0)", "$type": "color" },
    "accent": { "$value": "oklch(0.72 0.155 62)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Inter", "$type": "fontFamily" },
    "mono":    { "$value": "ui-monospace, SF Mono, JetBrains Mono, Menlo", "$type": "fontFamily" }
  },
  "space": {
    "md": { "$value": "1.5rem", "$type": "dimension" }
  }
}
```

### shadcn/ui CSS variables
```css
:root {
  --background:         oklch(0.994 0 0);    /* paper */
  --foreground:         oklch(0.18 0 0);     /* ink */
  --primary:            oklch(0.72 0.155 62);/* accent */
  --primary-foreground: oklch(0.24 0.05 62); /* accent-ink */
  --muted:              oklch(0.975 0 0);    /* paper-2 */
  --muted-foreground:   oklch(0.50 0 0);     /* ink-2 */
  --border:             oklch(0.90 0 0);     /* rule */
  --input:              oklch(0.90 0 0);     /* rule */
  --ring:               oklch(0.58 0.16 55); /* focus */
  --radius:             0.5rem;
}
```
