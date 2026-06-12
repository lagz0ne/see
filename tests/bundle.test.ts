import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type StaticShareApp } from "../src/app";
import { loadConfig } from "../src/config";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    await cleanup.pop()?.();
  }
});

const INDEX_HTML =
  '<!doctype html><html><head><style>:root{--color-primary:#000}</style></head>' +
  '<body><div class="hero">Hi</div></body></html>';

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    homepage: "index.html",
    exposed: ["index.html"],
    bar: false,
    capabilities: ["inspect", "tweaks"],
    tweaks: {
      primaryColor: { kind: "color", value: "#D97757", cssVar: "--color-primary", label: "Primary" },
    },
    inspect: [{ selector: ".hero", id: "hero", label: "Hero" }],
    ...extra,
  });
}

function indexFile(): File {
  return new File([INDEX_HTML], "index.html", { type: "text/html" });
}

function manifestFile(body: string): File {
  return new File([body], "see.json", { type: "application/json" });
}

describe("bundles", () => {
  test("an upload with a root see.json becomes a bundle and derives workspace settings", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    expect(payload.kind).toBe("bundle");

    const settings = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/settings`))
    ).json();
    expect(settings.homepage).toBe("index.html");
    expect(settings.exposed).toEqual(["index.html"]);
    expect(settings.barDefault).toBe(false);
    expect(settings.tweaks).toEqual({ primaryColor: "#D97757" });
  });

  test("a bundle's HTML is served with the injected SDK + __SEE_BUNDLE__ config", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    const content = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(content.status).toBe(200);
    const html = await content.text();
    expect(html).toContain("window.__SEE_BUNDLE__");
    expect(html).toContain("http://share.test/sdk/see-inspect.js");
    expect(html).toContain('"capabilities"');
    expect(html).toContain("#D97757");
    // Original markup is preserved.
    expect(html).toContain('<div class="hero">Hi</div>');

    // The manifest file itself is served raw, never rewritten.
    const raw = await app.fetch(new Request(`http://share.test/content/${payload.id}/see.json`));
    expect(await raw.text()).not.toContain("__SEE_BUNDLE__");
  });

  test("a non-bundle upload's HTML is served byte-for-byte unchanged", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile()])).json();
    expect(payload.kind).not.toBe("bundle");

    const html = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    expect(html).toBe(INDEX_HTML);
  });

  test("an invalid see.json rejects the upload with 400 invalid_manifest", async () => {
    const { app } = await testApp();

    const badSchema = await uploadFiles(app, [indexFile(), manifestFile(JSON.stringify({ capabilities: ["bogus"] }))]);
    expect(badSchema.status).toBe(400);
    expect((await badSchema.json()).code).toBe("invalid_manifest");

    const badJson = await uploadFiles(app, [indexFile(), manifestFile("{ not json")]);
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).code).toBe("invalid_manifest");

    const badHomepage = await uploadFiles(app, [indexFile(), manifestFile(manifest({ homepage: "missing.html" }))]);
    expect(badHomepage.status).toBe(400);
    expect((await badHomepage.json()).code).toBe("invalid_manifest");
  });

  test("patching see.json re-derives settings, bumps the revision, and live-reloads viewers", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    // Subscribe to the live event stream before patching.
    const events = await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/events`));
    const reader = events.body!.getReader();
    await reader.read(); // initial revision event

    const patch = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/patch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({
          ops: [{ file: "see.json", pointer: "/tweaks/primaryColor/value", action: "set", value: "#0A84FF" }],
        }),
      }),
    );
    expect(patch.status).toBe(200);
    const patchPayload = await patch.json();
    expect(patchPayload.revision).toBe(2);

    // The derived value updated...
    const settings = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/settings`))
    ).json();
    expect(settings.tweaks).toEqual({ primaryColor: "#0A84FF" });

    // ...the injected config reflects it...
    const html = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    expect(html).toContain("#0A84FF");

    // ...and an SSE update fired.
    const next = await reader.read();
    expect(new TextDecoder().decode(next.value as Uint8Array)).toContain('"revision":2');
    await reader.cancel();
  });

  test("patching see.json into an invalid manifest is rejected 422 and writes nothing", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    const patch = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/patch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({
          ops: [{ file: "see.json", pointer: "/capabilities", action: "set", value: ["bogus"] }],
        }),
      }),
    );
    expect(patch.status).toBe(422);
    expect((await patch.json()).code).toBe("invalid_manifest");

    // Revision unchanged — nothing was written.
    const meta = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}`))).json();
    expect(meta.revision).toBe(1);
  });

  test("Settings PATCH on a bundle rejects manifest-owned fields but allows password", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    const rejected = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({ homepage: "index.html" }),
      }),
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).code).toBe("bundle_managed");

    const passwordOk = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({ password: "newpw" }),
      }),
    );
    expect(passwordOk.status).toBe(200);
    expect((await passwordOk.json()).passwordRequired).toBe(true);
  });
});

async function testApp(env: Record<string, string> = {}): Promise<{ app: StaticShareApp }> {
  const dir = await mkdtemp(join(tmpdir(), "bundle-test-"));
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
  return { app };
}

async function uploadFiles(
  app: StaticShareApp,
  files: File[],
  options: { editToken?: string } = {},
): Promise<Response> {
  const formData = new FormData();
  files.forEach((file) => formData.append("file", file));
  if (options.editToken) {
    formData.set("editToken", options.editToken);
  }
  return app.fetch(
    new Request("http://share.test/api/uploads", {
      method: "POST",
      headers: new Headers({ "x-forwarded-for": "203.0.113.10" }),
      body: formData,
    }),
  );
}
