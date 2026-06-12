# see

Upload a static app — a single HTML file, a ZIP archive, or a folder of static
resources — and get a shareable live-preview link instantly. Uploaded apps are
served from an isolated content origin and rendered in a sandboxed, inspectable
viewer (resizable viewport presets, zoom, device frame, dark mode).

Built with **Bun**, **React 19 + Vite + Tailwind v4 + shadcn/ui**, and SQLite
(via `bun:sqlite`). Near-zero runtime dependencies.

## Features

- Single `.html`/`.htm`, `.zip`, or multi-file uploads (must contain an `index.html`).
- Public, unlisted viewer links with configurable retention (default 7 days).
- Per-share **edit token** (returned once, stored only as a hash) gates
  add/replace/patch/delete of resources; reads stay public.
- Optional deployment-wide `UPLOAD_TOKEN` to gate who can create shares.
- Separate content origin + sandboxed iframe for a real browser security boundary.
- Live viewer: viewport presets, custom width/height, rotate, zoom, device frame,
  safe-area overlay, dark mode, focus mode, and an in-viewer resource editor.

## Quick start

```bash
bun install
bun run dev          # builds the client, then runs the server with --watch
```

```bash
# Run against a local data dir
PUBLIC_BASE_URL=http://localhost:3000 \
DATABASE_URL=sqlite:/tmp/see/app.db \
STORAGE_DIR=/tmp/see/uploads \
bun run start
```

Open <http://localhost:3000>.

## Scripts

```bash
bun run build:client   # build the React client into dist/client
bun run start          # run the server (expects a built client)
bun run dev            # build client + run server in watch mode
bun test               # run the test suite
bun run typecheck      # tsc --noEmit
```

## Configuration

All config is via environment variables (see `src/config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public viewer/upload origin (required in production) |
| `CONTENT_BASE_URL` | _(none)_ | Separate origin for uploaded content; falls back to same-host `/content/:id/` |
| `DATABASE_URL` | `sqlite:/data/app.db` | SQLite path (`sqlite:/abs/path`) |
| `STORAGE_DIR` | `/data/uploads` | Artifact storage directory |
| `RETENTION_DAYS` | `7` | How long shares live |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Per-request upload cap |
| `UPLOAD_TOKEN` | _(none)_ | If set, creating a share requires `Authorization: Bearer <token>` |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for client IP / rate limiting. **Leave `false` unless behind a trusted reverse proxy** — otherwise the header is spoofable and defeats the upload rate limiter. Set `true` only when a proxy (nginx/Caddy/LB) sets a reliable `X-Forwarded-For`. |

See `docs/static-app-share-service-spec.md` for the full design, API surface, and
security model.

## Docker

```bash
docker build -t see .
docker run -d --name see \
  -p 3000:3000 \
  -v see-data:/data \
  -e PUBLIC_BASE_URL=https://share.example.com \
  -e CONTENT_BASE_URL=https://content.share.example.com \
  see
```

The container stores SQLite metadata at `/data/app.db`, artifacts under
`/data/uploads`, runs as a non-root user, and exposes `/healthz`.

## License

Private project — all rights reserved unless stated otherwise.
