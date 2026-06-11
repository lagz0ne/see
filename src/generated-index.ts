import type { ResourceInfo } from "./types";

const HTML_ENTRY_PATTERN = /\.(html?|htm)$/i;

export function isHtmlEntry(path: string): boolean {
  return HTML_ENTRY_PATTERN.test(path);
}

/**
 * Build a standalone landing page for an upload that has no `index.html`.
 *
 * Used when a ZIP or multi-file upload either contains no entry point or has
 * several possible entries: instead of rejecting the upload, we generate an
 * index that links to each HTML entry point and lists every file, so the
 * share is still viewable.
 */
export function renderGeneratedIndex(resources: ResourceInfo[], title?: string): string {
  const heading = (title && title.trim()) || "Uploaded app";
  const entries = resources.filter((resource) => isHtmlEntry(resource.path));
  const fileCount = resources.length;

  const entriesSection =
    entries.length > 0
      ? `
      <section class="group">
        <h2>${entries.length === 1 ? "Entry point" : `Entry points (${entries.length})`}</h2>
        <div class="entries">
          ${entries
            .map(
              (entry) => `
          <a class="entry" href="./${encodePath(entry.path)}">
            <span class="entry-name">${escapeHtml(entry.path)}</span>
            <span class="entry-open">Open &rarr;</span>
          </a>`,
            )
            .join("")}
        </div>
      </section>`
      : "";

  const filesSection = `
      <section class="group">
        <h2>Files (${fileCount})</h2>
        <ul class="files">
          ${resources
            .map(
              (resource) => `
          <li>
            <a href="./${encodePath(resource.path)}">${escapeHtml(resource.path)}</a>
            <span class="size">${formatBytes(resource.bytes)}</span>
          </li>`,
            )
            .join("")}
        </ul>
      </section>`;

  const note =
    entries.length === 0
      ? `<p class="note">This upload has no <code>index.html</code>, so this listing was generated automatically.</p>`
      : entries.length > 1
        ? `<p class="note">This upload has several entry points and no <code>index.html</code>, so this chooser was generated automatically.</p>`
        : `<p class="note">No <code>index.html</code> was found, so this page was generated automatically.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1c1830;
    background:
      radial-gradient(42rem 42rem at 8% -10%, rgba(124, 58, 237, 0.18), transparent 60%),
      radial-gradient(38rem 38rem at 100% 0%, rgba(217, 70, 239, 0.16), transparent 55%),
      #f7f6fb;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #ece9f6; background:
      radial-gradient(42rem 42rem at 8% -10%, rgba(124, 58, 237, 0.28), transparent 60%),
      radial-gradient(38rem 38rem at 100% 0%, rgba(217, 70, 239, 0.22), transparent 55%),
      #161320; }
    .card { background: rgba(34, 28, 50, 0.72); border-color: rgba(255,255,255,0.08); }
    .entry, .files li { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }
    a { color: #c9b6ff; }
    .size, .note { color: #a99fc4; }
  }
  .wrap { max-width: 44rem; margin: 0 auto; padding: clamp(1.5rem, 5vw, 4rem) 1.25rem; }
  .card {
    background: rgba(255,255,255,0.72);
    backdrop-filter: blur(18px) saturate(1.4);
    border: 1px solid rgba(28, 24, 48, 0.08);
    border-radius: 1.25rem;
    box-shadow: 0 24px 60px -24px rgba(76, 29, 149, 0.4);
    padding: clamp(1.25rem, 4vw, 2.25rem);
  }
  .badge {
    display: inline-block; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.16em;
    text-transform: uppercase; color: #7c3aed;
    background: rgba(124, 58, 237, 0.12); padding: 0.3rem 0.6rem; border-radius: 999px;
  }
  h1 {
    margin: 0.85rem 0 0; font-size: clamp(1.6rem, 5vw, 2.2rem); font-weight: 800;
    letter-spacing: -0.02em;
    background: linear-gradient(110deg, #6d28d9, #a21caf 55%, #db2777);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .note { margin: 0.5rem 0 1.5rem; font-size: 0.9rem; color: #6b6385; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
    background: rgba(124,58,237,0.12); padding: 0.1em 0.35em; border-radius: 0.35rem; }
  h2 { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
    color: #8a82a3; margin: 1.75rem 0 0.75rem; }
  .group:first-of-type h2 { margin-top: 0.5rem; }
  .entries { display: grid; gap: 0.6rem; }
  .entry {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.85rem 1.1rem; border-radius: 0.85rem; text-decoration: none;
    background: linear-gradient(135deg, #6d28d9, #a21caf 50%, #db2777); color: #fff;
    font-weight: 600; box-shadow: 0 10px 24px -12px rgba(124, 58, 237, 0.7);
    transition: transform 0.12s ease, filter 0.12s ease;
  }
  .entry:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .entry-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-open { flex-shrink: 0; opacity: 0.9; font-size: 0.9rem; }
  .files { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  .files li {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.55rem 0.85rem; border-radius: 0.65rem;
    background: rgba(124, 58, 237, 0.05); border: 1px solid rgba(28, 24, 48, 0.06);
  }
  .files a { color: #6d28d9; text-decoration: none; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files a:hover { text-decoration: underline; }
  .size { flex-shrink: 0; font-variant-numeric: tabular-nums; font-size: 0.8rem; color: #8a82a3; }
</style>
</head>
<body>
  <div class="wrap">
    <main class="card">
      <span class="badge">Static App Share</span>
      <h1>${escapeHtml(heading)}</h1>
      ${note}
      ${entriesSection}
      ${filesSection}
    </main>
  </div>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
