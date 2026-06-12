import { AppError } from "./types";
import type { BundleState, InspectTarget, TweakDef, WorkspaceSettings } from "./upload-metadata";

// The root manifest filename that turns an upload into a first-class bundle.
export const MANIFEST_FILENAME = "see.json";

const ALLOWED_CAPABILITIES = ["inspect", "tweaks"];
const ALLOWED_TWEAK_KINDS = ["toggle", "number", "color", "text", "select"];

// Mirror the tweak limits enforced by the Settings API in src/app.ts.
const MAX_TWEAKS = 100;
const MAX_TWEAK_KEY_LENGTH = 64;
const MAX_TWEAK_STRING_VALUE_LENGTH = 2048;
const MAX_INSPECT_TARGETS = 200;
const MAX_EXPOSED_PAGES = 1000;

type TweakValue = string | number | boolean;

// A single tweak in the manifest: control metadata plus its current value.
type ManifestTweak = TweakDef & { value: TweakValue };

// The authoring shape of see.json. This is the single source of truth for everything
// the platform offers; deriveBundleState() projects it onto the server-side workspace
// settings (unchanged shape) plus a separate BundleState for the SDK injector.
export type BundleManifest = {
  homepage?: string;
  exposed?: string[];
  bar?: boolean;
  capabilities: string[];
  tweaks?: Record<string, ManifestTweak>;
  inspect?: InspectTarget[];
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

  const manifest: BundleManifest = { capabilities: [] };

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

  if ("capabilities" in obj && obj["capabilities"] !== null) {
    const caps = obj["capabilities"];
    if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string")) {
      invalid("capabilities must be an array of strings");
    }
    for (const cap of caps as string[]) {
      if (!ALLOWED_CAPABILITIES.includes(cap)) {
        invalid(`unknown capability "${cap}" (allowed: ${ALLOWED_CAPABILITIES.join(", ")})`);
      }
    }
    manifest.capabilities = [...new Set(caps as string[])];
  }

  if ("tweaks" in obj && obj["tweaks"] !== null) {
    manifest.tweaks = parseTweaks(obj["tweaks"]);
  }

  if ("inspect" in obj && obj["inspect"] !== null) {
    manifest.inspect = parseInspect(obj["inspect"]);
  }

  return manifest;
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

function parseInspect(raw: unknown): InspectTarget[] {
  if (!Array.isArray(raw)) {
    invalid("inspect must be an array of { selector, id?, label? } objects");
  }
  if (raw.length > MAX_INSPECT_TARGETS) {
    invalid(`inspect supports at most ${MAX_INSPECT_TARGETS} targets`);
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`inspect[${index}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["selector"] !== "string" || e["selector"].length === 0) {
      invalid(`inspect[${index}] requires a non-empty "selector" string`);
    }
    const target: InspectTarget = { selector: e["selector"] };
    if ("id" in e && e["id"] !== undefined) {
      if (typeof e["id"] !== "string") invalid(`inspect[${index}].id must be a string`);
      target.id = e["id"];
    }
    if ("label" in e && e["label"] !== undefined) {
      if (typeof e["label"] !== "string") invalid(`inspect[${index}].label must be a string`);
      target.label = e["label"];
    }
    return target;
  });
}

// Project a validated manifest onto the server-side state: the existing WorkspaceSettings
// (unchanged shape — tweaks become a name→value map) plus a separate BundleState carrying
// the extras the SDK injector forwards (capabilities, tweak control defs, inspect targets).
export function deriveBundleState(
  manifest: BundleManifest,
  htmlPages: string[],
  opts: { strict?: boolean } = {},
): { workspace: WorkspaceSettings; bundle: BundleState } {
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
      } else {
        // Keep an (empty) def so the SDK still renders a control for this tweak.
        tweakDefs[key] = {};
      }
    }
  }
  if (Object.keys(tweakValues).length > 0) {
    workspace.tweaks = tweakValues;
  }

  const bundle: BundleState = { capabilities: manifest.capabilities };
  if (Object.keys(tweakDefs).length > 0) {
    bundle.tweakDefs = tweakDefs;
  }
  if (manifest.inspect && manifest.inspect.length > 0) {
    bundle.inspect = manifest.inspect;
  }

  return { workspace, bundle };
}
