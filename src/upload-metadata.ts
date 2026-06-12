import type { UploadRecord } from "./types";

export type WorkspaceSettings = {
  homepage?: string;    // resource path of the homepage HTML (e.g. "about.html")
  exposed?: string[];   // resource paths of navigable HTML pages
  barDefault?: boolean; // default visibility of the viewer chrome/inspector bar
  tweaks?: Record<string, string | number | boolean>; // named design knobs with primitive values
};

export type UploadMetadata = {
  editTokenHash?: string;
  revision?: number;
  workspace?: WorkspaceSettings;
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
      // Only include workspace if at least one valid field was found
      if (ws.homepage !== undefined || ws.exposed !== undefined || ws.barDefault !== undefined || ws.tweaks !== undefined) {
        workspace = ws;
      }
    }

    return {
      editTokenHash: typeof parsed["editTokenHash"] === "string" ? parsed["editTokenHash"] : undefined,
      revision: typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : undefined,
      ...(workspace !== undefined ? { workspace } : {}),
    };
  } catch {
    return {};
  }
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

export function passwordRequired(upload: UploadRecord): boolean {
  return Boolean(parseUploadMetadata(upload.metadataJson).editTokenHash);
}
