import { describe, expect, test } from "bun:test";
import { expandIncludes, normalizeIncludePath, type IncludeLoader } from "../src/includes";

// A loader backed by an in-memory map, mirroring the app's root-relative resource lookup.
function loaderFor(files: Record<string, string>): IncludeLoader {
  return async (path: string) => (path in files ? files[path] : null);
}

describe("normalizeIncludePath", () => {
  test("strips leading slashes, '.' segments, and collapses", () => {
    expect(normalizeIncludePath("shared/nav.html")).toBe("shared/nav.html");
    expect(normalizeIncludePath("/shared/nav.html")).toBe("shared/nav.html");
    expect(normalizeIncludePath("./shared/./nav.html")).toBe("shared/nav.html");
    expect(normalizeIncludePath("  shared/nav.html  ")).toBe("shared/nav.html");
  });

  test("rejects empty and any traversal", () => {
    expect(normalizeIncludePath("")).toBeNull();
    expect(normalizeIncludePath("   ")).toBeNull();
    expect(normalizeIncludePath("/")).toBeNull();
    expect(normalizeIncludePath("../secret.html")).toBeNull();
    expect(normalizeIncludePath("shared/../../etc/passwd")).toBeNull();
  });
});

describe("expandIncludes", () => {
  test("transcludes a fragment, replacing the element and any fallback", async () => {
    const html = `<body><h1>Home</h1><see-include src="shared/nav.html">loading…</see-include><p>x</p></body>`;
    const out = await expandIncludes(html, loaderFor({ "shared/nav.html": "<nav>NAV</nav>" }));
    expect(out).toContain("<nav>NAV</nav>");
    expect(out).not.toContain("see-include");
    expect(out).not.toContain("loading…");
    expect(out).toContain("<h1>Home</h1>");
    expect(out).toContain("<p>x</p>");
  });

  test("fast path returns input unchanged when there are no includes", async () => {
    const html = `<body><h1>Home</h1></body>`;
    expect(await expandIncludes(html, loaderFor({}))).toBe(html);
  });

  test("expands nested includes recursively", async () => {
    const html = `<div><see-include src="a.html"></see-include></div>`;
    const out = await expandIncludes(
      html,
      loaderFor({
        "a.html": `<a><see-include src="b.html"></see-include></a>`,
        "b.html": `<b>deep</b>`,
      }),
    );
    expect(out).toBe(`<div><a><b>deep</b></a></div>`);
  });

  test("a missing fragment expands to nothing (never breaks the page)", async () => {
    const html = `<div><see-include src="nope.html"></see-include>after</div>`;
    const out = await expandIncludes(html, loaderFor({}));
    expect(out).toBe(`<div>after</div>`);
  });

  test("rejects traversal references (expands to nothing)", async () => {
    const html = `<div><see-include src="../secret.html"></see-include></div>`;
    let asked = "";
    const out = await expandIncludes(html, async (p) => {
      asked = p;
      return "SECRET";
    });
    expect(out).toBe(`<div></div>`);
    expect(asked).toBe(""); // loader never consulted for a traversal path
  });

  test("breaks direct and indirect cycles without infinite looping", async () => {
    const direct = await expandIncludes(`<see-include src="self.html"></see-include>`, loaderFor({
      "self.html": `loop<see-include src="self.html"></see-include>`,
    }));
    // First expansion inserts the fragment once; its self-reference is a cycle → empty.
    expect(direct).toBe("loop");

    const indirect = await expandIncludes(`<see-include src="a.html"></see-include>`, loaderFor({
      "a.html": `A<see-include src="b.html"></see-include>`,
      "b.html": `B<see-include src="a.html"></see-include>`,
    }));
    expect(indirect).toBe("AB");
  });

  test("reuses the same fragment for repeated references", async () => {
    const html = `<see-include src="x.html"></see-include><see-include src="x.html"></see-include>`;
    const out = await expandIncludes(html, loaderFor({ "x.html": "<x/>" }));
    expect(out).toBe("<x/><x/>");
  });

  test("bounds total expansion depth", async () => {
    // A chain longer than MAX_INCLUDE_DEPTH (8): the tail beyond the limit drops to empty.
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      files[`n${i}.html`] = `${i}<see-include src="n${i + 1}.html"></see-include>`;
    }
    const out = await expandIncludes(`<see-include src="n0.html"></see-include>`, loaderFor(files));
    // Depth 8 means levels 0..7 expand (digits 0-7 present), level 8+ truncated.
    expect(out.startsWith("01234567")).toBe(true);
    expect(out).not.toContain("8");
  });
});
