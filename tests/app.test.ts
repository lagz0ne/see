import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import { createApp, type StaticShareApp } from "../src/app";
import { loadConfig, type AppConfig } from "../src/config";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    await cleanup.pop()?.();
  }
});

describe("static app share service", () => {
  test("uploads a single html file and serves it through the managed viewer", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>Hello share</h1>"], "index.html", { type: "text/html" }), {
      title: "Hello",
    });

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("html");
    expect(payload.viewerUrl).toBe(`http://share.test/v/${payload.id}`);

    const viewer = await app.fetch(new Request(payload.viewerUrl));
    expect(viewer.status).toBe(200);
    const viewerHtml = await viewer.text();
    expect(viewerHtml).toContain('sandbox="allow-scripts allow-forms allow-pointer-lock"');
    expect(viewerHtml).not.toContain("allow-same-origin");

    const content = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("Hello share");

    const head = await app.fetch(new Request("http://share.test/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("uploads a zip with root index and assets", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "index.html", data: '<link rel="stylesheet" href="/assets/app.css"><h1>Zip</h1>', method: 8 },
      { name: "assets/app.css", data: "body { color: red; }", method: 8 },
    ]);

    const response = await uploadFile(app, new File([zip], "demo.zip", { type: "application/zip" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("zip");

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<h1>Zip</h1>");

    const asset = await app.fetch(new Request(`http://share.test/content/${payload.id}/assets/app.css`));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("color: red");
  });

  test("uploads multiple resource files under one share", async () => {
    const { app } = await testApp();
    const response = await uploadFiles(app, [
      new File(['<link rel="stylesheet" href="style.css"><h1>Resources</h1>'], "index.html", { type: "text/html" }),
      new File(["body { color: teal; }"], "style.css", { type: "text/css" }),
    ]);

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.kind).toBe("resources");
    expect(typeof payload.editToken).toBe("string");
    expect(payload.editToken.startsWith("t_")).toBe(true);
    expect(payload.revision).toBe(1);
    expect(payload.resources.map((resource: { path: string }) => resource.path)).toEqual(["index.html", "style.css"]);

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("Resources");

    const style = await app.fetch(new Request(`http://share.test/content/${payload.id}/style.css`));
    expect(style.status).toBe(200);
    expect(await style.text()).toContain("color: teal");
  });

  test("strips one wrapper directory from zip archives", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "dist/index.html", data: '<script src="app.js"></script><h1>Wrapped</h1>' },
      { name: "dist/app.js", data: "globalThis.wrapped = true;" },
    ]);

    const response = await uploadFile(app, new File([zip], "wrapped.zip", { type: "application/zip" }));
    expect(response.status).toBe(201);
    const payload = await response.json();

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(await index.text()).toContain("Wrapped");
    const script = await app.fetch(new Request(`http://share.test/content/${payload.id}/app.js`));
    expect(await script.text()).toContain("wrapped");
  });

  test("generates an index page for a zip without an index entrypoint", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "app.js", data: "console.log('no index')" },
      { name: "style.css", data: "body { color: red; }" },
    ]);

    const response = await uploadFile(app, new File([zip], "noindex.zip", { type: "application/zip" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.resources.map((resource: { path: string }) => resource.path)).toContain("index.html");

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain("generated automatically");
    expect(html).toContain("app.js");
    expect(html).toContain("style.css");

    // The original files remain reachable.
    const asset = await app.fetch(new Request(`http://share.test/content/${payload.id}/app.js`));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("no index");
  });

  test("generates an entry chooser for a zip with multiple html entries and no index", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "alpha.html", data: "<h1>Alpha</h1>" },
      { name: "beta.html", data: "<h1>Beta</h1>" },
    ]);

    const response = await uploadFile(app, new File([zip], "multi.zip", { type: "application/zip" }));
    expect(response.status).toBe(201);
    const payload = await response.json();

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    const html = await index.text();
    expect(html).toContain("Entry points");
    expect(html).toContain("alpha.html");
    expect(html).toContain("beta.html");

    const alpha = await app.fetch(new Request(`http://share.test/content/${payload.id}/alpha.html`));
    expect(await alpha.text()).toContain("Alpha");
  });

  test("generates an index for multi-file uploads without an index", async () => {
    const { app } = await testApp();
    const response = await uploadFiles(app, [
      new File(["<h1>One</h1>"], "one.html", { type: "text/html" }),
      new File(["<h1>Two</h1>"], "two.html", { type: "text/html" }),
    ]);

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.resources.map((resource: { path: string }) => resource.path)).toContain("index.html");

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    const html = await index.text();
    expect(html).toContain("one.html");
    expect(html).toContain("two.html");
  });

  test("escapes hostile file names in the generated index", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "x<script>evil.js", data: "1" },
      { name: "b.css", data: "2" },
    ]);

    const response = await uploadFile(app, new File([zip], "x.zip", { type: "application/zip" }));
    const payload = await response.json();
    const html = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    // The hostile name must be HTML-escaped, never injected as raw markup.
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil");
  });

  test("rejects zip archives with path traversal", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "index.html", data: "<h1>ok</h1>" },
      { name: "../escape.txt", data: "bad" },
    ]);

    const response = await uploadFile(app, new File([zip], "traversal.zip", { type: "application/zip" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "unsafe_archive_path" });
  });

  test("rejects zip archives containing symlinks", async () => {
    const { app } = await testApp();
    const zip = makeZip([
      { name: "index.html", data: "<h1>ok</h1>" },
      { name: "linked", data: "index.html", externalAttributes: (0o120777 << 16) >>> 0, versionMadeBy: (3 << 8) | 20 },
    ]);

    const response = await uploadFile(app, new File([zip], "symlink.zip", { type: "application/zip" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "symlink_archive" });
  });

  test("rejects oversized uploads", async () => {
    const { app } = await testApp({ MAX_UPLOAD_BYTES: "10" });
    const response = await uploadFile(app, new File(["01234567890"], "index.html", { type: "text/html" }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "upload_too_large" });
  });

  test("requires an upload token when configured", async () => {
    const { app } = await testApp({ UPLOAD_TOKEN: "secret" });
    const file = new File(["<h1>token</h1>"], "index.html", { type: "text/html" });

    const rejected = await uploadFile(app, file);
    expect(rejected.status).toBe(401);

    const accepted = await uploadFile(app, file, { token: "secret" });
    expect(accepted.status).toBe(201);
  });

  test("requires the edit token to patch and delete resources", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>editable</h1>"], "index.html", { type: "text/html" }), {
      editToken: "edit-secret",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.editToken).toBe("edit-secret");

    const rejected = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources/style.css`, {
        method: "PATCH",
        body: "body { color: red; }",
      }),
    );
    expect(rejected.status).toBe(401);

    const patched = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources/style.css`, {
        method: "PATCH",
        headers: { authorization: "Bearer edit-secret", "content-type": "text/css" },
        body: "body { color: green; }",
      }),
    );
    expect(patched.status).toBe(200);
    const patchPayload = await patched.json();
    expect(patchPayload.revision).toBe(2);
    expect(patchPayload.resources.map((resource: { path: string }) => resource.path)).toEqual(["index.html", "style.css"]);

    const style = await app.fetch(new Request(`http://share.test/content/${payload.id}/style.css`));
    expect(style.status).toBe(200);
    expect(await style.text()).toContain("color: green");

    const deleteIndex = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources/index.html`, {
        method: "DELETE",
        headers: { authorization: "Bearer edit-secret" },
      }),
    );
    expect(deleteIndex.status).toBe(400);
    expect(await deleteIndex.json()).toMatchObject({ code: "missing_index" });

    const deleted = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources/style.css`, {
        method: "DELETE",
        headers: { authorization: "Bearer edit-secret" },
      }),
    );
    expect(deleted.status).toBe(200);
    const deletePayload = await deleted.json();
    expect(deletePayload.revision).toBe(3);
    expect(deletePayload.resources.map((resource: { path: string }) => resource.path)).toEqual(["index.html"]);
  });

  test("revalidates cached content after resource patches", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>first</h1>"], "index.html", { type: "text/html" }), {
      editToken: "cache-secret",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();

    const first = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const cached = await app.fetch(
      new Request(`http://share.test/content/${payload.id}/`, {
        headers: { "if-none-match": etag ?? "" },
      }),
    );
    expect(cached.status).toBe(304);

    const patched = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources/index.html`, {
        method: "PATCH",
        headers: { authorization: "Bearer cache-secret", "content-type": "text/html" },
        body: "<h1>second</h1>",
      }),
    );
    expect(patched.status).toBe(200);

    const second = await app.fetch(
      new Request(`http://share.test/content/${payload.id}/`, {
        headers: { "if-none-match": etag ?? "" },
      }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    expect(await second.text()).toContain("second");
  });

  test("omits upload token field when uploads are public", async () => {
    const { app } = await testApp({ MAX_UPLOAD_BYTES: String(10 * 1024 * 1024) });
    const response = await app.fetch(new Request("http://share.test/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("up to 10 MB");
    expect(html).not.toContain("tokenInput");
  });

  test("checks upload token without requiring multipart body", async () => {
    const { app } = await testApp({ UPLOAD_TOKEN: "secret" });

    const rejected = await app.fetch(new Request("http://share.test/api/auth-check"));
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ code: "unauthorized" });

    const accepted = await app.fetch(
      new Request("http://share.test/api/auth-check", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, tokenRequired: true });
  });

  test("rate limits upload creation by client IP", async () => {
    const { app } = await testApp({ UPLOAD_RATE_LIMIT_MAX: "1" });
    const first = await uploadFile(app, new File(["<h1>one</h1>"], "one.html", { type: "text/html" }));
    expect(first.status).toBe(201);

    const second = await uploadFile(app, new File(["<h1>two</h1>"], "two.html", { type: "text/html" }));
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "rate_limit_exceeded" });
  });

  test("expired uploads do not serve viewer or content and cleanup deletes files", async () => {
    const { app, config } = await testApp({ RETENTION_DAYS: "0" });
    const response = await uploadFile(app, new File(["<h1>expired</h1>"], "index.html", { type: "text/html" }));
    expect(response.status).toBe(201);
    const payload = await response.json();

    const viewer = await app.fetch(new Request(payload.viewerUrl));
    expect(viewer.status).toBe(410);

    const content = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(content.status).toBe(410);

    await app.runCleanupOnce();
    expect(existsSync(join(config.storageDir, payload.id))).toBe(false);
    expect(app.repo.findById(payload.id)?.status).toBe("deleted");
  });

  test("serves content through a configured content origin", async () => {
    const { app } = await testApp({ CONTENT_BASE_URL: "http://content.test" });
    const response = await uploadFile(app, new File(["<h1>origin</h1>"], "index.html", { type: "text/html" }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.contentUrl).toBe(`http://content.test/${payload.id}/`);

    const content = await app.fetch(new Request(`http://content.test/${payload.id}/`));
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("origin");
  });

  test("serves the opt-in inspector SDK on the public origin", async () => {
    const { app } = await testApp();
    const response = await app.fetch(new Request("http://share.test/sdk/see-inspect.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    const body = await response.text();
    expect(body).toContain("see-inspect");
    expect(body).toContain("data-see-inspectable");
  });

  test("viewer exposes the content origin and allows display-capture", async () => {
    const { app } = await testApp();
    const payload = await (
      await uploadFile(app, new File(["<h1>x</h1>"], "index.html", { type: "text/html" }))
    ).json();

    const viewer = await app.fetch(new Request(payload.viewerUrl));
    expect(viewer.headers.get("permissions-policy")).toContain("display-capture=(self)");
    expect(await viewer.text()).toContain('data-content-origin="http://share.test"');
  });

  test("viewer content origin reflects a configured content origin", async () => {
    const { app } = await testApp({ CONTENT_BASE_URL: "http://content.test" });
    const payload = await (
      await uploadFile(app, new File(["<h1>x</h1>"], "index.html", { type: "text/html" }))
    ).json();

    const viewer = await app.fetch(new Request(payload.viewerUrl));
    expect(await viewer.text()).toContain('data-content-origin="http://content.test"');
  });

  test("GET /api/uploads/:id/settings returns defaults for a password-protected upload", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>Settings</h1>"], "index.html", { type: "text/html" }), {
      editToken: "pw",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();

    const settings = await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/settings`));
    expect(settings.status).toBe(200);
    const body = await settings.json();
    expect(body.passwordRequired).toBe(true);
    expect(body.homepage).toBe(null);
    expect(body.exposed).toEqual([]);
    expect(body.barDefault).toBe(true);
    expect(body.htmlPages).toContain("index.html");
  });

  test("PATCH settings requires auth when password is set, succeeds with correct token", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>pw</h1>"], "index.html", { type: "text/html" }), {
      editToken: "pw",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();

    // Rejected without auth
    const rejected = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ barDefault: false }),
      }),
    );
    expect(rejected.status).toBe(401);

    // Succeeds with correct auth
    const patched = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { authorization: "Bearer pw", "content-type": "application/json" },
        body: JSON.stringify({ homepage: "index.html", exposed: ["index.html"], barDefault: false }),
      }),
    );
    expect(patched.status).toBe(200);
    const patchBody = await patched.json();
    expect(patchBody.homepage).toBe("index.html");
    expect(patchBody.exposed).toEqual(["index.html"]);
    expect(patchBody.barDefault).toBe(false);

    // Subsequent GET reflects the changes
    const settings = await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/settings`));
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json();
    expect(settingsBody.homepage).toBe("index.html");
    expect(settingsBody.exposed).toEqual(["index.html"]);
    expect(settingsBody.barDefault).toBe(false);
  });

  test("PATCH settings with password:'' clears password and allows unauthenticated edits", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>clear pw</h1>"], "index.html", { type: "text/html" }), {
      editToken: "oldpw",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();

    // Clear the password
    const cleared = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { authorization: "Bearer oldpw", "content-type": "application/json" },
        body: JSON.stringify({ password: "" }),
      }),
    );
    expect(cleared.status).toBe(200);

    // GET now shows passwordRequired:false
    const settings = await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/settings`));
    const settingsBody = await settings.json();
    expect(settingsBody.passwordRequired).toBe(false);

    // PATCH without auth now succeeds (public edit)
    const noAuth = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ barDefault: false }),
      }),
    );
    expect(noAuth.status).toBe(200);
    expect((await noAuth.json()).barDefault).toBe(false);
  });

  test("homepage serving: PATCH homepage redirects root content request to the specified page", async () => {
    const { app } = await testApp();
    const response = await uploadFiles(app, [
      new File(["<h1>Index</h1>"], "index.html", { type: "text/html" }),
      new File(["<h1>About</h1>"], "about.html", { type: "text/html" }),
    ]);
    expect(response.status).toBe(201);
    const payload = await response.json();

    // Set homepage to about.html
    const patched = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${payload.editToken}`, "content-type": "application/json" },
        body: JSON.stringify({ homepage: "about.html" }),
      }),
    );
    expect(patched.status).toBe(200);

    // GET /content/:id/ should now serve about.html content
    const content = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("About");
  });

  test("PATCH settings rejects homepage that is not an existing HTML page", async () => {
    const { app } = await testApp();
    const response = await uploadFile(app, new File(["<h1>x</h1>"], "index.html", { type: "text/html" }), {
      editToken: "pw",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();

    const rejected = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { authorization: "Bearer pw", "content-type": "application/json" },
        body: JSON.stringify({ homepage: "notexist.html" }),
      }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: "invalid_setting" });
  });

  test("viewer page HTML contains data-bar-default='true' by default", async () => {
    const { app } = await testApp();
    const payload = await (
      await uploadFile(app, new File(["<h1>bar</h1>"], "index.html", { type: "text/html" }))
    ).json();

    const viewer = await app.fetch(new Request(payload.viewerUrl));
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain('data-bar-default="true"');
  });
});

async function testApp(env: Record<string, string> = {}): Promise<{ app: StaticShareApp; dir: string; config: AppConfig }> {
  const dir = await mkdtemp(join(tmpdir(), "static-share-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    PUBLIC_BASE_URL: "http://share.test",
    DATABASE_URL: `sqlite:${join(dir, "app.db")}`,
    STORAGE_DIR: join(dir, "uploads"),
    CLEANUP_INTERVAL_SECONDS: "0",
    UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "60",
    UPLOAD_RATE_LIMIT_MAX: "100",
    ...env,
  });
  const app = createApp(config);
  cleanup.push(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, dir, config };
}

async function uploadFile(
  app: StaticShareApp,
  file: File,
  options: { title?: string; token?: string; editToken?: string } = {},
): Promise<Response> {
  return uploadFiles(app, [file], options);
}

async function uploadFiles(
  app: StaticShareApp,
  files: File[],
  options: { title?: string; token?: string; editToken?: string } = {},
): Promise<Response> {
  const formData = new FormData();
  files.forEach((file) => formData.append("file", file));
  if (options.title) {
    formData.set("title", options.title);
  }
  if (options.editToken) {
    formData.set("editToken", options.editToken);
  }
  const headers = new Headers({ "x-forwarded-for": "203.0.113.10" });
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  return app.fetch(
    new Request("http://share.test/api/uploads", {
      method: "POST",
      headers,
      body: formData,
    }),
  );
}

type ZipTestEntry = {
  name: string;
  data: string | Uint8Array;
  method?: 0 | 8;
  externalAttributes?: number;
  versionMadeBy?: number;
};

function makeZip(entries: ZipTestEntry[]): ArrayBuffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const input = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(input) : input;
    const flags = 0x0800;
    const versionMadeBy = entry.versionMadeBy ?? 20;
    const externalAttributes = entry.externalAttributes ?? 0;

    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(input.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(input.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const output = Buffer.concat([...localParts, centralDirectory, eocd]);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}
