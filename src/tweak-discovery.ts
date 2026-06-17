import postcss from "postcss";
import { parseHTML } from "linkedom";

// A manifest-ready tweak inferred from a CSS custom property — the "we found your design tokens"
// offload: the author exposes their existing :root variables as knobs without authoring see.json by
// hand. Shape matches a see.json tweak (id + the def fields), so the client can patch it in directly.
export type DiscoveredTweak = {
  id: string;
  cssVar: string;
  kind: "color" | "number" | "text";
  value: string | number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  group: string;
};

// Scan a bundle's CSS for custom properties declared on :root (and html) — that is where design
// tokens live — and infer a tweak for each. Later declarations win (cascade order across files), so
// each cssVar yields one candidate. Over-inclusive by design: the author reviews and deselects;
// dropping a real token is worse than offering an unused one.
export function discoverTweaks(cssSources: string[], limit = Infinity): DiscoveredTweak[] {
  const found = new Map<string, DiscoveredTweak>();
  const conflicting = new Set<string>();
  const sourceOf = new Map<string, number>();
  for (let sourceIndex = 0; sourceIndex < cssSources.length; sourceIndex += 1) {
    if (found.size >= limit) break; // enough candidates — don't parse further sources
    let root: postcss.Root;
    try {
      root = postcss.parse(cssSources[sourceIndex]);
    } catch {
      continue; // skip a file that isn't valid CSS
    }
    root.walkRules((rule) => {
      if (found.size >= limit) return false; // break out of walkRules
      if (!selectsRoot(rule.selector) || inConditionalAtRule(rule)) return;
      // Only DIRECT declarations of :root — rule.each does not recurse, so native-nested rules and
      // nested @media inside :root (scoped/conditional values) aren't exposed as unconditional tweaks.
      rule.each((node) => {
        if (node.type !== "decl") return;
        const decl = node as postcss.Declaration;
        if (!decl.prop.startsWith("--")) return;
        const tweak = inferTweak(decl.prop, decl.value.trim());
        if (!tweak) return;
        const prev = found.get(decl.prop);
        // A differing value is cascade-AMBIGUOUS only across DIFFERENT sources (their load order is
        // unknown to us); within one source CSS has a deterministic later-wins, so just take the
        // latest. The conflict key includes unit + kind so "1px" vs "1rem" (both parse to 1) differ.
        if (prev && conflictKey(prev) !== conflictKey(tweak) && sourceOf.get(decl.prop) !== sourceIndex) {
          conflicting.add(decl.prop);
        }
        found.set(decl.prop, tweak);
        sourceOf.set(decl.prop, sourceIndex);
        if (found.size >= limit) return false; // break out of rule.each
      });
      return undefined;
    });
  }
  return [...found.values()].filter((tweak) => !conflicting.has(tweak.cssVar));
}

// Identity for conflict detection: same kind + value + unit means the same effective default.
function conflictKey(tweak: DiscoveredTweak): string {
  return `${tweak.kind}|${tweak.value}|${tweak.unit ?? ""}`;
}

// True when the rule sits inside a CONDITIONAL at-rule (@media / @supports / @container). Such a
// :root override is theme/condition-specific; exposing its value as an UNCONDITIONAL see.json default
// would change rendering for everyone, so we skip it and keep the base declaration as the candidate.
function inConditionalAtRule(rule: postcss.Rule): boolean {
  let node: postcss.Container | postcss.Document | undefined = rule.parent;
  while (node) {
    if (node.type === "atrule" && /^(media|supports|container)$/i.test((node as postcss.AtRule).name)) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

// The CSS text of every <style> block in an HTML document, so tokens declared inline (common in
// single-file prototypes) are discoverable alongside standalone .css files.
export function extractStyleBlocks(html: string): string[] {
  try {
    const { document } = parseHTML(html);
    return Array.from(document.querySelectorAll("style"))
      .map((el) => el.textContent || "")
      .filter((css) => css.trim().length > 0);
  } catch {
    return [];
  }
}

// True when any comma-separated selector targets the document root.
function selectsRoot(selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .some((s) => s === ":root" || s === "html" || s === ":root,html");
}

// Ids that, used as a JSON-pointer segment, would touch the object prototype instead of creating an
// own key — never offer them as candidates.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

// True when `value` survives the static injector's sanitization unchanged — bundleTweakStyle (app.ts)
// strips <>;{} and /* before emitting, so a value containing them would be injected DIFFERENTLY than
// declared, overriding the original CSS. Such values can't be exposed losslessly as a cssVar tweak.
export function cssInjectionSafe(value: string): boolean {
  return value.replace(/[<>;{}]|\/\*/g, "") === value;
}
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
// Modern CSS color functions — Tailwind/shadcn design tokens are commonly oklch()/rgb()/hsl().
const COLOR_FN_RE = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
const NUMBER_RE = /^(-?\d*\.?\d+)\s*(px|rem|em|%|vh|vw|vmin|vmax|pt|ch)?$/;

function inferTweak(prop: string, value: string): DiscoveredTweak | null {
  if (value.length === 0 || value.length > 200) return null; // skip empty / pathological
  const id = prop.slice(2);
  if (id.length === 0 || id.length > 64 || RESERVED_IDS.has(id)) return null;
  const label = humanizeLabel(id);
  const group = humanizeGroup(id);

  if (COLOR_RE.test(value) || COLOR_FN_RE.test(value)) {
    return { id, cssVar: prop, kind: "color", value, label, group };
  }

  const num = value.match(NUMBER_RE);
  if (num) {
    const n = parseFloat(num[1]);
    const unit = num[2];
    return { id, cssVar: prop, kind: "number", value: n, ...(unit ? { unit } : {}), ...numberRange(n, unit), label, group };
  }

  // text — only when it survives the static injector losslessly (else exposing would change the render).
  if (!cssInjectionSafe(value)) return null;
  return { id, cssVar: prop, kind: "text", value, label, group };
}

// A usable slider range around the current value. Rough but adjustable by the author once exposed.
function numberRange(n: number, unit?: string): { min: number; max: number; step: number } {
  if (unit === "%") return { min: 0, max: 100, step: 1 };
  const abs = Math.abs(n);
  const step = unit === "rem" || unit === "em" ? 0.125 : abs < 4 ? 0.1 : 1;
  const max = Math.max(Math.ceil(abs * 4), abs + 4, 1);
  const min = n < 0 ? Math.floor(n * 2) : 0;
  return { min, max, step };
}

// "--font-size-base" -> "Font size base".
function humanizeLabel(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Group by the leading segment: "--color-primary" -> "Color", "--font-size" -> "Font".
function humanizeGroup(id: string): string {
  const seg = id.split(/[-_]/)[0] || id;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
