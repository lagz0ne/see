import type { AppConfig } from "./config";
import type { UploadRecord } from "./types";
import { uploadRevision } from "./upload-metadata";
import { contentFrameSrc, contentOrigin, viewerUrl } from "./urls";
import { escapeHtml } from "./lib/html";

const ASSET_VERSION = "20260612-inspect";

export function uploadPage(config: AppConfig): string {
  return htmlDocument(
    "Static App Share",
    `
      <main class="upload-page" id="uploadApp" data-max-upload-bytes="${config.maxUploadBytes}" data-token-required="${config.uploadToken ? "true" : "false"}">
        <div
          id="staticShareRoot"
          data-page="upload"
          data-max-upload-bytes="${config.maxUploadBytes}"
          data-token-required="${config.uploadToken ? "true" : "false"}"
          data-retention-days="${config.retentionDays}"
        >
          <noscript>HTML or ZIP, up to ${escapeHtml(formatBytes(config.maxUploadBytes))}.</noscript>
        </div>
      </main>
      <script type="module" src="/assets/app.js?v=${ASSET_VERSION}"></script>
    `,
  );
}

export function viewerPage(config: AppConfig, upload: UploadRecord): string {
  const revision = uploadRevision(upload);
  const contentUrl = contentFrameSrc(config, upload.id, revision);
  const link = viewerUrl(config, upload.id);
  const title = upload.title || upload.originalFilename;
  // Origin the uploaded content is served from — the client validates inspector postMessages
  // against it. When content shares the public host, it is the public origin.
  const expectedContentOrigin = contentOrigin(config) ?? new URL(config.publicBaseUrl).origin;

  return htmlDocument(
    `${title} - Static App Share`,
    `
      <main
        id="viewerApp"
        data-upload-id="${escapeAttr(upload.id)}"
        data-content-url="${escapeAttr(contentUrl)}"
        data-viewer-url="${escapeAttr(link)}"
        data-expires-at="${escapeAttr(upload.expiresAt)}"
        data-resource-revision="${escapeAttr(String(revision))}"
      >
        <div
          id="staticShareRoot"
          data-page="viewer"
          data-upload-id="${escapeAttr(upload.id)}"
          data-title="${escapeAttr(title)}"
          data-content-url="${escapeAttr(contentUrl)}"
          data-content-origin="${escapeAttr(expectedContentOrigin)}"
          data-viewer-url="${escapeAttr(link)}"
          data-expires-at="${escapeAttr(upload.expiresAt)}"
          data-resource-revision="${escapeAttr(String(revision))}"
        >
          <noscript>
            <iframe
              title="Uploaded app"
              src="${escapeAttr(contentUrl)}"
              sandbox="allow-scripts allow-forms allow-pointer-lock"
              referrerpolicy="no-referrer"
            ></iframe>
          </noscript>
        </div>
      </main>
      <script type="module" src="/assets/app.js?v=${ASSET_VERSION}"></script>
    `,
  );
}

export function expiredPage(upload: UploadRecord): string {
  const title = upload.title || upload.originalFilename;
  return htmlDocument(
    "Link expired",
    `
      <main class="message-page">
        <div class="grid min-h-screen place-items-center px-4">
          <div class="w-full max-w-md">
            <div class="flex items-center gap-3 mb-4">
              <span class="inline-grid size-7 place-items-center rounded-[0.5rem] bg-primary text-primary-foreground" aria-hidden="true"></span>
              <span class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Static App Share</span>
            </div>
            <div class="border-t mb-6"></div>
            <h1 class="text-2xl font-semibold tracking-tight text-foreground mb-3">Link expired</h1>
            <p class="text-sm text-muted-foreground">${escapeHtml(title)} — expired <span class="font-mono tabular-nums">${escapeHtml(upload.expiresAt)}</span>.</p>
          </div>
        </div>
      </main>
    `,
  );
}

export function notFoundPage(): string {
  return htmlDocument(
    "Not found",
    `
      <main class="message-page">
        <div class="grid min-h-screen place-items-center px-4">
          <div class="w-full max-w-md">
            <div class="flex items-center gap-3 mb-4">
              <span class="inline-grid size-7 place-items-center rounded-[0.5rem] bg-primary text-primary-foreground" aria-hidden="true"></span>
              <span class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Static App Share</span>
            </div>
            <div class="border-t mb-6"></div>
            <h1 class="text-2xl font-semibold tracking-tight text-foreground mb-3">Not found</h1>
            <p class="text-sm text-muted-foreground">The requested share link does not exist.</p>
          </div>
        </div>
      </main>
    `,
  );
}

export function errorPage(title: string, message: string): string {
  return htmlDocument(
    title,
    `
      <main class="message-page">
        <div class="grid min-h-screen place-items-center px-4">
          <div class="w-full max-w-md">
            <div class="flex items-center gap-3 mb-4">
              <span class="inline-grid size-7 place-items-center rounded-[0.5rem] bg-primary text-primary-foreground" aria-hidden="true"></span>
              <span class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Static App Share</span>
            </div>
            <div class="border-t mb-6"></div>
            <h1 class="text-2xl font-semibold tracking-tight text-foreground mb-3">${escapeHtml(title)}</h1>
            <p class="text-sm text-muted-foreground">${escapeHtml(message)}</p>
          </div>
        </div>
      </main>
    `,
  );
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}" />
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value / 1024 / 1024)} MB`;
}
