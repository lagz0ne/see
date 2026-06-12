# CLAUDE.md

Project guidance for Claude Code. The full agent instructions live in
[`AGENTS.md`](AGENTS.md) — read that first.

## Design system

The locked visual identity ("Blueprint") lives in [`design.md`](design.md) at the repo
root. **Read it before any UI work** — it is the source of truth for the warm-amber
theme, Inter + mono typography, spacing, radius, motion, and CTA voice. Tokens are wired
into shadcn variables in `src/client/styles.css` (portable copy in `tokens.css`); consume
them by name and never inline raw OKLCH/hex. This is a system-managed project — every
surface shares the system; amend `design.md` rather than overriding locally. See
`AGENTS.md` § Design system for the full rules.

## Skills

This project uses the **shadcn** skill (managed via `bunx skills`). Use it for any UI / component
work — adding, composing, styling, or debugging shadcn/ui components.

Restore skills after a fresh clone (sets up Claude Code + Codex):

```bash
bunx skills experimental_install   # or: bunx skills add shadcn/ui --agent '*' -y
```

When doing UI work, invoke the shadcn skill rather than hand-writing component markup, and check
component docs before composing. Keep the viewer chrome subtle — uploaded content is the primary UI.
