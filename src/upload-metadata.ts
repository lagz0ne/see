import type { UploadRecord } from "./types";

export type UploadMetadata = {
  editTokenHash?: string;
  revision?: number;
};

export function parseUploadMetadata(value: string | null): UploadMetadata {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as UploadMetadata;
    const revision = parsed.revision;
    return {
      editTokenHash: typeof parsed.editTokenHash === "string" ? parsed.editTokenHash : undefined,
      revision: typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : undefined,
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
