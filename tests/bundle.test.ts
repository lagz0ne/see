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
    tweaks: {
      primaryColor: { kind: "color", value: "#D97757", cssVar: "--color-primary", label: "Primary" },
    },
    ...extra,
  });
}

function indexFile(): File {
  return new File([INDEX_HTML], "index.html", { type: "text/html" });
}

function htmlFile(name: string, body: string): File {
  return new File([body], name, { type: "text/html" });
}

function manifestFile(body: string): File {
  return new File([body], "see.json", { type: "application/json" });
}

// Extracts the contents of the INJECTED <style>:root{ ... }</style> block.
// The injected block is emitted as `<style>:root{ <decls> }</style>` (note the
// space after `{`), which distinguishes it from any pre-existing `:root` style
// already present in the source HTML fixture.
function rootStyle(html: string): string {
  const match = html.match(/<style>:root\{ ([^]*?) \}<\/style>/);
  return match ? match[1] : "";
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

  test("a bundle's HTML is served with the static cssVar style injected", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    const content = await app.fetch(new Request(`http://share.test/content/${payload.id}/`));
    expect(content.status).toBe(200);
    const html = await content.text();
    // Static <style> block must be present with the cssVar and tweak value.
    expect(html).toContain("<style");
    expect(html).toContain("--color-primary");
    expect(html).toContain("#D97757");
    // Original markup is preserved.
    expect(html).toContain('<div class="hero">Hi</div>');

    // The manifest file itself is served raw, never rewritten.
    const raw = await app.fetch(new Request(`http://share.test/content/${payload.id}/see.json`));
    expect(await raw.text()).not.toContain("<style");
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

    // A tweak entry missing the required "value" field is rejected.
    const badTweak = await uploadFiles(app, [indexFile(), manifestFile(JSON.stringify({ tweaks: { primary: { cssVar: "--color-primary" } } }))]);
    expect(badTweak.status).toBe(400);
    expect((await badTweak.json()).code).toBe("invalid_manifest");

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

    // Setting a tweak's value to an object (invalid — must be a primitive) causes a validation failure.
    const patch = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/patch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({
          ops: [{ file: "see.json", pointer: "/tweaks/primaryColor/value", action: "set", value: { nested: true } }],
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

  test("per-page tweak override injects the page value on the overridden page and the shared value elsewhere", async () => {
    const { app } = await testApp();
    const see = manifest({
      exposed: ["index.html", "pricing.html"],
      pages: {
        "pricing.html": {
          tweaks: {
            primaryColor: { value: "#0A84FF" },
          },
        },
      },
    });
    const payload = await (
      await uploadFiles(
        app,
        [
          indexFile(),
          htmlFile("pricing.html", "<!doctype html><html><head></head><body><h1>Pricing</h1></body></html>"),
          manifestFile(see),
        ],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    // The overridden page emits the page's value for the overridden id.
    const pricing = await app.fetch(new Request(`http://share.test/content/${payload.id}/pricing.html`));
    expect(pricing.status).toBe(200);
    const pricingStyle = rootStyle(await pricing.text());
    expect(pricingStyle).toContain("--color-primary: #0A84FF");
    expect(pricingStyle).not.toContain("#D97757");

    // The non-overridden page emits the shared value.
    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/index.html`));
    expect(index.status).toBe(200);
    const indexStyle = rootStyle(await index.text());
    expect(indexStyle).toContain("--color-primary: #D97757");
    expect(indexStyle).not.toContain("#0A84FF");
  });

  test("a value-only page override inherits the shared cssVar and unit", async () => {
    const { app } = await testApp();
    const see = manifest({
      exposed: ["index.html", "pricing.html"],
      tweaks: {
        primaryColor: { kind: "color", value: "#D97757", cssVar: "--color-primary", label: "Primary" },
        fontSize: { kind: "number", value: 16, cssVar: "--font-size-base", unit: "px", label: "Font size" },
      },
      pages: {
        "pricing.html": {
          tweaks: {
            // Value-only override — cssVar/unit are inherited from the shared fontSize def.
            fontSize: { value: 20 },
          },
        },
      },
    });
    const payload = await (
      await uploadFiles(
        app,
        [
          indexFile(),
          htmlFile("pricing.html", "<!doctype html><html><head></head><body><h1>Pricing</h1></body></html>"),
          manifestFile(see),
        ],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    const pricing = await app.fetch(new Request(`http://share.test/content/${payload.id}/pricing.html`));
    const pricingStyle = rootStyle(await pricing.text());
    // Inherited cssVar + unit, page-overridden value.
    expect(pricingStyle).toContain("--font-size-base: 20px");

    // The non-overridden page keeps the shared value.
    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/index.html`));
    const indexStyle = rootStyle(await index.text());
    expect(indexStyle).toContain("--font-size-base: 16px");
  });

  test("a page-only knob is injected only on its page and absent elsewhere", async () => {
    const { app } = await testApp();
    const see = manifest({
      exposed: ["index.html", "pricing.html"],
      pages: {
        "pricing.html": {
          tweaks: {
            // A page-only knob with its own cssVar, not present in the shared set.
            accent: { kind: "color", value: "#22C55E", cssVar: "--color-accent", label: "Accent" },
          },
        },
      },
    });
    const payload = await (
      await uploadFiles(
        app,
        [
          indexFile(),
          htmlFile("pricing.html", "<!doctype html><html><head></head><body><h1>Pricing</h1></body></html>"),
          manifestFile(see),
        ],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    const pricing = await app.fetch(new Request(`http://share.test/content/${payload.id}/pricing.html`));
    const pricingStyle = rootStyle(await pricing.text());
    expect(pricingStyle).toContain("--color-accent: #22C55E");

    const index = await app.fetch(new Request(`http://share.test/content/${payload.id}/index.html`));
    const indexStyle = rootStyle(await index.text());
    expect(indexStyle).not.toContain("--color-accent");
    expect(indexStyle).not.toContain("#22C55E");
  });

  test("a pages key pointing at a non-existent HTML page is rejected on upload with 400 invalid_manifest", async () => {
    const { app } = await testApp();
    const bad = await uploadFiles(
      app,
      [
        indexFile(),
        manifestFile(
          manifest({
            pages: {
              "missing.html": {
                tweaks: { primaryColor: { value: "#0A84FF" } },
              },
            },
          }),
        ),
      ],
      { editToken: "pw" },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid_manifest");
  });

  test("patching a page tweak value updates only that page, leaving shared and other pages unchanged, and bumps the revision", async () => {
    const { app } = await testApp();
    const see = manifest({
      exposed: ["index.html", "pricing.html"],
      pages: {
        "pricing.html": {
          tweaks: { primaryColor: { value: "#0A84FF" } },
        },
      },
    });
    const payload = await (
      await uploadFiles(
        app,
        [
          indexFile(),
          htmlFile("pricing.html", "<!doctype html><html><head></head><body><h1>Pricing</h1></body></html>"),
          manifestFile(see),
        ],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    // Patch ONLY pricing.html's page tweak value.
    const patch = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/patch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({
          ops: [{ file: "see.json", pointer: "/pages/pricing.html/tweaks/primaryColor/value", action: "set", value: "#16A34A" }],
        }),
      }),
    );
    expect(patch.status).toBe(200);
    expect((await patch.json()).revision).toBe(2);

    // The overridden page reflects the new page value...
    const pricingStyle = rootStyle(
      await (await app.fetch(new Request(`http://share.test/content/${payload.id}/pricing.html`))).text(),
    );
    expect(pricingStyle).toContain("--color-primary: #16A34A");

    // ...the shared default and the inheriting page are untouched.
    const indexStyle = rootStyle(
      await (await app.fetch(new Request(`http://share.test/content/${payload.id}/index.html`))).text(),
    );
    expect(indexStyle).toContain("--color-primary: #D97757");

    // Patching the SHARED value changes the inheriting page but NOT the page that overrides it.
    const sharedPatch = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/patch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({
          ops: [{ file: "see.json", pointer: "/tweaks/primaryColor/value", action: "set", value: "#A21CAF" }],
        }),
      }),
    );
    expect(sharedPatch.status).toBe(200);
    expect((await sharedPatch.json()).revision).toBe(3);

    const indexAfter = rootStyle(
      await (await app.fetch(new Request(`http://share.test/content/${payload.id}/index.html`))).text(),
    );
    expect(indexAfter).toContain("--color-primary: #A21CAF");

    const pricingAfter = rootStyle(
      await (await app.fetch(new Request(`http://share.test/content/${payload.id}/pricing.html`))).text(),
    );
    // The page override still wins; the shared change does not leak through.
    expect(pricingAfter).toContain("--color-primary: #16A34A");
    expect(pricingAfter).not.toContain("#A21CAF");
  });

  test("adding a root see.json to a plain share upgrades it to a bundle and injects tweaks", async () => {
    const { app } = await testApp();
    // A plain single-HTML share starts as kind "html", no injection.
    const payload = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    expect(payload.kind).toBe("html");

    const before = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    // No injected (space-prefixed) :root block before the manifest is added.
    expect(rootStyle(before)).toBe("");

    // Add see.json via the resource API.
    const add = await addResources(app, payload.id, [manifestFile(manifest())], { token: "pw" });
    expect(add.status).toBe(200);

    // The share is now a bundle...
    const meta = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}`))).json();
    expect(meta.kind).toBe("bundle");

    // ...and the served HTML now carries the injected cssVar style.
    const after = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    expect(rootStyle(after)).toContain("--color-primary: #D97757");
  });

  test("adding an invalid see.json via the resource API is rejected and leaves the kind unchanged", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    expect(payload.kind).toBe("html");

    // homepage pointing at a page that does not exist must fail loudly.
    const bad = await addResources(
      app,
      payload.id,
      [manifestFile(manifest({ homepage: "missing.html" }))],
      { token: "pw" },
    );
    expect([400, 422]).toContain(bad.status);
    expect((await bad.json()).code).toBe("invalid_manifest");

    // Malformed JSON is likewise rejected.
    const badJson = await addResources(app, payload.id, [manifestFile("{ not json")], { token: "pw" });
    expect([400, 422]).toContain(badJson.status);
    expect((await badJson.json()).code).toBe("invalid_manifest");

    // The share stays a plain html share — never half-upgraded to a broken bundle.
    const meta = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}`))).json();
    expect(meta.kind).toBe("html");
  });

  test("replacing see.json via a non-canonical path still strict-validates the manifest", async () => {
    const { app } = await testApp();
    // A plain single-HTML share — kind "html", not a bundle.
    const payload = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    expect(payload.kind).toBe("html");

    // Each vector encodes a path the writer canonicalizes to root "see.json": leading "./",
    // trailing "/", and surrounding whitespace. A malformed body through ANY of them must be
    // rejected by the strict-validation guard — not silently written into a broken bundle.
    const vectors = [".%2Fsee.json", "see.json%2F", "%20see.json%20"];
    for (const vector of vectors) {
      const res = await app.fetch(
        new Request(`http://share.test/api/uploads/${payload.id}/resources/${vector}`, {
          method: "PUT",
          headers: { authorization: "Bearer pw", "content-type": "application/json" },
          body: "{ not valid json",
        }),
      );
      expect([400, 422]).toContain(res.status);
      expect((await res.json()).code).toBe("invalid_manifest");

      // The share stays a plain html share — never half-upgraded to a broken bundle.
      const meta = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}`))).json();
      expect(meta.kind).toBe("html");
    }
  });

  test("a batch patch targeting see.json via a non-canonical path still strict-validates", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();
    expect(payload.kind).toBe("bundle");

    // Patch the manifest through a non-canonical alias ("./see.json") with a value that makes the
    // manifest invalid (homepage at a non-existent page). The guard must canonicalize the op's
    // file to root see.json and reject loudly — not persist an invalid manifest.
    const res = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/patch`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer pw" },
        body: JSON.stringify({
          ops: [{ file: "./see.json", pointer: "/homepage", action: "set", value: "missing.html" }],
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_manifest");

    // The manifest was not mutated — the share still injects its original tweak.
    const style = rootStyle(
      await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text(),
    );
    expect(style).toContain("--color-primary: #D97757");
  });

  test("adding see.json via multipart with a whitespace path still strict-validates the manifest", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    expect(payload.kind).toBe("html");

    // path " see.json " is trimmed to root see.json by the writer; the multipart guard must
    // canonicalize the same way and reject the malformed manifest rather than upgrade the share.
    const formData = new FormData();
    formData.append("file", new File(["{ not valid json"], "x.json", { type: "application/json" }));
    formData.set("path", " see.json ");
    const res = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources`, {
        method: "POST",
        headers: { authorization: "Bearer pw" },
        body: formData,
      }),
    );
    expect([400, 422]).toContain(res.status);
    expect((await res.json()).code).toBe("invalid_manifest");

    const meta = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}`))).json();
    expect(meta.kind).toBe("html");
  });

  test("deleting a bundle's see.json downgrades it to a resources share and stops injecting", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();
    expect(payload.kind).toBe("bundle");

    const before = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    expect(rootStyle(before)).toContain("--color-primary: #D97757");

    const del = await app.fetch(
      new Request(`http://share.test/api/uploads/${payload.id}/resources/see.json`, {
        method: "DELETE",
        headers: { authorization: "Bearer pw" },
      }),
    );
    expect(del.status).toBe(200);

    const meta = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}`))).json();
    expect(meta.kind).not.toBe("bundle");
    expect(meta.kind).toBe("resources");

    const after = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    // Injection stops once the manifest is gone (the raw fixture :root has no space).
    expect(rootStyle(after)).toBe("");
  });

  test("GET /tweaks returns the resolved per-page tweak set (defs + value + source)", async () => {
    const { app } = await testApp();
    const see = manifest({
      exposed: ["index.html", "pricing.html"],
      pages: { "pricing.html": { tweaks: { primaryColor: { value: "#0A84FF" } } } },
    });
    const payload = await (
      await uploadFiles(
        app,
        [
          indexFile(),
          htmlFile("pricing.html", "<!doctype html><html><head></head><body><h1>Pricing</h1></body></html>"),
          manifestFile(see),
        ],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    // No ?page → defaults to the homepage; primaryColor inherits the shared value.
    const home = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks`))).json();
    expect(home.page).toBe("index.html");
    const homeTweak = home.tweaks.find((t: { id: string }) => t.id === "primaryColor");
    expect(homeTweak).toMatchObject({ cssVar: "--color-primary", value: "#D97757", valueSource: "shared", kind: "color" });

    // pricing.html overrides the value → valueSource "page", inheriting the shared cssVar.
    const pricing = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks?page=pricing.html`))
    ).json();
    expect(pricing.page).toBe("pricing.html");
    const pricingTweak = pricing.tweaks.find((t: { id: string }) => t.id === "primaryColor");
    expect(pricingTweak).toMatchObject({ value: "#0A84FF", valueSource: "page", cssVar: "--color-primary" });

    // A plain (non-bundle) share has no tweaks.
    const plain = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    const plainTweaks = await (await app.fetch(new Request(`http://share.test/api/uploads/${plain.id}/tweaks`))).json();
    expect(plainTweaks.tweaks).toEqual([]);
  });

  test("GET /tweaks without ?page matches the served root even when homepage is omitted", async () => {
    const { app } = await testApp();
    // No `homepage`: the content route serves the root index.html and applies its page override.
    const see = JSON.stringify({
      exposed: ["index.html"],
      tweaks: { primaryColor: { kind: "color", value: "#D97757", cssVar: "--color-primary", label: "Primary" } },
      pages: { "index.html": { tweaks: { primaryColor: { value: "#FF0000" } } } },
    });
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(see)], { editToken: "pw" })).json();
    expect(payload.kind).toBe("bundle");

    // The served root applies index.html's page override...
    const rootHtml = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/`))).text();
    expect(rootStyle(rootHtml)).toContain("--color-primary: #FF0000");

    // ...and GET /tweaks (no ?page) reports the SAME page override, not the shared default.
    const tweaks = await (await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks`))).json();
    expect(tweaks.page).toBe("index.html");
    const t = tweaks.tweaks.find((x: { id: string }) => x.id === "primaryColor");
    expect(t).toMatchObject({ value: "#FF0000", valueSource: "page" });
  });

  test("GET /tweaks resolves a canonicalized/SPA page to the served document (agrees with injected HTML)", async () => {
    const { app } = await testApp();
    const see = JSON.stringify({
      homepage: "index.html",
      exposed: ["index.html"],
      tweaks: { primaryColor: { kind: "color", value: "#D97757", cssVar: "--color-primary", label: "Primary" } },
      pages: { "index.html": { tweaks: { primaryColor: { value: "#123456" } } } },
    });
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(see)], { editToken: "pw" })).json();

    // A client route with no backing file SPA-falls-back to index.html, which carries a page override.
    const served = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/some/client/route`))).text();
    const servedColor = rootStyle(served).match(/--color-primary: (#[0-9a-fA-F]+)/)?.[1];
    expect(servedColor).toBe("#123456");

    // ?page= for that same route must resolve to the SAME key and report the SAME value, not shared.
    const tweaks = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks?page=some%2Fclient%2Froute`))
    ).json();
    const t = tweaks.tweaks.find((x: { id: string }) => x.id === "primaryColor");
    expect(t.value).toBe(servedColor);
    expect(t.valueSource).toBe("page");
  });

  test("GET /tweaks resolves a page with a literal % (no double-decode), matching the content route", async () => {
    const { app } = await testApp();
    const pagePath = "100%.html";
    const see = JSON.stringify({
      homepage: "index.html",
      exposed: ["index.html", pagePath],
      tweaks: { primaryColor: { kind: "color", value: "#D97757", cssVar: "--color-primary", label: "Primary" } },
      pages: { [pagePath]: { tweaks: { primaryColor: { value: "#ABCDEF" } } } },
    });
    const payload = await (
      await uploadFiles(
        app,
        [indexFile(), htmlFile(pagePath, "<!doctype html><html><head></head><body>100%</body></html>"), manifestFile(see)],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    // Served at the percent-encoded URL with its page override...
    const served = await (await app.fetch(new Request(`http://share.test/content/${payload.id}/100%25.html`))).text();
    expect(rootStyle(served)).toContain("--color-primary: #ABCDEF");

    // ...and the endpoint resolves the same key without double-decoding (200, not 400 invalid_path).
    const res = await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks?page=100%25.html`));
    expect(res.status).toBe(200);
    const tweaks = await res.json();
    expect(tweaks.page).toBe("100%.html");
    const t = tweaks.tweaks.find((x: { id: string }) => x.id === "primaryColor");
    expect(t).toMatchObject({ value: "#ABCDEF", valueSource: "page" });
  });

  test("GET /tweaks/discover proposes :root tokens from CSS, flagging already-exposed ones", async () => {
    const { app } = await testApp();
    // --color-primary comes from index.html's inline <style> (the INDEX_HTML fixture); keep it out of
    // this file so it isn't a cascade-ambiguous duplicate. The default manifest exposes it.
    const css = ":root { --font-size-base: 16px; --gap: 8px; --accent: oklch(0.7 0.15 60); }";
    const payload = await (
      await uploadFiles(
        app,
        [
          indexFile(),
          new File([css], "styles.css", { type: "text/css" }),
          // A CSS file with a literal % in its name must not 400 the discover request.
          new File([":root { --pct: 50%; }"], "100%.css", { type: "text/css" }),
          manifestFile(manifest()),
        ],
        { editToken: "pw" },
      )
    ).json();
    expect(payload.kind).toBe("bundle");

    const res = await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks/discover`));
    expect(res.status).toBe(200);
    const { candidates } = await res.json();
    const byVar: Record<string, { exposed: boolean; kind: string; value: unknown; unit?: string }> = Object.fromEntries(
      candidates.map((c: { cssVar: string }) => [c.cssVar, c]),
    );

    // Already a tweak (manifest primaryColor) → flagged exposed; the others are new and inferred.
    expect(byVar["--color-primary"]).toMatchObject({ exposed: true, kind: "color" });
    expect(byVar["--font-size-base"]).toMatchObject({ exposed: false, kind: "number", unit: "px", value: 16 });
    expect(byVar["--gap"]).toMatchObject({ exposed: false, kind: "number", value: 8 });
    expect(byVar["--accent"]).toMatchObject({ exposed: false, kind: "color" }); // oklch recognized as color
    expect(byVar["--pct"]).toMatchObject({ kind: "number", unit: "%" }); // scanned from 100%.css, no 400

    // A plain (non-bundle) share has nothing to discover.
    const plain = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    const plainRes = await (await app.fetch(new Request(`http://share.test/api/uploads/${plain.id}/tweaks/discover`))).json();
    expect(plainRes.candidates).toEqual([]);
  });

  test("GET /tweaks/discover scans inline <style> blocks (single-file bundles)", async () => {
    const { app } = await testApp();
    const html =
      "<!doctype html><html><head><style>:root{ --brand: #336699; --pad: 12px; }</style></head><body>Hi</body></html>";
    // A bundle whose tokens live only in the HTML's inline <style> — no .css file.
    const see = JSON.stringify({ homepage: "index.html", exposed: ["index.html"] });
    const payload = await (
      await uploadFiles(app, [new File([html], "index.html", { type: "text/html" }), manifestFile(see)], { editToken: "pw" })
    ).json();
    expect(payload.kind).toBe("bundle");

    const { candidates } = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks/discover`))
    ).json();
    const byVar = Object.fromEntries(candidates.map((c: { cssVar: string }) => [c.cssVar, c]));
    expect(byVar["--brand"]).toMatchObject({ kind: "color", value: "#336699" });
    expect(byVar["--pad"]).toMatchObject({ kind: "number", unit: "px", value: 12 });
  });

  test("GET /tweaks/discover bounds the number of candidates", async () => {
    const { app } = await testApp();
    const vars = Array.from({ length: 260 }, (_, i) => `--v${i}: ${i}px;`).join(" ");
    const payload = await (
      await uploadFiles(
        app,
        [indexFile(), new File([`:root { ${vars} }`], "styles.css", { type: "text/css" }), manifestFile(manifest())],
        { editToken: "pw" },
      )
    ).json();
    const { candidates } = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks/discover`))
    ).json();
    expect(candidates.length).toBeLessThanOrEqual(200);
  });

  test("GET /tweaks/discover flags page-level exposed cssVars too", async () => {
    const { app } = await testApp();
    const css = ":root { --gap: 8px; }";
    const see = JSON.stringify({
      homepage: "index.html",
      exposed: ["index.html"],
      pages: { "index.html": { tweaks: { gapKnob: { kind: "number", value: 8, cssVar: "--gap", label: "Gap" } } } },
    });
    const payload = await (
      await uploadFiles(app, [indexFile(), new File([css], "styles.css", { type: "text/css" }), manifestFile(see)], { editToken: "pw" })
    ).json();
    expect(payload.kind).toBe("bundle");

    const { candidates } = await (
      await app.fetch(new Request(`http://share.test/api/uploads/${payload.id}/tweaks/discover`))
    ).json();
    const gap = candidates.find((c: { cssVar: string }) => c.cssVar === "--gap");
    expect(gap).toMatchObject({ exposed: true }); // already exposed via a page tweak
  });

  test("a bundle injects the see:* runtime (port handshake to the viewer origin); a plain share does not", async () => {
    const { app } = await testApp();
    const bundle = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();
    expect(bundle.kind).toBe("bundle");

    const html = await (await app.fetch(new Request(`http://share.test/content/${bundle.id}/`))).text();
    // Runtime present: initiates a port handshake to the concrete viewer origin (no "*", no
    // sandbox-denied localStorage).
    expect(html).toContain("see:hello");
    expect(html).toContain("new MessageChannel()");
    expect(html).toContain('"origin":"http://share.test"');
    expect(html).toContain(`"id":"${bundle.id}"`);
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain('"*"');
    // ...and the static tweak <style> is still injected alongside it.
    expect(rootStyle(html)).toContain("--color-primary: #D97757");

    // A plain (non-bundle) share is served untouched — no runtime.
    const plain = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    expect(plain.kind).toBe("html");
    const plainHtml = await (await app.fetch(new Request(`http://share.test/content/${plain.id}/`))).text();
    expect(plainHtml).not.toContain("see:hello");
    expect(plainHtml).not.toContain("MessageChannel");
  });

  test("bundle HTML carries a runtime-versioned ETag so a pre-runtime cache cannot stale-304", async () => {
    const { app } = await testApp();
    const bundle = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();

    const res = await app.fetch(new Request(`http://share.test/content/${bundle.id}/`));
    const etag = res.headers.get("ETag") ?? "";
    expect(etag).toMatch(/-r\d+\.[a-z0-9]+"$/); // runtime version + viewer-origin hash in the validator

    // A validator from before the runtime existed (same revision, no runtime tag) must NOT 304 — it
    // should re-fetch the freshly injected body rather than keep the pre-injection HTML.
    const stale = etag.replace(/-r\d+\.[a-z0-9]+"$/, '"');
    const revalidate = await app.fetch(
      new Request(`http://share.test/content/${bundle.id}/`, { headers: { "if-none-match": stale } }),
    );
    expect(revalidate.status).toBe(200);
    expect(await revalidate.text()).toContain("see:hello");

    // A plain (non-injected) share keeps the plain validator — no runtime/origin tag.
    const plain = await (await uploadFiles(app, [indexFile()], { editToken: "pw" })).json();
    const plainRes = await app.fetch(new Request(`http://share.test/content/${plain.id}/`));
    expect(plainRes.headers.get("ETag") ?? "").not.toMatch(/-r\d+\./);
  });

  test("a create-path multipart upload of index.html + see.json yields kind bundle", async () => {
    const { app } = await testApp();
    const payload = await (await uploadFiles(app, [indexFile(), manifestFile(manifest())], { editToken: "pw" })).json();
    expect(payload.kind).toBe("bundle");
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

async function addResources(
  app: StaticShareApp,
  id: string,
  files: File[],
  options: { token?: string } = {},
): Promise<Response> {
  const formData = new FormData();
  files.forEach((file) => formData.append("file", file));
  const headers = new Headers();
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  return app.fetch(
    new Request(`http://share.test/api/uploads/${id}/resources`, {
      method: "POST",
      headers,
      body: formData,
    }),
  );
}
