import type { UploadRecord } from "./types";

export type WorkspaceSettings = {
  homepage?: string;    // resource path of the homepage HTML (e.g. "about.html")
  exposed?: string[];   // resource paths of navigable HTML pages
  barDefault?: boolean; // default visibility of the viewer chrome/inspector bar
  tweaks?: Record<string, string | number | boolean>; // named design knobs with primitive values
  pageTweaks?: Record<string, Record<string, string | number | boolean>>; // page path -> tweak id -> value
};

// Per-tweak control metadata derived from a bundle's see.json (the *definitions*, minus
// the current value, which lives in WorkspaceSettings.tweaks). Shapes match the SDK.
export type TweakDef = {
  kind?: string;      // toggle | number | color | text | select
  label?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  cssVar?: string;    // CSS custom property the runtime sets (target: "css")
  options?: string[]; // for kind: "select"
  // Interaction targets (Pillar A). "css" (default, when cssVar is present) injects a static
  // :root var; "attr"/"class" are applied live by the runtime to elements matching `selector`.
  target?: string;    // "css" | "attr" | "class"
  selector?: string;  // for attr/class: CSS selector of the elements to drive
  attr?: string;      // for target:"attr": the (data-*/aria-*) attribute name to set
  class?: string;     // for target:"class": the class name to toggle
};

// Manifest-derived extras the HTML injector forwards to the SDK for a bundle. Kept
// separate from WorkspaceSettings so the workspace shape is unchanged.
export type BundleState = {
  tweakDefs?: Record<string, TweakDef>;
  pageTweakDefs?: Record<string, Record<string, TweakDef>>; // page path -> tweak id -> control metadata
  presets?: Record<string, Record<string, string | number | boolean>>; // preset name -> tweak id -> value ("Looks")
};

export type UploadMetadata = {
  editTokenHash?: string;
  revision?: number;
  workspace?: WorkspaceSettings;
  bundle?: BundleState;
};

export function parseUploadMetadata(value: string | null): UploadMetadata {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const revision = parsed["revision"];

    // Defensively parse workspace settings — drop any malformed fields
    let workspace: WorkspaceSettings | undefined;
    if (parsed["workspace"] && typeof parsed["workspace"] === "object" && !Array.isArray(parsed["workspace"])) {
      const raw = parsed["workspace"] as Record<string, unknown>;
      const ws: WorkspaceSettings = {};
      if (typeof raw["homepage"] === "string") {
        ws.homepage = raw["homepage"];
      }
      if (Array.isArray(raw["exposed"]) && raw["exposed"].every((e) => typeof e === "string")) {
        ws.exposed = raw["exposed"] as string[];
      }
      if (typeof raw["barDefault"] === "boolean") {
        ws.barDefault = raw["barDefault"];
      }
      if (raw["tweaks"] && typeof raw["tweaks"] === "object" && !Array.isArray(raw["tweaks"])) {
        const rawTweaks = raw["tweaks"] as Record<string, unknown>;
        const validTweaks: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(rawTweaks)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            validTweaks[k] = v;
          }
        }
        if (Object.keys(validTweaks).length > 0) {
          ws.tweaks = validTweaks;
        }
      }
      if (raw["pageTweaks"] && typeof raw["pageTweaks"] === "object" && !Array.isArray(raw["pageTweaks"])) {
        const rawPageTweaks = raw["pageTweaks"] as Record<string, unknown>;
        const validPageTweaks: Record<string, Record<string, string | number | boolean>> = {};
        for (const [page, pageValue] of Object.entries(rawPageTweaks)) {
          if (!pageValue || typeof pageValue !== "object" || Array.isArray(pageValue)) {
            continue;
          }
          const validTweaks: Record<string, string | number | boolean> = {};
          for (const [k, v] of Object.entries(pageValue as Record<string, unknown>)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              validTweaks[k] = v;
            }
          }
          if (Object.keys(validTweaks).length > 0) {
            validPageTweaks[page] = validTweaks;
          }
        }
        if (Object.keys(validPageTweaks).length > 0) {
          ws.pageTweaks = validPageTweaks;
        }
      }
      // Only include workspace if at least one valid field was found
      if (ws.homepage !== undefined || ws.exposed !== undefined || ws.barDefault !== undefined || ws.tweaks !== undefined || ws.pageTweaks !== undefined) {
        workspace = ws;
      }
    }

    const bundle = parseBundleState(parsed["bundle"]);

    return {
      editTokenHash: typeof parsed["editTokenHash"] === "string" ? parsed["editTokenHash"] : undefined,
      revision: typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : undefined,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(bundle !== undefined ? { bundle } : {}),
    };
  } catch {
    return {};
  }
}

// Defensively re-read a persisted BundleState. It was validated strictly when written
// (see src/bundle.ts), so we just drop anything malformed rather than re-validating.
function parseBundleState(raw: unknown): BundleState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  let tweakDefs: Record<string, TweakDef> | undefined;
  if (obj["tweakDefs"] && typeof obj["tweakDefs"] === "object" && !Array.isArray(obj["tweakDefs"])) {
    const out: Record<string, TweakDef> = {};
    for (const [key, value] of Object.entries(obj["tweakDefs"] as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = sanitizeTweakDef(value as Record<string, unknown>);
      }
    }
    if (Object.keys(out).length > 0) {
      tweakDefs = out;
    }
  }

  let pageTweakDefs: Record<string, Record<string, TweakDef>> | undefined;
  if (obj["pageTweakDefs"] && typeof obj["pageTweakDefs"] === "object" && !Array.isArray(obj["pageTweakDefs"])) {
    const out: Record<string, Record<string, TweakDef>> = {};
    for (const [page, pageValue] of Object.entries(obj["pageTweakDefs"] as Record<string, unknown>)) {
      if (!pageValue || typeof pageValue !== "object" || Array.isArray(pageValue)) {
        continue;
      }
      const inner: Record<string, TweakDef> = {};
      for (const [key, value] of Object.entries(pageValue as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          inner[key] = sanitizeTweakDef(value as Record<string, unknown>);
        }
      }
      if (Object.keys(inner).length > 0) {
        out[page] = inner;
      }
    }
    if (Object.keys(out).length > 0) {
      pageTweakDefs = out;
    }
  }

  let presets: Record<string, Record<string, string | number | boolean>> | undefined;
  if (obj["presets"] && typeof obj["presets"] === "object" && !Array.isArray(obj["presets"])) {
    const out: Record<string, Record<string, string | number | boolean>> = {};
    for (const [name, value] of Object.entries(obj["presets"] as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const inner: Record<string, string | number | boolean> = {};
      for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          inner[id] = v;
        }
      }
      if (Object.keys(inner).length > 0) {
        out[name] = inner;
      }
    }
    if (Object.keys(out).length > 0) {
      presets = out;
    }
  }

  if (tweakDefs === undefined && pageTweakDefs === undefined && presets === undefined) {
    return undefined;
  }
  return {
    ...(tweakDefs ? { tweakDefs } : {}),
    ...(pageTweakDefs ? { pageTweakDefs } : {}),
    ...(presets ? { presets } : {}),
  };
}

function sanitizeTweakDef(raw: Record<string, unknown>): TweakDef {
  const def: TweakDef = {};
  if (typeof raw["kind"] === "string") def.kind = raw["kind"];
  if (typeof raw["label"] === "string") def.label = raw["label"];
  if (typeof raw["group"] === "string") def.group = raw["group"];
  if (typeof raw["min"] === "number") def.min = raw["min"];
  if (typeof raw["max"] === "number") def.max = raw["max"];
  if (typeof raw["step"] === "number") def.step = raw["step"];
  if (typeof raw["unit"] === "string") def.unit = raw["unit"];
  if (typeof raw["cssVar"] === "string") def.cssVar = raw["cssVar"];
  if (Array.isArray(raw["options"]) && raw["options"].every((o) => typeof o === "string")) {
    def.options = raw["options"] as string[];
  }
  if (typeof raw["target"] === "string") def.target = raw["target"];
  if (typeof raw["selector"] === "string") def.selector = raw["selector"];
  if (typeof raw["attr"] === "string") def.attr = raw["attr"];
  if (typeof raw["class"] === "string") def.class = raw["class"];
  return def;
}

export function serializeUploadMetadata(metadata: UploadMetadata): string {
  return JSON.stringify({
    ...metadata,
    revision: metadata.revision && metadata.revision > 0 ? metadata.revision : 1,
  });
}

export function uploadRevision(upload: UploadRecord): number {
  return parseUploadMetadata(upload.metadataJson).revision ?? 1;
}

export function uploadWorkspace(upload: UploadRecord): WorkspaceSettings {
  return parseUploadMetadata(upload.metadataJson).workspace ?? {};
}

export function uploadBundle(upload: UploadRecord): BundleState | undefined {
  return parseUploadMetadata(upload.metadataJson).bundle;
}

export function passwordRequired(upload: UploadRecord): boolean {
  return Boolean(parseUploadMetadata(upload.metadataJson).editTokenHash);
}
