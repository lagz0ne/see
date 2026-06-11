# Agent Instructions

`see` is the Static App Share service: upload a static app, get a sandboxed,
shareable live-preview link. Bun runtime + React/Vite/Tailwind/shadcn client.

Before changing behavior, read `docs/static-app-share-service-spec.md` — it is the
design source of truth (API surface, storage model, two-origin security model).

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
