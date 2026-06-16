import { describe, expect, test } from "bun:test";
import { normalizeResourcePath, resourceWritePath } from "../src/artifacts";

const DEPTH = 10;

// These two functions must canonicalize a path the SAME way wherever a stored path is matched vs.
// where a write is validated — the see.json guard bypass recurred precisely because a guard
// canonicalized differently from the writer. The asymmetry below is intentional and load-bearing.
describe("resource path canonicalization", () => {
  // normalizeResourcePath addresses STORED paths and must stay aligned with the zip archive
  // normalizer (zip.ts normalizeArchivePath), which preserves surrounding whitespace. A
  // whitespace-named zip resource is stored verbatim, so read/edit/delete must address it
  // verbatim too — normalizeResourcePath must NOT trim.
  test("normalizeResourcePath preserves surrounding whitespace (archive alignment)", () => {
    expect(normalizeResourcePath(" foo.css", DEPTH)).toBe(" foo.css");
    expect(normalizeResourcePath("foo.css ", DEPTH)).toBe("foo.css ");
    expect(normalizeResourcePath("see.json ", DEPTH)).not.toBe("see.json");
  });

  // resourceWritePath is the path the WRITER stores a client-supplied path at: trim THEN normalize.
  // Guards address writes through this so a non-canonical path that resolves to root see.json
  // cannot bypass strict manifest validation.
  test("resourceWritePath trims then normalizes (writer/guard alignment)", () => {
    expect(resourceWritePath(" see.json ", DEPTH)).toBe("see.json");
    expect(resourceWritePath("./see.json", DEPTH)).toBe("see.json");
    expect(resourceWritePath("see.json/", DEPTH)).toBe("see.json");
    expect(resourceWritePath("  a/b.css  ", DEPTH)).toBe("a/b.css");
  });

  // They agree on already-canonical paths and both reject unsafe ones; only the write path
  // collapses whitespace — keeping zip whitespace resources addressable while closing the guard.
  test("the two agree on canonical paths and reject unsafe ones", () => {
    expect(normalizeResourcePath("a/b.css", DEPTH)).toBe("a/b.css");
    expect(resourceWritePath("a/b.css", DEPTH)).toBe("a/b.css");
    expect(() => resourceWritePath("../escape", DEPTH)).toThrow();
    expect(() => normalizeResourcePath("/abs", DEPTH)).toThrow();
  });
});
