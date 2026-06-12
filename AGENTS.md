# Agent Instructions

`see` is the Static App Share service: upload a static app, get a sandboxed,
shareable live-preview link. Bun runtime + React/Vite/Tailwind/shadcn client.

Before changing behavior, read `docs/static-app-share-service-spec.md` — it is the
product source of truth (API surface, storage model, two-origin security model).
For anything visual, read [`design.md`](design.md) first (see **Design system** below).

## Design system

The app's visual identity is **Blueprint** — a drafting-console / spec-sheet voice:
hairline rules over drop-shadows, a monospace voice for machine data (dimensions,
byte sizes, retention, revisions, tokens, paths), and a single warm marigold-amber
accent doing all the signalling. It is locked in [`design.md`](design.md) at the repo
root.

- **Read `design.md` before any UI work.** It is the source of truth for genre, the
  warm-amber OKLCH theme, typography (Inter + a system mono stack), spacing, the
  `0.5rem` radius, motion, and CTA voice. This is a **system-managed project**: every
  surface shares the system — don't diverge per page. Amend `design.md` rather than
  overriding it locally.
- **Consume tokens by name** — `bg-primary`, `text-muted-foreground`, `font-mono`,
  `rounded-lg`, `var(--radius)`. The tokens are wired into shadcn's CSS variables in
  `src/client/styles.css`; a portable copy lives in `tokens.css`. Never inline raw
  OKLCH/hex in components. (Tailwind v4 note: reference CSS vars with the
  parenthesis/`var()` form, e.g. `rounded-lg`, not the bare-bracket `rounded-[--radius]`,
  which silently fails to compile.)
- **The one exception:** `src/generated-index.ts` is a standalone page served from the
  content origin with no Tailwind — it hardcodes the Blueprint values inline and must be
  kept in sync with `design.md` by hand.
- The **Hallmark** design skill reads `design.md` and defers to it; `.hallmark/log.json`
  records past design runs. Use Hallmark (alongside shadcn) for redesigns or new surfaces.

## Conventions

- **Runtime & package manager:** Bun (`bun@1.3.14`). Server uses `Bun.serve` and
  `bun:sqlite`. Keep dependencies minimal — this project is intentionally near-zero-dep.
- **Verify before claiming done:**
  ```bash
  bun run typecheck
  bun run build:client
  bun test
  ```
- **Client bundle cache key:** after changing the client, bump `ASSET_VERSION` in
  `src/pages.ts` so browsers don't serve stale `app.js` / `app.css`.
- **Security model is load-bearing:** uploaded content is untrusted. Keep it on the
  separate content origin and keep the viewer iframe sandbox without `allow-same-origin`.
  Don't loosen the viewer CSP.
- **Bundles:** an upload with a root `see.json` is a first-class *bundle* — the manifest
  declares capabilities, tweaks, inspect targets, and homepage/exposed/bar, and the content
  handler injects the first-party SDK into served HTML (the one sanctioned exception to "no
  script injection" — see the spec § Security Contract). The manifest projects onto the
  existing `WorkspaceSettings`; agent-facing schema lives in `src/docs/llms.txt`.

## Skills

This project ships a pinned **shadcn** skill (via `bunx skills`, tracked in `skills-lock.json`),
installed for both Claude Code and Codex. After a fresh clone, restore it with:

```bash
bunx skills experimental_install   # or: bunx skills add shadcn/ui --agent '*' -y
```

Use the shadcn skill for all UI/component work instead of hand-writing markup.

## shadcn/ui

- Use `bunx --bun shadcn@latest ...` for the shadcn CLI.
- Check component docs before adding or composing components.
- Prefer existing shadcn components over custom control markup.
- Keep viewer chrome subtle; the uploaded app is the primary UI.
