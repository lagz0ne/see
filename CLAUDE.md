# CLAUDE.md

Project guidance for Claude Code. The full agent instructions live in
[`AGENTS.md`](AGENTS.md) — read that first.

## Skills

This project uses the **shadcn** skill (managed via `bunx skills`). Use it for any UI / component
work — adding, composing, styling, or debugging shadcn/ui components.

Restore skills after a fresh clone (sets up Claude Code + Codex):

```bash
bunx skills experimental_install   # or: bunx skills add shadcn/ui --agent '*' -y
```

When doing UI work, invoke the shadcn skill rather than hand-writing component markup, and check
component docs before composing. Keep the viewer chrome subtle — uploaded content is the primary UI.
