export type AppConfig = {
  port: number;
  publicBaseUrl: string;
  contentBaseUrl: string | null;
  databasePath: string;
  storageDir: string;
  retentionDays: number;
  cleanupIntervalSeconds: number;
  maxUploadBytes: number;
  maxExtractedBytes: number;
  maxFileCount: number;
  maxPathDepth: number;
  maxExtractedFileBytes: number;
  uploadToken: string | null;
  trustProxy: boolean;
  spaFallback: boolean;
  uploadRateLimitWindowSeconds: number;
  uploadRateLimitMax: number;
};

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILE_COUNT = 1000;
const DEFAULT_MAX_PATH_DEPTH = 12;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readInteger(env.PORT, 3000, "PORT");
  const publicBaseUrl =
    env.PUBLIC_BASE_URL ?? (env.NODE_ENV === "production" ? required("PUBLIC_BASE_URL") : `http://localhost:${port}`);

  return {
    port,
    publicBaseUrl: normalizeBaseUrl(publicBaseUrl, "PUBLIC_BASE_URL"),
    contentBaseUrl: env.CONTENT_BASE_URL ? normalizeBaseUrl(env.CONTENT_BASE_URL, "CONTENT_BASE_URL") : null,
    databasePath: databasePathFromUrl(env.DATABASE_URL ?? "sqlite:/data/app.db"),
    storageDir: env.STORAGE_DIR ?? "/data/uploads",
    retentionDays: readNumber(env.RETENTION_DAYS, 7, "RETENTION_DAYS"),
    cleanupIntervalSeconds: readInteger(env.CLEANUP_INTERVAL_SECONDS, 3600, "CLEANUP_INTERVAL_SECONDS"),
    maxUploadBytes: readInteger(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES, "MAX_UPLOAD_BYTES"),
    maxExtractedBytes: readInteger(env.MAX_EXTRACTED_BYTES, DEFAULT_MAX_EXTRACTED_BYTES, "MAX_EXTRACTED_BYTES"),
    maxFileCount: readInteger(env.MAX_FILE_COUNT, DEFAULT_MAX_FILE_COUNT, "MAX_FILE_COUNT"),
    maxPathDepth: readInteger(env.MAX_PATH_DEPTH, DEFAULT_MAX_PATH_DEPTH, "MAX_PATH_DEPTH"),
    maxExtractedFileBytes: readInteger(env.MAX_EXTRACTED_FILE_BYTES, DEFAULT_MAX_UPLOAD_BYTES, "MAX_EXTRACTED_FILE_BYTES"),
    uploadToken: env.UPLOAD_TOKEN?.trim() || null,
    trustProxy: readBoolean(env.TRUST_PROXY, false),
    spaFallback: readBoolean(env.SPA_FALLBACK, true),
    uploadRateLimitWindowSeconds: readInteger(env.UPLOAD_RATE_LIMIT_WINDOW_SECONDS, 60, "UPLOAD_RATE_LIMIT_WINDOW_SECONDS"),
    uploadRateLimitMax: readInteger(env.UPLOAD_RATE_LIMIT_MAX, 20, "UPLOAD_RATE_LIMIT_MAX"),
  };
}

function required(name: string): never {
  throw new Error(`${name} is required in production`);
}

function readInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = readNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function readNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function databasePathFromUrl(url: string): string {
  if (!url.startsWith("sqlite:")) {
    throw new Error("DATABASE_URL must use sqlite:/path/to/app.db");
  }
  const path = url.slice("sqlite:".length);
  if (!path.startsWith("/")) {
    throw new Error("DATABASE_URL must use an absolute sqlite path");
  }
  return path;
}

function normalizeBaseUrl(value: string, name: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http or https URL`);
  }
  return url.toString().replace(/\/$/, "");
}
