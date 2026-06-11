import type { ResourceInfo } from "./types";
import { escapeHtml } from "./lib/html";

const HTML_ENTRY_PATTERN = /\.(html?|htm)$/i;

export function isHtmlEntry(path: string): boolean {
  return HTML_ENTRY_PATTERN.test(path);
}

// Standalone landing page for an upload with no index.html: links each HTML entry, lists all files.
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
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #171717; --muted: #737373; --line: #e5e5e5;
    --surface: #fafafa; --fg-invert: #fafafa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a; --fg: #fafafa; --muted: #a1a1a1; --line: #262626;
      --surface: #171717; --fg-invert: #171717;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; color: var(--fg); background: var(--bg);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 44rem; margin: 0 auto; padding: clamp(1.5rem, 5vw, 4rem) 1.25rem; }
  .card {
    background: var(--bg); border: 1px solid var(--line); border-radius: 0.75rem;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04); padding: clamp(1.25rem, 4vw, 2.25rem);
  }
  .badge {
    display: inline-block; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted);
    border: 1px solid var(--line); padding: 0.25rem 0.6rem; border-radius: 999px;
  }
  h1 {
    margin: 0.85rem 0 0; font-size: clamp(1.5rem, 5vw, 2rem); font-weight: 700;
    letter-spacing: -0.02em; color: var(--fg);
  }
  .note { margin: 0.5rem 0 1.5rem; font-size: 0.9rem; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
    background: var(--surface); border: 1px solid var(--line); padding: 0.05em 0.35em; border-radius: 0.35rem; }
  h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 1.75rem 0 0.75rem; }
  .group:first-of-type h2 { margin-top: 0.5rem; }
  .entries { display: grid; gap: 0.5rem; }
  .entry {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.8rem 1.1rem; border-radius: 0.6rem; text-decoration: none;
    background: var(--fg); color: var(--fg-invert); font-weight: 600;
    transition: opacity 0.12s ease;
  }
  .entry:hover { opacity: 0.9; }
  .entry-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-open { flex-shrink: 0; opacity: 0.8; font-size: 0.9rem; }
  .files { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
  .files li {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.55rem 0.85rem; border-radius: 0.5rem;
    background: var(--surface); border: 1px solid var(--line);
  }
  .files a { color: var(--fg); text-decoration: none; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files a:hover { text-decoration: underline; }
  .size { flex-shrink: 0; font-variant-numeric: tabular-nums; font-size: 0.8rem; color: var(--muted); }
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
