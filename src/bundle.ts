import { AppError } from "./types";
import type { BundleState, TweakDef, WorkspaceSettings } from "./upload-metadata";

// The root manifest filename that turns an upload into a first-class bundle.
export const MANIFEST_FILENAME = "see.json";

const ALLOWED_TWEAK_KINDS = ["toggle", "number", "color", "text", "select"];

// Mirror the tweak limits enforced by the Settings API in src/app.ts.
const MAX_TWEAKS = 100;
const MAX_TWEAK_KEY_LENGTH = 64;
const MAX_TWEAK_STRING_VALUE_LENGTH = 2048;
const MAX_EXPOSED_PAGES = 1000;
const MAX_TWEAK_PAGES = 1000;
const MAX_PAGE_PATH_LENGTH = 1024;
const MAX_PRESETS = 50;
const MAX_PRESET_NAME_LENGTH = 64;

type TweakValue = string | number | boolean;

// A single tweak in the manifest: control metadata plus its current value.
type ManifestTweak = TweakDef & { value: TweakValue };

// A per-page tweak: control metadata plus an OPTIONAL value (inherits the shared value
// when omitted). Authors may override just the value, just the control metadata, or both.
type PartialManifestTweak = TweakDef & { value?: TweakValue };

// The authoring shape of see.json. This is the single source of truth for everything
// the platform offers; deriveBundleState() projects it onto the server-side workspace
// settings (unchanged shape) plus a separate BundleState for the SDK injector.
export type BundleManifest = {
  homepage?: string;
  exposed?: string[];
  bar?: boolean;
  tweaks?: Record<string, ManifestTweak>;
  pages?: Record<string, { tweaks?: Record<string, PartialManifestTweak> }>;
  presets?: Record<string, Record<string, TweakValue>>; // "Looks": named bundles of tweak values
};

function invalid(message: string): never {
  throw new AppError(400, "invalid_manifest", message);
}

// Strict parse + validation of a see.json document. Unknown top-level keys are ignored
// for forward compatibility; malformed values for known keys are rejected so authors
// (and agents) fail loudly with a clear message.
export function parseManifest(text: string): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid(`${MANIFEST_FILENAME} must be valid JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid(`${MANIFEST_FILENAME} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  const manifest: BundleManifest = {};

  if ("homepage" in obj && obj["homepage"] !== null) {
    if (typeof obj["homepage"] !== "string") {
      invalid("homepage must be a string");
    }
    manifest.homepage = obj["homepage"];
  }

  if ("exposed" in obj && obj["exposed"] !== null) {
    const exposed = obj["exposed"];
    if (!Array.isArray(exposed) || !exposed.every((e) => typeof e === "string")) {
      invalid("exposed must be an array of strings");
    }
    if (exposed.length > MAX_EXPOSED_PAGES) {
      invalid(`exposed supports at most ${MAX_EXPOSED_PAGES} entries`);
    }
    manifest.exposed = [...new Set(exposed as string[])];
  }

  if ("bar" in obj && obj["bar"] !== null) {
    if (typeof obj["bar"] !== "boolean") {
      invalid("bar must be a boolean");
    }
    manifest.bar = obj["bar"];
  }

  if ("tweaks" in obj && obj["tweaks"] !== null) {
    manifest.tweaks = parseTweaks(obj["tweaks"]);
  }

  if ("pages" in obj && obj["pages"] !== null) {
    manifest.pages = parsePages(obj["pages"]);
  }

  if ("presets" in obj && obj["presets"] !== null) {
    manifest.presets = parsePresets(obj["presets"]);
  }

  return manifest;
}

// A "preset" (a.k.a. "Look") is a named map of tweak id -> value. It is additive UI sugar: the viewer
// overlay applies a preset's values in bulk as local overrides; nothing is server-applied, so preset
// ids may reference any tweak (unknown ids simply no-op in the overlay). Validate shape + bounds only.
function parsePresets(raw: unknown): Record<string, Record<string, TweakValue>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("presets must be an object keyed by preset name");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_PRESETS) {
    invalid(`presets supports at most ${MAX_PRESETS} entries`);
  }

  const out: Record<string, Record<string, TweakValue>> = {};
  for (const [name, value] of entries) {
    if (name.length > MAX_PRESET_NAME_LENGTH) {
      invalid(`preset "${name}" exceeds ${MAX_PRESET_NAME_LENGTH} characters`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(`preset "${name}" must be an object of tweak id -> value`);
    }
    const valueEntries = Object.entries(value as Record<string, unknown>);
    if (valueEntries.length > MAX_TWEAKS) {
      invalid(`preset "${name}" supports at most ${MAX_TWEAKS} values`);
    }
    const inner: Record<string, TweakValue> = {};
    for (const [id, v] of valueEntries) {
      if (id.length > MAX_TWEAK_KEY_LENGTH) {
        invalid(`preset "${name}" tweak id "${id}" exceeds ${MAX_TWEAK_KEY_LENGTH} characters`);
      }
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        invalid(`preset "${name}" value for "${id}" must be a string, number, or boolean`);
      }
      if (typeof v === "string" && v.length > MAX_TWEAK_STRING_VALUE_LENGTH) {
        invalid(`preset "${name}" value for "${id}" exceeds ${MAX_TWEAK_STRING_VALUE_LENGTH} characters`);
      }
      inner[id] = v;
    }
    out[name] = inner;
  }
  return out;
}

function parsePages(raw: unknown): Record<string, { tweaks?: Record<string, PartialManifestTweak> }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("pages must be an object keyed by page path");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TWEAK_PAGES) {
    invalid(`pages supports at most ${MAX_TWEAK_PAGES} entries`);
  }

  const out: Record<string, { tweaks?: Record<string, PartialManifestTweak> }> = {};
  for (const [page, value] of entries) {
    if (page.length > MAX_PAGE_PATH_LENGTH) {
      invalid(`pages key "${page}" exceeds ${MAX_PAGE_PATH_LENGTH} characters`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(`pages entry "${page}" must be an object`);
    }
    const pageObj = value as Record<string, unknown>;
    const cfg: { tweaks?: Record<string, PartialManifestTweak> } = {};
    if ("tweaks" in pageObj && pageObj["tweaks"] !== null) {
      cfg.tweaks = parsePartialTweaks(pageObj["tweaks"]);
    }
    out[page] = cfg;
  }
  return out;
}

function parsePartialTweaks(raw: unknown): Record<string, PartialManifestTweak> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("tweaks must be an object keyed by tweak name");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TWEAKS) {
    invalid(`tweaks supports at most ${MAX_TWEAKS} keys`);
  }

  const out: Record<string, PartialManifestTweak> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_TWEAK_KEY_LENGTH) {
      invalid(`tweaks key "${key}" exceeds ${MAX_TWEAK_KEY_LENGTH} characters`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(`tweak "${key}" must be an object`);
    }
    out[key] = parsePartialTweak(key, value as Record<string, unknown>);
  }
  return out;
}

function parseTweaks(raw: unknown): Record<string, ManifestTweak> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("tweaks must be an object keyed by tweak name");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TWEAKS) {
    invalid(`tweaks supports at most ${MAX_TWEAKS} keys`);
  }

  const out: Record<string, ManifestTweak> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_TWEAK_KEY_LENGTH) {
      invalid(`tweaks key "${key}" exceeds ${MAX_TWEAK_KEY_LENGTH} characters`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(`tweak "${key}" must be an object with at least a "value"`);
    }
    out[key] = parseTweak(key, value as Record<string, unknown>);
  }
  return out;
}

function parseTweak(key: string, raw: Record<string, unknown>): ManifestTweak {
  if (!("value" in raw)) {
    invalid(`tweak "${key}" is missing a "value"`);
  }
  const value = raw["value"];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    invalid(`tweak "${key}" value must be a string, number, or boolean`);
  }
  if (typeof value === "string" && value.length > MAX_TWEAK_STRING_VALUE_LENGTH) {
    invalid(`tweak "${key}" value exceeds ${MAX_TWEAK_STRING_VALUE_LENGTH} characters`);
  }

  const tweak: ManifestTweak = { value };

  if ("kind" in raw && raw["kind"] !== undefined) {
    if (typeof raw["kind"] !== "string" || !ALLOWED_TWEAK_KINDS.includes(raw["kind"])) {
      invalid(`tweak "${key}" kind must be one of: ${ALLOWED_TWEAK_KINDS.join(", ")}`);
    }
    tweak.kind = raw["kind"];
  }
  for (const field of ["label", "group", "unit", "cssVar"] as const) {
    if (field in raw && raw[field] !== undefined) {
      if (typeof raw[field] !== "string") {
        invalid(`tweak "${key}" ${field} must be a string`);
      }
      tweak[field] = raw[field] as string;
    }
  }
  for (const field of ["min", "max", "step"] as const) {
    if (field in raw && raw[field] !== undefined) {
      if (typeof raw[field] !== "number" || !Number.isFinite(raw[field])) {
        invalid(`tweak "${key}" ${field} must be a finite number`);
      }
      tweak[field] = raw[field] as number;
    }
  }
  if ("options" in raw && raw["options"] !== undefined) {
    if (!Array.isArray(raw["options"]) || !raw["options"].every((o) => typeof o === "string")) {
      invalid(`tweak "${key}" options must be an array of strings`);
    }
    tweak.options = raw["options"] as string[];
  }

  return tweak;
}

// Like parseTweak, but "value" is OPTIONAL — a per-page tweak may override just the value,
// just the control metadata, or both, inheriting the rest from the shared tweak set.
function parsePartialTweak(key: string, raw: Record<string, unknown>): PartialManifestTweak {
  const tweak: PartialManifestTweak = {};

  if ("value" in raw && raw["value"] !== undefined) {
    const value = raw["value"];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      invalid(`tweak "${key}" value must be a string, number, or boolean`);
    }
    if (typeof value === "string" && value.length > MAX_TWEAK_STRING_VALUE_LENGTH) {
      invalid(`tweak "${key}" value exceeds ${MAX_TWEAK_STRING_VALUE_LENGTH} characters`);
    }
    tweak.value = value;
  }

  if ("kind" in raw && raw["kind"] !== undefined) {
    if (typeof raw["kind"] !== "string" || !ALLOWED_TWEAK_KINDS.includes(raw["kind"])) {
      invalid(`tweak "${key}" kind must be one of: ${ALLOWED_TWEAK_KINDS.join(", ")}`);
    }
    tweak.kind = raw["kind"];
  }
  for (const field of ["label", "group", "unit", "cssVar"] as const) {
    if (field in raw && raw[field] !== undefined) {
      if (typeof raw[field] !== "string") {
        invalid(`tweak "${key}" ${field} must be a string`);
      }
      tweak[field] = raw[field] as string;
    }
  }
  for (const field of ["min", "max", "step"] as const) {
    if (field in raw && raw[field] !== undefined) {
      if (typeof raw[field] !== "number" || !Number.isFinite(raw[field])) {
        invalid(`tweak "${key}" ${field} must be a finite number`);
      }
      tweak[field] = raw[field] as number;
    }
  }
  if ("options" in raw && raw["options"] !== undefined) {
    if (!Array.isArray(raw["options"]) || !raw["options"].every((o) => typeof o === "string")) {
      invalid(`tweak "${key}" options must be an array of strings`);
    }
    tweak.options = raw["options"] as string[];
  }

  if (tweak.value === undefined && Object.keys(tweak).length === 0) {
    invalid(`tweak "${key}" must define at least a value or one control field`);
  }

  return tweak;
}

// Project a validated manifest onto the server-side state: the existing WorkspaceSettings
// (unchanged shape — tweaks become a name→value map) plus a separate BundleState carrying
// tweak control definitions for the static style injector.
export function deriveBundleState(
  manifest: BundleManifest,
  htmlPages: string[],
  opts: { strict?: boolean } = {},
): { workspace: WorkspaceSettings; bundle?: BundleState } {
  // strict (upload / explicit validation): a homepage or exposed entry that does not
  // resolve to a real HTML page is a hard error. Non-strict (live re-derive after an
  // edit): silently drop stale references so a rename never wedges the share.
  const strict = opts.strict ?? true;
  const workspace: WorkspaceSettings = {};

  if (manifest.homepage !== undefined) {
    if (htmlPages.includes(manifest.homepage)) {
      workspace.homepage = manifest.homepage;
    } else if (strict) {
      invalid(`homepage "${manifest.homepage}" must be an existing HTML page`);
    }
  }

  if (manifest.exposed !== undefined) {
    const missing = manifest.exposed.find((page) => !htmlPages.includes(page));
    if (missing !== undefined && strict) {
      invalid(`exposed entry "${missing}" must be an existing HTML page`);
    }
    const exposed = strict ? manifest.exposed : manifest.exposed.filter((page) => htmlPages.includes(page));
    if (exposed.length > 0) {
      workspace.exposed = exposed;
    }
  }

  if (manifest.bar !== undefined) {
    workspace.barDefault = manifest.bar;
  }

  const tweakDefs: Record<string, TweakDef> = {};
  const tweakValues: Record<string, TweakValue> = {};
  if (manifest.tweaks) {
    for (const [key, { value, ...def }] of Object.entries(manifest.tweaks)) {
      tweakValues[key] = value;
      if (Object.keys(def).length > 0) {
        tweakDefs[key] = def;
      }
    }
  }
  if (Object.keys(tweakValues).length > 0) {
    workspace.tweaks = tweakValues;
  }

  const bundle: BundleState = {};
  if (Object.keys(tweakDefs).length > 0) {
    bundle.tweakDefs = tweakDefs;
  }

  // Per-page tweaks inherit from the shared set: each page contributes value overrides
  // (pageTweaks) and/or control metadata overrides (pageTweakDefs). Page paths must
  // resolve to a real HTML page — strict errors, non-strict drops stale references
  // (mirrors the exposed handling above).
  const pageTweaks: Record<string, Record<string, TweakValue>> = {};
  const pageTweakDefs: Record<string, Record<string, TweakDef>> = {};
  if (manifest.pages) {
    for (const [pagePath, pageCfg] of Object.entries(manifest.pages)) {
      if (!htmlPages.includes(pagePath)) {
        if (strict) {
          invalid(`pages entry "${pagePath}" must be an existing HTML page`);
        }
        continue;
      }
      if (!pageCfg.tweaks) {
        continue;
      }
      const values: Record<string, TweakValue> = {};
      const defs: Record<string, TweakDef> = {};
      for (const [id, { value, ...def }] of Object.entries(pageCfg.tweaks)) {
        if (value !== undefined) {
          values[id] = value;
        }
        if (Object.keys(def).length > 0) {
          defs[id] = def;
        }
      }
      if (Object.keys(values).length > 0) {
        pageTweaks[pagePath] = values;
      }
      if (Object.keys(defs).length > 0) {
        pageTweakDefs[pagePath] = defs;
      }
    }
  }
  if (Object.keys(pageTweaks).length > 0) {
    workspace.pageTweaks = pageTweaks;
  }
  if (Object.keys(pageTweakDefs).length > 0) {
    bundle.pageTweakDefs = pageTweakDefs;
  }

  // Presets ("Looks") are client-applied overlay sugar, so they pass through to the BundleState as-is
  // (no page/tweak-existence validation — unknown ids no-op in the overlay).
  if (manifest.presets && Object.keys(manifest.presets).length > 0) {
    bundle.presets = manifest.presets;
  }

  return { workspace, bundle: Object.keys(bundle).length > 0 ? bundle : undefined };
}
