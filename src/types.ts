export type UploadKind = "html" | "zip" | "resources" | "bundle";
export type UploadStatus = "ready" | "failed" | "expired" | "deleted";

export type ResourceInfo = {
  path: string;
  bytes: number;
  sha256: string;
  updatedAt: string;
  contentType: string;
};

export type UploadRecord = {
  id: string;
  title: string | null;
  originalFilename: string;
  kind: UploadKind;
  status: UploadStatus;
  sha256: string;
  uploadBytes: number;
  extractedBytes: number;
  fileCount: number;
  storagePath: string;
  createdAt: string;
  expiresAt: string;
  deletedAt: string | null;
  metadataJson: string | null;
};

export type StoredArtifact = {
  id: string;
  storagePath: string;
  kind: UploadKind;
  sha256: string;
  uploadBytes: number;
  extractedBytes: number;
  fileCount: number;
  resources: ResourceInfo[];
};

export type UploadInput = {
  files: File[];
  title: string | null;
  editToken: string | null;
};

export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
