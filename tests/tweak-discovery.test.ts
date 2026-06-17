import { describe, expect, test } from "bun:test";
import { discoverTweaks, type DiscoveredTweak } from "../src/tweak-discovery";

function byId(tweaks: DiscoveredTweak[]): Record<string, DiscoveredTweak> {
  return Object.fromEntries(tweaks.map((t) => [t.id, t]));
}

describe("tweak discovery", () => {
  test("infers kind, unit, range, group and label from :root custom properties", () => {
    const css = `:root {
      --color-primary: #D97757;
      --font-size-base: 16px;
      --line-height: 1.5;
      --width-pct: 50%;
      --font-family: Inter, sans-serif;
      --space-gutter: -8px;
      --accent: oklch(0.7 0.15 60);
    }`;
    const t = byId(discoverTweaks([css]));

    expect(t["color-primary"]).toMatchObject({
      cssVar: "--color-primary",
      kind: "color",
      value: "#D97757",
      group: "Color",
      label: "Color primary",
    });
    expect(t["font-size-base"]).toMatchObject({ kind: "number", value: 16, unit: "px", min: 0, step: 1, group: "Font" });
    expect(t["font-size-base"].max).toBeGreaterThanOrEqual(16);
    expect(t["line-height"]).toMatchObject({ kind: "number", value: 1.5, group: "Line" });
    expect(t["line-height"].unit).toBeUndefined();
    expect(t["width-pct"]).toMatchObject({ kind: "number", value: 50, unit: "%", min: 0, max: 100, step: 1 });
    expect(t["font-family"]).toMatchObject({ kind: "text", value: "Inter, sans-serif", group: "Font" });
    expect(t["space-gutter"]).toMatchObject({ kind: "number", value: -8, unit: "px" });
    expect(t["space-gutter"].min).toBeLessThan(0); // negative values keep a negative floor
    // Modern color functions (oklch/rgb/hsl) are recognized as colors, not text.
    expect(t["accent"]).toMatchObject({ kind: "color", value: "oklch(0.7 0.15 60)", group: "Accent" });
  });

  test("only scans :root / html, ignores other rules and non-custom props", () => {
    const css = `:root { --a: 1px; color: red; }
      .card { --b: 2px; }
      html { --c: #fff; }`;
    const t = byId(discoverTweaks([css]));
    expect(t["a"]).toBeDefined();
    expect(t["c"]).toBeDefined();
    expect(t["b"]).toBeUndefined(); // declared on .card, not the root
    expect(Object.keys(t)).toHaveLength(2);
  });

  test("keeps the unconditional default, ignoring :root overrides inside conditional at-rules", () => {
    const css = `:root { --accent: #ffffff; }
      @media (prefers-color-scheme: dark) { :root { --accent: #000000; } }
      @supports (color: oklch(0 0 0)) { :root { --accent: #111111; } }`;
    const t = byId(discoverTweaks([css]));
    expect(t["accent"].value).toBe("#ffffff"); // base default, not the dark/supports override
  });

  test("collects only direct :root declarations, not native-nested or nested-at-rule ones", () => {
    const css = ":root { --a: 1px; .card { --b: 2px; } @media (min-width: 0) { --c: 3px; } }";
    const t = byId(discoverTweaks([css]));
    expect(t["a"]).toBeDefined();
    expect(t["b"]).toBeUndefined(); // scoped under a nested rule
    expect(t["c"]).toBeUndefined(); // conditional under a nested @media
  });

  test("dedupes consistent duplicates, excludes conflicting ones, and skips invalid CSS", () => {
    // Same value across files (with an invalid file between) → a single candidate.
    const same = byId(discoverTweaks([":root { --x: 1px; }", "}{ not css", ":root { --x: 1px; }"]));
    expect(Object.values(same)).toHaveLength(1);
    expect(same["x"].value).toBe(1);
    // Conflicting unconditional values across files are cascade-ambiguous → excluded.
    const conflict = byId(discoverTweaks([":root { --y: 1px; }", ":root { --y: 9px; }"]));
    expect(conflict["y"]).toBeUndefined();
    // Same numeric value, different UNIT (1px vs 1rem, both parse to 1) is still a conflict.
    const units = byId(discoverTweaks([":root { --z: 1px; }", ":root { --z: 1rem; }"]));
    expect(units["z"]).toBeUndefined();
    // A redeclaration WITHIN one source is deterministic (later wins) — keep it, don't exclude.
    const sameSrc = byId(discoverTweaks([":root{--accent:#ffffff} :root{--accent:#000000}"]));
    expect(sameSrc["accent"].value).toBe("#000000");
  });

  test("never offers prototype-polluting ids like __proto__", () => {
    const t = discoverTweaks([":root { --__proto__: 1px; --constructor: red; --gap: 8px; }"]);
    expect(t.find((c) => c.id === "__proto__")).toBeUndefined();
    expect(t.find((c) => c.id === "constructor")).toBeUndefined();
    expect(t.find((c) => c.id === "gap")).toBeDefined();
  });

  test("does not offer text values the static injector would alter (lossy)", () => {
    const t = discoverTweaks([":root{ --bad: a<b; --ok: hello; }"]);
    expect(t.find((c) => c.id === "bad")).toBeUndefined(); // contains "<" → stripped by the injector → lossy
    expect(t.find((c) => c.id === "ok")).toBeDefined();
  });

  test("honors the candidate limit (bounds discovery work)", () => {
    const css = `:root { ${Array.from({ length: 50 }, (_, i) => `--v${i}: ${i}px;`).join(" ")} }`;
    expect(discoverTweaks([css], 10).length).toBeLessThanOrEqual(10);
  });
});
