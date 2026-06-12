import { describe, expect, test } from "bun:test";
import {
  buildShareId,
  generateArtifactId,
  generateFriendlyPrefix,
  generateSuffix,
  NAME_SUFFIX_LENGTH,
  normalizeClaimPrefix,
  SHARE_ID_PATTERN,
  splitShareId,
} from "../src/names";
import { AppError } from "../src/types";

describe("share names", () => {
  test("generated ids are `<prefix>-<suffix>` and pass the share-id pattern", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = generateArtifactId();
      expect(SHARE_ID_PATTERN.test(id)).toBe(true);
      const parts = splitShareId(id);
      expect(parts).not.toBeNull();
      expect(parts!.suffix).toHaveLength(NAME_SUFFIX_LENGTH);
      // Suffix uses the unambiguous alphabet (no 0/1/i/l/o).
      expect(parts!.suffix).toMatch(/^[2-9a-hjkmnp-z]{4}$/);
      // Prefix is lowercase alphanumerics only (made-up word).
      expect(parts!.prefix).toMatch(/^[a-z]+$/);
    }
  });

  test("suffixes vary across calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSuffix()));
    expect(seen.size).toBeGreaterThan(40);
  });

  test("friendly prefixes are short, pronounceable-ish words", () => {
    for (let i = 0; i < 100; i += 1) {
      const prefix = generateFriendlyPrefix();
      expect(prefix.length).toBeGreaterThanOrEqual(3);
      expect(prefix.length).toBeLessThanOrEqual(16);
    }
  });

  test("splitShareId rejects malformed ids", () => {
    expect(splitShareId("nodash")).toBeNull();
    expect(splitShareId("-leading")).toBeNull();
    expect(splitShareId("trailing-")).toBeNull();
  });

  test("SHARE_ID_PATTERN rejects unsafe ids", () => {
    expect(SHARE_ID_PATTERN.test("Not_An_Id")).toBe(false); // uppercase + underscore
    expect(SHARE_ID_PATTERN.test("a")).toBe(false); // too short
    expect(SHARE_ID_PATTERN.test("../etc")).toBe(false);
    expect(SHARE_ID_PATTERN.test("my-demo-3f7k")).toBe(true);
  });

  describe("normalizeClaimPrefix", () => {
    test("lowercases and slugifies free text", () => {
      expect(normalizeClaimPrefix("My Cool Demo")).toBe("my-cool-demo");
      expect(normalizeClaimPrefix("  Trim_me!! ")).toBe("trim-me");
      expect(normalizeClaimPrefix("already-good")).toBe("already-good");
    });

    test("rejects empty or non-string names", () => {
      expect(() => normalizeClaimPrefix("   ")).toThrow(AppError);
      expect(() => normalizeClaimPrefix("!!!")).toThrow(AppError);
      expect(() => normalizeClaimPrefix(42 as unknown)).toThrow(AppError);
    });

    test("rejects over-long names", () => {
      expect(() => normalizeClaimPrefix("a".repeat(33))).toThrow(AppError);
    });

    test("builds ids that pass the share-id pattern", () => {
      const id = buildShareId(normalizeClaimPrefix("My App"), generateSuffix());
      expect(SHARE_ID_PATTERN.test(id)).toBe(true);
    });
  });
});
