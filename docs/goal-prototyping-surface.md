# GOAL — `see` as a design / prototyping surface

Status: **in progress.** This is a durable goal doc (drive-to-completion, not phase-gated).
Read alongside `AGENTS.md`, `design.md`, and `docs/static-app-share-service-spec.md`. When an
item ships, check it off here; when scope changes, amend here first.

## Thesis

`see` becomes the staple tool for **LLM-authored design/prototyping**: an agent ships an
interactive static app, a human reviews it live — inspecting any layer, annotating it — and
hands precise change-requests back to the agent. The app feels real (state across pages) while
the platform stays simple and the published artifact stays safe.

## The writer model (keystone)

One rule makes the whole system coherent:

> **The LLM is the only writer to the server. The human never writes to the server.**
> The human interacts and annotates; every human intent — a tweak experiment, an inspector
> comment — becomes a **clipboard payload** the LLM turns into a patch.

```
   LLM author ──patch API──▶  see (server: files + see.json)  ◀──read── everyone
       ▲                            │ serve-time compose (HTMLRewriter)
       │ paste payload              ▼
   clipboard ◀── annotate ── human ── viewer chrome (overlay + state)
                                          │ MessageChannel ▶ content runtime (sandboxed iframe)
                                          state ▶ localStorage on the VIEWER origin (clearable)
                                          no server writes from the human — ever (yet)
```

- **Server holds content**, written only by the LLM via the existing patch API.
- **Runtime state is localStorage-only — on the *viewer* origin.** The content iframe is sandboxed
  without `allow-same-origin`, so its document has an opaque origin: it **cannot** use localStorage,
  and a parent cannot postMessage to it with a concrete `targetOrigin`. So the viewer (concrete
  origin) holds the state and re-sends it into each page over a **MessageChannel** — that is what
  makes a visitor's tweak experiments survive navigation. One **Clear storage** control wipes it.
  **Do not persist runtime/tweak state server-side yet.**
- **The clipboard is the bridge back to authoring** — comments and "make this the default"
  experiments serialize into payloads the LLM applies as patches.

## Two tiers (this reconciles commit 365a0e6, which dropped the inspector SDK)

| served path | runtime in content | server writes | purpose |
|---|---|---|---|
| **plain share** (no `see.json`) | none | — | the user's static files, untouched |
| **bundle** (`see.json`) | tweak `<style>` + the prototype runtime, for **every** viewer | viewer-origin localStorage | live tweaks, interaction, inspect/annotate; state persists per-visitor across pages |

**Decision (2026-06-16): the runtime ships to all content-origin viewers — not preview-gated.**
The content origin sets no CSP and uploaded apps already run arbitrary JS under the `allow-scripts`
sandbox, so a *minimal, trusted* runtime is not a new capability or a server-state leak. Because the
sandbox gives the content iframe an opaque origin, the runtime is a thin **applier**: it holds no
storage and *initiates* a **MessageChannel** handshake to the viewer's concrete origin (never a
wildcard); state and persistence live on the viewer origin. This matches the product direction
(localStorage is how the app "kinda works", and Phase 4 visitor personalization wants a public
runtime anyway). The canonical share still serves the user's own content — we add only the tweak
`<style>` + the small runtime.

## Load-bearing invariants (never violate; Codex review enforces)

1. The viewer iframe sandbox stays **without `allow-same-origin`**; the **viewer-origin CSP is not
   loosened** (the content origin sets no CSP by design).
2. **The injected runtime is minimal, self-contained, and trusted.** No `eval`/remote code, no
   secrets; it degrades silently when there is no viewer parent (plain shares / standalone views);
   it holds NO storage (the sandbox denies it) and drives nothing on its own. It is not a
   server-state channel — the human never writes to the server.
3. **Every cross-window boundary is authenticated.** The content iframe has an opaque origin, so the
   child *initiates* the handshake to the viewer's **concrete** origin and transfers a `MessagePort`;
   all further traffic is point-to-point over the port (no `targetOrigin`, never a wildcard). The
   viewer identifies its child by `event.source` (the opaque origin can't be matched). No window
   `message` handler trusts an arbitrary sender. **Accepted limitation (arbitrated 2026-06-16):**
   uploaded JS shares the iframe's opaque origin and knows the public share id, so the handshake is
   spoofable and *cannot* be made unspoofable (any nonce the runtime can read, same-document page
   code can read too). This is acceptable because the bridge is one-way (viewer → content) and
   carries only cosmetic cssVar overrides the content already sees applied to its own `:root` — no
   viewer-private data crosses it, and the viewer never acts on inbound port messages.
4. Near-zero-dep Bun project — no new runtime deps without a strong reason.
5. UI consumes **Blueprint tokens by name** (`design.md`) — no raw OKLCH/hex; hairlines over
   shadows; mono voice for machine data; viewer chrome stays subtle.

## Viewer responsibilities (state & data lifecycle)

Because the content iframe is storage-less and driven only over a port, the **viewer owns all
runtime state and its lifecycle** — this is a load-bearing role, not just UI:

- **Hold state.** Per share, `localStorage["see.tweaks.<id>"]` on the viewer origin holds the
  visitor's cssVar overrides. The viewer is the only reader/writer; writes are quota-guarded
  (try/catch + prune on failure).
- **Drive the iframe.** On each handshake (`see:hello`) the viewer sends `see:state` with the
  current overrides; on overlay edits it sends `see:tweak` / `see:reset` over the port.
- **Clean data — first-class.**
  - *Clear this share* ("Reset to published"): wipe `see.tweaks.<id>`, send `see:clear` so the
    iframe drops its applied inline vars (the server's static `<style>` defaults reappear), and
    reset the overlay.
  - *Clear all* (privacy / housekeeping): drop every `see.tweaks.*` entry on the viewer origin.
  - *Auto-clean*: prune a share's entry when it 404s/410s (deleted/expired); bound total footprint.
- **No server writes.** Clearing never touches the server — it is purely viewer-origin localStorage
  plus a port message. (Promoting an experiment to the published default is a separate, explicit
  LLM-patch action via the clipboard loop.)

## Pillars

- **A · Tweaks = a declarative interaction layer.** A tweak declares a target the injected
  runtime applies: `css` (style — static `<style>`), `attr` / `class` (DOM state, applied live). The
  LLM may always write raw JS instead; the declarative path is convenience, never a cage.
  (**`store` dropped 2026-06-17:** the content iframe's opaque origin has no localStorage, and the
  viewer-origin override replay already gives cross-page persistence for every target — see the
  `src/content-runtime.ts` header.)
- **B · Shared material (token economy).** `shared/` convention + `<see-include src="…">`
  serve-time transclusion via HTMLRewriter. The LLM writes a fragment once and references it from
  many pages, so its output stays small. Per-page tweaks vary the shared fragment.
- **C · Inspect-to-layer + comment → clipboard → LLM.** Preview-gated inspector inside the iframe:
  hover/highlight, click-lock, climb parent/child to the layer you want, attach a comment. The
  comment copies to the clipboard **keyed in the patch API's own vocabulary** (CSS selector for
  HTML, JSON pointer for data) + page + note — a near-executable change-request. Gated on the
  content carrying `data-see="…"` anchors, with a DOM-path fallback.
- **D · Rules, not a pipeline.** The platform is conventions + serve-time composition, so the LLM
  authors in any order. `see.json` is the rule sheet; conventions are `shared/`, `data-see`,
  `var(--token)`, and tweak targets (`css`/`attr`/`class`). The rules are fed to the workflow via `src/docs/llms.txt`.
- **E · Presets / "Looks".** A `presets` map in `see.json` (additive) + an overlay switcher: one
  app, multiple curated faces. Experiments live in localStorage; the LLM patches to make one the
  default.

## Work checklist (mirrors the task tracker)

- [x] **Review loop** — `scripts/codex-review.sh` (Codex cross-model review), `.codex-review/`
  gitignored, documented in `AGENTS.md`. Smoke-tested. Runs after every meaningful chunk.
- [x] **Phase 1a — Content runtime** (committed `45ecc76`). `see:*` protocol; runtime injected into
  every bundle's served HTML (port handshake to the viewer's concrete origin; thin applier, no
  storage); `css` target; injected-HTML ETag versioned by runtime + viewer origin; plain shares
  untouched.
- [x] **Phase 1b — Viewer half + targets.** Viewer handshake (identify child by `event.source`),
  per-share state in viewer-origin localStorage, `see:state` on each handshake, Clear-storage / data
  lifecycle; tweak targets `css`/`attr`/`class` (op protocol + snapshot undo; `store` dropped —
  opaque origin has no localStorage).
- [x] **Phase 2 — Surface.** `GET /api/uploads/{id}/tweaks?page=` (resolved defs+values); generalized
  tweak schema in `bundle.ts` + `upload-metadata.ts` + `llms.txt`; `TweaksOverlay` Blueprint
  instrument (grouped, per-kind widgets, live drag, reset, inherited/overridden badges, page-aware);
  CSS auto-discovery (scan `:root` custom props, infer kind/range/group/label, one-click expose
  writing `see.json` via patch) + empty-state; bar toggle + viewer-handshake wiring.
- [x] **Phase 3 — Review loop (product).** Inspector runtime (ships with the content runtime); comment composer;
  patch-vocab-keyed clipboard payload; `data-see` convention documented in `llms.txt`.
- [x] **Phase 4 — Compose.** `shared/` + `<see-include>` transclusion; `presets`/Looks + switcher.
- [ ] **Close-out.** Docs (spec security contract for the all-viewers runtime, AGENTS.md, llms.txt,
  design.md if new tokens); tests (parse/validate targets, page-over-shared, include expansion,
  endpoint, bridge origin-check); bump `ASSET_VERSION` in `src/pages.ts`; green
  `bun run typecheck && bun run build:client && bun test`.

## Done criteria

1. An LLM can ship a bundle whose tokens auto-surface as a controller, add interaction via tweak
   targets, and reference shared material — with small output.
2. A human can open the viewer, drag tweaks live (state held on the viewer origin and re-applied
   over the port so it persists across pages), inspect any layer, comment, and copy a payload that
   the LLM applies verbatim.
3. A bundle serves the user's own content plus a minimal, trusted, port-only runtime (no eval/
   secrets, no untrusted-origin control); plain shares are served untouched; the sandbox and the
   viewer-origin CSP are intact.
4. All five invariants hold; verify suite green; Codex verdict `SHIP`.

## Review loop (how we work)

After each meaningful chunk: `scripts/codex-review.sh` (working-tree) or `--base main`. Codex
(`gpt-5.5`, independent model) reviews against the invariants above; address findings before
moving on. Claude implements; Codex critiques; the human arbitrates via the goal.
