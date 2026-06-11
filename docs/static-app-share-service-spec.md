# Static App Share Service Spec

Status: draft for alignment  
Target runtime: one Docker-deployed service, suitable for Dokploy  
Primary flow: upload `index.html`, static resource files, or `.zip` -> receive share link and edit token -> inspect in managed viewer for 7 days

## 1. Purpose

The service provides short-lived sharing for static frontends and HTML prototypes. A user uploads a single HTML file, a set of static resource files, or a zip archive containing a static app. The service returns a public, unlisted viewer link and a per-share edit token. The link remains available for 7 days, then expires.

The viewer link does not expose uploaded files as a bare directory listing. It opens a managed inspection shell that embeds the uploaded app in a sandboxed iframe and gives the viewer controls for inspecting the app at different viewport sizes and visual contexts.

## 2. Success State

The MVP is successful when a user can upload a simple `index.html`, a small group of static files, or static-site `.zip`, immediately receive a shareable viewer link and edit token, send the viewer link to someone else, and the recipient can safely inspect the app for 7 days without an account, download step, or manual deployment work. Anyone with only the viewer link has read-only access. Anyone with the edit token can add, replace, patch, and delete resources within that share.

The success demo should be:

```text
upload demo.zip
  -> copy viewer link
  -> copy edit token
  -> open link in another browser
  -> inspect mobile, tablet, and desktop frames
  -> enter edit token and replace style.css
  -> refresh viewer and see patched content without waiting for stale cache
  -> switch viewer light/dark chrome
  -> refresh and resize the iframe
  -> restart the service and confirm the unexpired link still works
  -> force or wait for expiration
  -> confirm viewer/content routes no longer serve uploaded content
```

Success means all of the following are true:

- Uploading `index.html` returns a viewer link.
- Uploading multiple static resource files with an index file returns one viewer link.
- Uploading a `.zip` with `index.html` and assets returns a viewer link.
- Upload responses include a per-share edit token, generated when the user leaves the edit token field blank.
- Resource add, replace, patch, and delete operations require the per-share edit token.
- Viewer/content routes remain read-only without the edit token.
- Invalid files, missing entrypoints, oversized uploads, unsafe paths, and symlink archives are rejected.
- Viewer links open a managed inspection shell, not a raw directory or raw uploaded file.
- Uploaded content renders inside a sandboxed iframe without `allow-same-origin`.
- Viewer controls support viewport presets, custom dimensions, rotate, zoom, refresh, copy link, frame overlays, and viewer light/dark mode.
- Viewer light/dark mode affects only the managed viewer chrome in the MVP.
- Links remain valid for 7 days from successful upload completion.
- Expired links do not serve uploaded content.
- Expired files are eventually cleaned from storage.
- The service runs as one Docker container deployed to Dokploy.
- Durable data is stored under `/data` and survives container restart.
- `/healthz` returns healthy while the service can accept uploads and serve active links.
- No Git repository, Docker image, or Dokploy app is created per upload.
- Logs clearly distinguish successful uploads, validation failures, expiration, and cleanup.
- Configured upload and extraction limits prevent obvious accidental disk exhaustion.
- Content responses support cache revalidation so patched resources become visible after viewer refresh.

## 3. Abstraction Ladder

Each level has an artifact that should align before moving to the next level.

| Level | Question | Alignment artifact |
| --- | --- | --- |
| Product | What user-visible behavior are we committing to? | User flow, retention behavior, viewer feature list |
| System | What components exist and where are the trust boundaries? | Architecture diagram and boundary decisions |
| Contract | What HTTP routes and data shapes must implementation satisfy? | API and route contract |
| Data | What is stored and how does expiration work? | Data model and storage layout |
| Security | How is uploaded content isolated from viewers and the service? | Sandbox, headers, validation, rate limits |
| Operations | How does this run in Docker/Dokploy? | Environment variables, health checks, volumes |
| Delivery | How do we know implementation is done? | Acceptance tests and deployment checklist |

## 4. Product Contract

### Core User Flow

1. User opens the upload page.
2. User chooses either:
   - one `.html` file, or
   - multiple static resource files, or
   - one `.zip` archive containing a static site.
3. User optionally enters an edit token/password. If blank, the service generates one.
4. Service validates the upload.
5. Service stores the normalized static artifact.
6. Service returns a viewer URL and edit token.
7. Viewer URL opens a managed inspection shell.
8. The shell embeds the uploaded app in a sandboxed iframe.
9. Link works until `expiresAt`, exactly 7 days after successful upload.
10. After expiration, viewer and content routes return an expired state, not the uploaded app.

### Upload Rules

Accepted inputs:

- Single HTML file:
  - extension `.html` or `.htm`
  - stored as `index.html`
- Multiple resource files:
  - stored relative to their submitted browser file paths or explicit API paths
  - if exactly one non-index HTML file is submitted with other assets and no index file, it is normalized to `index.html`
  - if no `index.html`/`index.htm` results, a landing page is generated automatically (see "Generated index page")
- Zip archive:
  - extension `.zip`
  - may contain JS, CSS, fonts, images, media, JSON, WASM, and other static assets
  - an `index.html`/`index.htm` is preferred but not required; one is generated when absent

Zip root normalization:

- If `index.html` exists at archive root, use archive root.
- If the archive has exactly one top-level directory and no root-level files, strip that top-level directory.

Generated index page:

- If, after extraction/normalization, a share has no root `index.html`/`index.htm`,
  a landing page is generated at `index.html`. It links to every HTML entry point
  (acting as a chooser when there are several) and lists all files. A real
  `index.html` (uploaded later or promoted from a single HTML file) always wins.
- An empty zip (no files) is still rejected (`empty_archive`).
- Otherwise reject the upload with a clear error.

Default limits:

- Max uploaded file size: 25 MB
- Max extracted size: 100 MB
- Max extracted file count: 1,000
- Max nested path depth: 12
- Max individual extracted file size: 25 MB

Limits must be configurable through environment variables.

### Viewer Features

MVP viewer features:

- Public unlisted viewer URL.
- Expiration timestamp visible in viewer chrome.
- Sandboxed iframe rendering the uploaded app.
- Viewport presets:
  - mobile portrait
  - mobile landscape
  - tablet
  - desktop
  - responsive/full width
  - custom width and height
- Resize frame controls.
- Rotate width/height.
- Zoom controls:
  - fit
  - 100%
  - configurable percentage
- Refresh iframe.
- Copy viewer link.
- Compact resources popover for listing resources and token-gated add/replace/delete.
- Light/dark mode for the managed viewer chrome.
- Frame options:
  - show/hide device frame
  - show current viewport dimensions
  - show safe-area overlay

Important theme note:

- The light/dark switch is guaranteed to affect the managed viewer UI.
- It should not mutate uploaded content by default.
- Uploaded content may respond to its own CSS, JS, or `prefers-color-scheme`, but the parent viewer should not inject code into user artifacts in the MVP.

Post-MVP inspection features:

- File tree with open raw asset links.
- Screenshot export.
- Network request summary.
- Console log capture through an optional injected debug harness.
- Multiple share links per upload with different default viewport presets.
- Password-protected viewer links.

### Non-Goals

- Not persistent hosting.
- Not a replacement for Dokploy apps.
- Not server-side code execution.
- Not a general file sharing service.
- Not a code editor.
- Not a malware analysis sandbox.
- Not a service that creates one Dokploy app per upload.

## 5. System Architecture

The service is deployed once as a Docker container. Each upload becomes stored static content served by the same service until expiration.

```text
Browser
  |
  | POST /api/uploads
  v
Web Service
  |
  | validate, normalize, extract
  v
Artifact Store (/data/uploads)
  |
  v
Metadata DB (/data/app.db)

Viewer request:

Browser
  |
  | GET /v/:id
  v
Managed Viewer Shell
  |
  | iframe src=/content/:id/
  v
Sandboxed Static Content Handler
```

Recommended production origin layout:

```text
https://share.example.com/v/:id          -> managed viewer
https://content.share.example.com/:id/   -> uploaded static content
```

Acceptable MVP origin layout:

```text
https://share.example.com/v/:id          -> managed viewer
https://share.example.com/content/:id/   -> uploaded static content
```

The separate content origin is preferred because it gives a stronger browser boundary. The MVP may still use same-host content routes if the iframe uses a restrictive sandbox without `allow-same-origin`.

Route mapping:

- When `CONTENT_BASE_URL` is set to a separate origin, content URLs should use `/:id/*` on that origin.
- When `CONTENT_BASE_URL` is empty or same-origin, content URLs should use `/content/:id/*`.
- Both URL shapes can be backed by the same content-serving handler.

## 6. HTTP Contract

### `GET /`

Returns the upload UI.

### `POST /api/uploads`

Accepts multipart form data.

Request:

```http
POST /api/uploads
Content-Type: multipart/form-data

file=<html-or-zip-or-resource>
```

Optional fields:

- `title`: display name for the viewer.
- `editToken`: per-share edit token/password. When absent or blank, the service generates a random token.

The `file` multipart field may appear multiple times. A single `.zip` is extracted as an archive. Multiple files are stored as resources under one share.

Success response:

```json
{
  "id": "u_8mJ5pQvYx4",
  "viewerUrl": "https://share.example.com/v/u_8mJ5pQvYx4",
  "contentUrl": "https://content.share.example.com/u_8mJ5pQvYx4/",
  "kind": "zip",
  "editToken": "t_randomEditTokenReturnedOnce",
  "revision": 1,
  "resources": [
    {
      "path": "index.html",
      "bytes": 1042,
      "sha256": "abc123...",
      "updatedAt": "2026-06-11T12:00:00Z",
      "contentType": "text/html; charset=utf-8"
    }
  ],
  "createdAt": "2026-06-11T12:00:00Z",
  "expiresAt": "2026-06-18T12:00:00Z"
}
```

Error responses:

- `400` invalid file type
- `400` missing `index.html`
- `400` unsafe archive path
- `413` upload too large
- `422` extraction failed
- `429` rate limit exceeded
- `500` internal error

### `GET /v/:id`

Returns the managed viewer shell.

Behavior:

- `200` when upload exists and is not expired.
- `410` when upload exists but is expired.
- `404` when upload does not exist.

The viewer shell loads the uploaded app through an iframe. The initial iframe path should be generated from `CONTENT_BASE_URL` when present, otherwise from the same-host `/content/:id/` route:

```html
<iframe
  src="https://content.share.example.com/u_8mJ5pQvYx4/"
  sandbox="allow-scripts allow-forms allow-pointer-lock"
  referrerpolicy="no-referrer"
></iframe>
```

The sandbox must not include these permissions in the MVP:

- `allow-same-origin`
- `allow-top-navigation`
- `allow-top-navigation-by-user-activation`
- `allow-popups`
- `allow-modals`

These can be revisited if a real viewer requirement needs them.

### `GET /content/:id/*` or `GET /:id/*` on content origin

Serves uploaded static files.

Behavior:

- Accepts `/content/:id/*` on the viewer host.
- Accepts `/:id/*` on the content host when `CONTENT_BASE_URL` is configured.
- Resolves paths only within the normalized upload root.
- Defaults directory requests to `index.html`.
- For SPA support, optionally falls back unknown paths to `index.html`.
- Returns `410` if expired.
- Returns `404` if missing and SPA fallback is disabled.

MVP recommendation:

- Enable SPA fallback by default.
- Allow disabling SPA fallback with an upload option or environment variable later.

### `GET /api/uploads/:id`

Returns metadata needed by the viewer.

Success response:

```json
{
  "id": "u_8mJ5pQvYx4",
  "title": "demo.zip",
  "kind": "zip",
  "createdAt": "2026-06-11T12:00:00Z",
  "expiresAt": "2026-06-18T12:00:00Z",
  "expired": false,
  "contentRoot": "https://content.share.example.com/u_8mJ5pQvYx4/",
  "contentUrl": "https://content.share.example.com/u_8mJ5pQvYx4/?v=1",
  "revision": 1,
  "resources": []
}
```

### `GET /api/uploads/:id/resources`

Returns current resource metadata for an active share. This is read-only and does not require the edit token.

### `POST /api/uploads/:id/resources`

Adds or replaces one or more resources using multipart form data. Requires:

```http
Authorization: Bearer <edit-token>
```

Fields:

- `file`: one or more resource files.
- `path`: optional explicit path. Only valid with one file.

### `PATCH /api/uploads/:id/resources/*` or `PUT /api/uploads/:id/resources/*`

Replaces one resource at the requested relative path with the raw request body. Requires the edit token.

### `DELETE /api/uploads/:id/resources/*`

Deletes one resource. Requires the edit token. The service rejects deleting the last remaining `index.html` or `index.htm`.

### `GET /healthz`

Returns service health.

```json
{
  "ok": true
}
```

## 7. Data Model

Use SQLite for MVP unless deployment requirements require Postgres. SQLite keeps the Docker deployment simple and works for a single-instance service.

Table: `uploads`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text primary key | Opaque random ID, not sequential |
| `title` | text nullable | Display name |
| `original_filename` | text | Original uploaded filename |
| `kind` | text | `html` or `zip` |
| `status` | text | `ready`, `failed`, `expired`, `deleted` |
| `sha256` | text | Hash of uploaded file |
| `upload_bytes` | integer | Original upload size |
| `extracted_bytes` | integer | Stored content size |
| `file_count` | integer | Number of stored files |
| `storage_path` | text | Relative path under artifact root |
| `created_at` | datetime | UTC |
| `expires_at` | datetime | UTC, created_at plus 7 days |
| `deleted_at` | datetime nullable | Set after cleanup |
| `metadata_json` | text nullable | Extensible viewer/upload metadata |

Current metadata stores the hashed edit token and monotonically increasing resource revision:

```json
{
  "editTokenHash": "sha256-hex",
  "revision": 1
}
```

Storage layout:

```text
/data
  /app.db
  /uploads
    /u_8mJ5pQvYx4
      /index.html
      /assets/app.css
      /assets/app.js
```

Expiration behavior:

- `expires_at` is computed at successful upload completion.
- At or after `expires_at`, viewer and content requests must not serve uploaded content.
- Cleanup can delete files asynchronously after expiration.
- A cleanup grace period is allowed, but expired content remains inaccessible during the grace period.

Default cleanup:

- Run cleanup every hour.
- Delete expired upload files.
- Mark row `deleted`.
- Keep deleted metadata for 14 days for operational debugging.

## 8. Security Contract

### Upload Validation

The service must reject:

- Archives with absolute paths.
- Archives with `..` traversal paths.
- Archives containing symlinks.
- Archives exceeding configured size or file count limits.
- Archives without an HTML entrypoint.
- Files whose normalized extracted path escapes the upload directory.

The service should:

- Extract into a temporary directory.
- Validate paths before writing.
- Move the normalized artifact into final storage atomically.
- Never execute uploaded files.

### Iframe Isolation

The viewer iframe must:

- Use `sandbox`.
- Omit `allow-same-origin`.
- Omit top-navigation permissions.
- Omit popup permissions by default.
- Use `referrerpolicy="no-referrer"`.

Parent viewer must not:

- Inject scripts into uploaded content in MVP.
- Trust messages from the iframe unless an explicit postMessage protocol is added.
- Expose admin or upload credentials to the iframe.

### HTTP Headers

Viewer shell headers:

```http
Content-Security-Policy: default-src 'self'; frame-src 'self' https://content.share.example.com; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

Content route headers:

```http
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: public, max-age=0, must-revalidate
ETag: W/"upload-revision-size-mtime"
Last-Modified: <file mtime>
```

Content Security Policy for uploaded content is a product/security tradeoff.

MVP recommendation:

- Do not add a restrictive CSP to content routes at first, because uploaded static apps may need external CDNs, fonts, APIs, or WASM.
- Rely on iframe sandboxing to protect the managed viewer.
- Add an optional `CONTENT_CSP_MODE=strict` later for deployments that prefer blocking external resources.

### Abuse Controls

Default deployment should protect upload creation. Viewer links can be public.

MVP options:

- `UPLOAD_TOKEN` environment variable.
- When set, upload API requires:

```http
Authorization: Bearer <token>
```

Recommended public deployment controls:

- Request body size limits.
- IP rate limits.
- Upload token or SSO-protected upload page.
- Viewer links public and unlisted.
- No directory listing.

## 9. Docker And Dokploy Deployment

The service should build into a single Docker image.

Required runtime behavior:

- Listen on `PORT`, default `3000`.
- Store durable state in `/data`.
- Expose `/healthz`.
- Run cleanup loop in the same process for MVP, or as a second process only if needed later.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `PUBLIC_BASE_URL` | required | Base URL for viewer links |
| `CONTENT_BASE_URL` | empty | Optional separate origin for content |
| `DATABASE_URL` | `sqlite:/data/app.db` | Metadata database |
| `STORAGE_DIR` | `/data/uploads` | Artifact storage |
| `RETENTION_DAYS` | `7` | Link lifetime |
| `CLEANUP_INTERVAL_SECONDS` | `3600` | Cleanup frequency |
| `MAX_UPLOAD_BYTES` | `26214400` | 25 MB |
| `MAX_EXTRACTED_BYTES` | `104857600` | 100 MB |
| `MAX_FILE_COUNT` | `1000` | Extracted file count limit |
| `MAX_PATH_DEPTH` | `12` | Path depth limit |
| `UPLOAD_TOKEN` | empty | Optional upload protection |
| `TRUST_PROXY` | `true` | Respect reverse proxy headers |

Example Docker Compose:

```yaml
services:
  static-share:
    image: ghcr.io/example/static-share:latest
    restart: unless-stopped
    environment:
      PORT: "3000"
      PUBLIC_BASE_URL: "https://share.example.com"
      CONTENT_BASE_URL: "https://content.share.example.com"
      RETENTION_DAYS: "7"
      UPLOAD_TOKEN: "${UPLOAD_TOKEN}"
    volumes:
      - static-share-data:/data
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  static-share-data:
```

Dokploy deployment target:

- Deploy the Docker image as one application.
- Attach a persistent volume mounted at `/data`.
- Route `share.example.com` to the service.
- Optionally route `content.share.example.com` to the same service.
- Set `PUBLIC_BASE_URL`.
- Set `CONTENT_BASE_URL` if using the separate content origin.
- Protect upload UI/API with `UPLOAD_TOKEN`, Pangolin, Dokploy auth, or another access layer.
- Keep viewer URLs public unless password-protected links are added later.

## 10. Implementation Shape

Implementation can be any web stack that satisfies the contracts. Recommended MVP shape:

- One server-rendered or SPA frontend for upload and viewer shell.
- One backend service for upload, extraction, metadata, content serving, and cleanup.
- SQLite for metadata.
- Local filesystem volume for artifacts.

Suggested internal modules:

```text
src/
  server/
    routes/
      upload
      viewer
      content
      health
    services/
      artifact-validator
      artifact-extractor
      artifact-store
      expiry-cleaner
      url-builder
    db/
      schema
      uploads-repository
  web/
    upload-page
    viewer-page
    components/
      viewport-frame
      toolbar
      expiry-badge
```

## 11. Acceptance Criteria

### Upload

- Uploading a valid single `index.html` returns a viewer URL.
- Uploading a valid zip with root `index.html` returns a viewer URL.
- Uploading a valid zip with one wrapper directory containing `index.html` returns a viewer URL.
- Uploading a zip without `index.html` returns `400`.
- Uploading an oversized file returns `413`.
- Uploading a zip with path traversal is rejected.
- Uploading a zip with symlinks is rejected.

### Viewer

- Viewer opens the uploaded app inside an iframe.
- Iframe has the required sandbox attributes.
- Iframe does not include `allow-same-origin`.
- Viewer can switch viewport presets without re-uploading.
- Viewer can set custom width and height.
- Viewer can rotate viewport dimensions.
- Viewer can zoom fit and 100%.
- Viewer light/dark mode changes viewer chrome.
- Viewer shows expiration timestamp.
- Copy link copies the public viewer URL.

### Expiration

- Before `expires_at`, viewer route returns `200`.
- Before `expires_at`, content route returns files.
- At or after `expires_at`, viewer route returns `410` or an expired shell.
- At or after `expires_at`, content route does not return uploaded files.
- Cleanup deletes expired files without deleting active uploads.

### Docker/Dokploy

- Image builds without local-only dependencies.
- Container starts with only environment variables and `/data` volume.
- `/healthz` returns `200`.
- State survives container restart.
- Dokploy route serves upload UI and viewer URLs.
- Optional content subdomain serves iframe content.

## 12. Open Decisions

These should be resolved before implementation starts:

1. Upload access model:
   - token-protected upload API,
   - Pangolin-protected upload UI,
   - or public uploads with rate limits.
2. Content origin:
   - separate `content.share.example.com` origin,
   - or same-origin `/content/:id/*` route for MVP.
3. Stack:
   - Node/TypeScript,
   - Go,
   - or another runtime.
4. Maximum upload limits:
   - keep defaults above,
   - or tune for expected use.
5. Raw content access:
   - allow "open raw app" button,
   - or force all viewing through managed iframe.

## 13. Recommended MVP Decisions

For the first implementation:

1. Use token-protected upload creation with `UPLOAD_TOKEN`.
2. Keep viewer links public and unlisted.
3. Use a separate content origin if DNS/routing is easy; otherwise use same-host content route with iframe sandbox.
4. Use SQLite plus local `/data/uploads`.
5. Use SPA fallback by default.
6. Do not inject scripts into uploaded content.
7. Implement as one Docker image and deploy once to Dokploy.
