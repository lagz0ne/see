import type { AppConfig } from "./config";
import type { UploadRecord } from "./types";
import { uploadRevision } from "./upload-metadata";
import { contentFrameSrc, viewerUrl } from "./urls";

const ASSET_VERSION = "20260611-vibrant-ui";

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
        <section class="mx-auto grid min-h-screen w-full max-w-xl place-items-center px-4 py-8">
          <div class="w-full rounded-xl border bg-card p-6 shadow-xl shadow-foreground/5">
            <p class="text-xs font-medium uppercase text-muted-foreground">Static App Share</p>
            <h1 class="mt-2 text-2xl font-semibold tracking-normal">Link expired</h1>
            <p class="mt-3 text-sm text-muted-foreground">${escapeHtml(title)} expired at ${escapeHtml(upload.expiresAt)}.</p>
          </div>
        </section>
      </main>
    `,
  );
}

export function notFoundPage(): string {
  return htmlDocument(
    "Not found",
    `
      <main class="message-page">
        <section class="mx-auto grid min-h-screen w-full max-w-xl place-items-center px-4 py-8">
          <div class="w-full rounded-xl border bg-card p-6 shadow-xl shadow-foreground/5">
            <p class="text-xs font-medium uppercase text-muted-foreground">Static App Share</p>
            <h1 class="mt-2 text-2xl font-semibold tracking-normal">Not found</h1>
            <p class="mt-3 text-sm text-muted-foreground">The requested share link does not exist.</p>
          </div>
        </section>
      </main>
    `,
  );
}

export function errorPage(title: string, message: string): string {
  return htmlDocument(
    title,
    `
      <main class="message-page">
        <section class="mx-auto grid min-h-screen w-full max-w-xl place-items-center px-4 py-8">
          <div class="w-full rounded-xl border bg-card p-6 shadow-xl shadow-foreground/5">
            <p class="text-xs font-medium uppercase text-muted-foreground">Static App Share</p>
            <h1 class="mt-2 text-2xl font-semibold tracking-normal">${escapeHtml(title)}</h1>
            <p class="mt-3 text-sm text-muted-foreground">${escapeHtml(message)}</p>
          </div>
        </section>
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
