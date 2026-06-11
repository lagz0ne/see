import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Server } from "bun";
import type { AppConfig } from "./config";
import {
  addOrReplaceResources,
  decodeResourcePathFromUrl,
  deleteArtifact,
  deleteResource,
  listResources,
  randomEditToken,
  sha256Text,
  storeUploadedArtifact,
  type ResourceWriteSummary,
} from "./artifacts";
import { UploadsRepository } from "./db";
import { mimeTypeForPath } from "./mime";
import { errorPage, expiredPage, notFoundPage, uploadPage, viewerPage } from "./pages";
import { parseUploadMetadata, serializeUploadMetadata, uploadRevision } from "./upload-metadata";
import { contentFrameSrc, contentOrigin, contentRootUrl, isContentHost, viewerUrl } from "./urls";
import { AppError, type ResourceInfo, type UploadRecord } from "./types";

type AppServer = Pick<Server<unknown>, "requestIP">;

const ID_PATTERN = /^u_[A-Za-z0-9_-]{12}$/;
const BUILT_ASSET_TYPES = new Map([
  ["app.css", "text/css; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
]);
const REQUEST_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

export type StaticShareApp = {
  config: AppConfig;
  repo: UploadsRepository;
  fetch: (request: Request, server?: AppServer) => Promise<Response>;
  runCleanupOnce: () => Promise<void>;
  startCleanupLoop: () => Timer | null;
  close: () => void;
};

export function createApp(config: AppConfig): StaticShareApp {
  const repo = new UploadsRepository(config.databasePath);
  const limiter = new UploadRateLimiter(config);

  async function fetch(request: Request, server?: AppServer): Promise<Response> {
    const response = await routeRequest(request, server);
    if (request.method !== "HEAD") {
      return response;
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async function routeRequest(request: Request, server?: AppServer): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    try {
      const contentRoute = parseContentRoute(config, url);
      if (contentRoute) {
        return await handleContentRequest(request, contentRoute.id, contentRoute.assetPath, repo, config);
      }

      if (method === "GET" && url.pathname === "/") {
        return htmlResponse(uploadPage(config), 200, config);
      }
      if (method === "GET" && url.pathname === "/healthz") {
        return jsonResponse({ ok: true });
      }
      if (method === "GET" && url.pathname === "/api/auth-check") {
        return handleAuthCheck(request, config);
      }
      if (method === "GET" && url.pathname.startsWith("/assets/")) {
        return await handleAsset(url.pathname);
      }
      if (method === "POST" && url.pathname === "/api/uploads") {
        return await handleUpload(request, server, repo, config, limiter);
      }

      const viewerMatch = url.pathname.match(/^\/v\/([^/]+)$/);
      if (method === "GET" && viewerMatch) {
        return handleViewer(viewerMatch[1], repo, config);
      }

      const apiUploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (method === "GET" && apiUploadMatch) {
        return await handleUploadMetadata(apiUploadMatch[1], repo, config);
      }

      const apiResourcesMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/resources\/?(.*)$/);
      if (apiResourcesMatch) {
        return await handleResourceRequest(request, method, apiResourcesMatch[1], apiResourcesMatch[2] || "", repo, config);
      }

      if (method !== "GET" && method !== "POST") {
        return textResponse("Method Not Allowed", 405);
      }
      return htmlResponse(notFoundPage(), 404, config);
    } catch (error) {
      return handleError(error, url.pathname, config);
    }
  }

  async function runCleanupOnce(): Promise<void> {
    const nowIso = new Date().toISOString();
    const expired = repo.expiredForCleanup(nowIso);
    for (const upload of expired) {
      try {
        await deleteArtifact(config, upload.storagePath);
        repo.markDeleted(upload.id, nowIso);
        logEvent("info", "cleanup_deleted", { id: upload.id, storagePath: upload.storagePath });
      } catch (error) {
        logEvent("error", "cleanup_failed", {
          id: upload.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function startCleanupLoop(): Timer | null {
    if (config.cleanupIntervalSeconds <= 0) {
      return null;
    }
    const timer = setInterval(() => {
      runCleanupOnce().catch((error) => {
        logEvent("error", "cleanup_loop_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, config.cleanupIntervalSeconds * 1000);
    timer.unref?.();
    return timer;
  }

  return {
    config,
    repo,
    fetch,
    runCleanupOnce,
    startCleanupLoop,
    close: () => repo.close(),
  };
}

async function handleUpload(
  request: Request,
  server: AppServer | undefined,
  repo: UploadsRepository,
  config: AppConfig,
  limiter: UploadRateLimiter,
): Promise<Response> {
  const startedAt = performance.now();
  requireUploadToken(request, config);
  limiter.check(clientIp(request, server, config));

  rejectOversizedRequest(request, config.maxUploadBytes, "upload_too_large");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new AppError(400, "invalid_multipart", "Request must be multipart form data");
  }

  const files = formData.getAll("file").filter((value): value is File => value instanceof File);
  if (files.length === 0) {
    throw new AppError(400, "missing_file", "Multipart field 'file' is required");
  }

  const titleValue = formData.get("title");
  const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim().slice(0, 120) : null;
  const requestedEditToken = formString(formData, "editToken", 256);
  const editToken = requestedEditToken || randomEditToken();
  const editTokenHash = await sha256Text(editToken);

  const artifact = await storeUploadedArtifact(config, files);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + config.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const record: UploadRecord = {
    id: artifact.id,
    title,
    originalFilename: files.length === 1 ? files[0].name || "upload" : `${files.length} resources`,
    kind: artifact.kind,
    status: "ready",
    sha256: artifact.sha256,
    uploadBytes: artifact.uploadBytes,
    extractedBytes: artifact.extractedBytes,
    fileCount: artifact.fileCount,
    storagePath: artifact.storagePath,
    createdAt,
    expiresAt,
    deletedAt: null,
    metadataJson: serializeUploadMetadata({ editTokenHash, revision: 1 }),
  };

  try {
    repo.insert(record);
  } catch (error) {
    await deleteArtifact(config, artifact.storagePath);
    throw error;
  }

  logEvent("info", "upload_success", {
    id: record.id,
    kind: record.kind,
    uploadBytes: record.uploadBytes,
    extractedBytes: record.extractedBytes,
    fileCount: record.fileCount,
    expiresAt: record.expiresAt,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return jsonResponse(
    {
      id: record.id,
      viewerUrl: viewerUrl(config, record.id),
      contentUrl: contentRootUrl(config, record.id),
      kind: record.kind,
      editToken,
      revision: 1,
      resources: artifact.resources,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    },
    201,
  );
}

function handleAuthCheck(request: Request, config: AppConfig): Response {
  requireUploadToken(request, config);
  return jsonResponse({ ok: true, tokenRequired: Boolean(config.uploadToken) });
}

function handleViewer(id: string, repo: UploadsRepository, config: AppConfig): Response {
  if (!ID_PATTERN.test(id)) {
    return htmlResponse(notFoundPage(), 404, config);
  }
  const upload = repo.findById(id);
  if (!upload) {
    return htmlResponse(notFoundPage(), 404, config);
  }
  if (isUploadExpired(upload)) {
    markExpired(upload, repo);
    return htmlResponse(expiredPage(upload), 410, config);
  }
  return htmlResponse(viewerPage(config, upload), 200, config);
}

async function handleUploadMetadata(id: string, repo: UploadsRepository, config: AppConfig): Promise<Response> {
  if (!ID_PATTERN.test(id)) {
    return jsonResponse({ error: "Upload not found", code: "not_found" }, 404);
  }
  const upload = repo.findById(id);
  if (!upload) {
    return jsonResponse({ error: "Upload not found", code: "not_found" }, 404);
  }

  const expired = isUploadExpired(upload);
  if (expired) {
    markExpired(upload, repo);
  }

  const revision = uploadRevision(upload);
  return jsonResponse(
    {
      id: upload.id,
      title: upload.title || upload.originalFilename,
      kind: upload.kind,
      createdAt: upload.createdAt,
      expiresAt: upload.expiresAt,
      expired,
      contentRoot: contentRootUrl(config, upload.id),
      contentUrl: contentFrameSrc(config, upload.id, revision),
      revision,
      resources: expired ? [] : await listResources(config, upload.storagePath),
    },
    expired ? 410 : 200,
  );
}

async function handleResourceRequest(
  request: Request,
  method: string,
  id: string,
  resourcePath: string,
  repo: UploadsRepository,
  config: AppConfig,
): Promise<Response> {
  if (!ID_PATTERN.test(id)) {
    return jsonResponse({ error: "Upload not found", code: "not_found" }, 404);
  }
  const upload = repo.findById(id);
  if (!upload) {
    return jsonResponse({ error: "Upload not found", code: "not_found" }, 404);
  }
  if (isUploadExpired(upload)) {
    markExpired(upload, repo);
    return jsonResponse({ error: "Upload expired", code: "expired" }, 410);
  }

  if (method === "GET") {
    return jsonResponse(resourceListPayload(config, upload, await listResources(config, upload.storagePath)));
  }

  await requireEditToken(request, upload);

  if (method === "POST" && !resourcePath) {
    rejectOversizedRequest(request, config.maxUploadBytes, "upload_too_large");
    const formData = await readMultipartForm(request);
    const files = formData.getAll("file").filter((value): value is File => value instanceof File);
    const requestedPath = formString(formData, "path", 512);
    if (requestedPath && files.length > 1) {
      throw new AppError(400, "invalid_resource_path", "The path field can only be used with one file");
    }
    const summary = await addOrReplaceResources(
      config,
      upload.storagePath,
      files.map((file, index) => ({ file, path: index === 0 ? requestedPath : null })),
    );
    const payload = persistResourceMutation(repo, config, upload, summary);
    logEvent("info", "resource_upload_success", {
      id: upload.id,
      fileCount: payload.fileCount,
      extractedBytes: payload.extractedBytes,
      revision: payload.revision,
    });
    return jsonResponse(payload, 200);
  }

  if ((method === "PATCH" || method === "PUT") && resourcePath) {
    rejectOversizedRequest(request, config.maxExtractedFileBytes, "resource_too_large");
    const decodedPath = decodeResourcePathFromUrl(resourcePath);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > config.maxExtractedFileBytes) {
      throw new AppError(413, "resource_too_large", `Resource exceeds ${config.maxExtractedFileBytes} bytes`);
    }
    const file = new File([bytes], decodedPath.split("/").pop() || "resource", {
      type: request.headers.get("content-type") || "",
    });
    const summary = await addOrReplaceResources(config, upload.storagePath, [{ file, path: decodedPath }]);
    const payload = persistResourceMutation(repo, config, upload, summary);
    logEvent("info", "resource_patch_success", {
      id: upload.id,
      path: decodedPath,
      bytes: bytes.byteLength,
      revision: payload.revision,
    });
    return jsonResponse(payload, 200);
  }

  if (method === "DELETE" && resourcePath) {
    const decodedPath = decodeResourcePathFromUrl(resourcePath);
    const summary = await deleteResource(config, upload.storagePath, decodedPath);
    const payload = persistResourceMutation(repo, config, upload, summary);
    logEvent("info", "resource_delete_success", {
      id: upload.id,
      path: decodedPath,
      fileCount: payload.fileCount,
      revision: payload.revision,
    });
    return jsonResponse(payload, 200);
  }

  return textResponse("Method Not Allowed", 405);
}

async function handleContentRequest(
  request: Request,
  id: string,
  assetPath: string,
  repo: UploadsRepository,
  config: AppConfig,
): Promise<Response> {
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (method !== "GET") {
    return textResponse("Method Not Allowed", 405);
  }
  if (!ID_PATTERN.test(id)) {
    return textResponse("Not Found", 404, contentHeaders());
  }

  const upload = repo.findById(id);
  if (!upload) {
    return textResponse("Not Found", 404, contentHeaders());
  }
  if (isUploadExpired(upload)) {
    markExpired(upload, repo);
    return textResponse("Expired", 410, contentHeaders());
  }

  const root = resolve(config.storageDir, upload.storagePath);
  const filePath = await resolveContentFile(root, assetPath, config.spaFallback);
  if (!filePath) {
    return textResponse("Not Found", 404, contentHeaders());
  }

  const info = await stat(filePath);
  const etag = contentEtag(upload, info.size, info.mtimeMs);
  const headers = {
    ...contentHeaders(),
    "Content-Type": mimeTypeForPath(filePath),
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  const file = Bun.file(filePath, { type: mimeTypeForPath(filePath) });
  return new Response(file, {
    status: 200,
    headers,
  });
}

async function resolveContentFile(root: string, assetPath: string, spaFallback: boolean): Promise<string | null> {
  const normalized = normalizeRequestPath(assetPath);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;

  async function candidate(path: string): Promise<string | null> {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(rootWithSep)) {
      return null;
    }
    try {
      const info = await stat(full);
      if (info.isDirectory()) {
        return await indexInside(path);
      }
      return info.isFile() ? full : null;
    } catch {
      return null;
    }
  }

  async function indexInside(path: string): Promise<string | null> {
    const prefix = path ? `${path}/` : "";
    return (await candidateFile(`${prefix}index.html`)) ?? (await candidateFile(`${prefix}index.htm`));
  }

  async function candidateFile(path: string): Promise<string | null> {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(rootWithSep)) {
      return null;
    }
    try {
      const info = await stat(full);
      return info.isFile() ? full : null;
    } catch {
      return null;
    }
  }

  if (!normalized || assetPath.endsWith("/")) {
    return await indexInside(normalized);
  }

  const exact = await candidate(normalized);
  if (exact) {
    return exact;
  }
  return spaFallback ? await indexInside("") : null;
}

function parseContentRoute(config: AppConfig, url: URL): { id: string; assetPath: string } | null {
  const sameHostMatch = url.pathname.match(/^\/content\/([^/]+)\/?(.*)$/);
  if (sameHostMatch) {
    return { id: sameHostMatch[1], assetPath: sameHostMatch[2] || "" };
  }

  if (!isContentHost(config, url)) {
    return null;
  }
  const contentHostMatch = url.pathname.match(/^\/([^/]+)\/?(.*)$/);
  if (!contentHostMatch) {
    return null;
  }
  return { id: contentHostMatch[1], assetPath: contentHostMatch[2] || "" };
}

function normalizeRequestPath(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new AppError(400, "invalid_path", "Request path is not valid URI encoding");
  }

  const parts: string[] = [];
  for (const part of decoded.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new AppError(400, "invalid_path", "Request path cannot contain traversal");
    }
    parts.push(part);
  }
  return parts.join("/");
}

async function handleAsset(pathname: string): Promise<Response> {
  const name = pathname.slice("/assets/".length);
  const builtType = BUILT_ASSET_TYPES.get(name);
  if (!builtType) {
    return textResponse("Not Found", 404);
  }

  const builtPath = join(process.cwd(), "dist", "client", "assets", name);
  try {
    const info = await stat(builtPath);
    if (!info.isFile()) {
      return textResponse("Not Found", 404);
    }
  } catch {
    return textResponse("Not Found", 404);
  }

  return new Response(Bun.file(builtPath, { type: builtType }), {
    status: 200,
    headers: {
      "Content-Type": builtType,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requireUploadToken(request: Request, config: AppConfig): void {
  if (!config.uploadToken) {
    return;
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${config.uploadToken}`) {
    throw new AppError(401, "unauthorized", "Upload token is required");
  }
}

async function requireEditToken(request: Request, upload: UploadRecord): Promise<void> {
  const metadata = parseUploadMetadata(upload.metadataJson);
  if (!metadata.editTokenHash) {
    throw new AppError(401, "edit_token_required", "Edit token is required");
  }

  const token = bearerToken(request) || request.headers.get("x-edit-token") || "";
  if (!token) {
    throw new AppError(401, "edit_token_required", "Edit token is required");
  }

  const actual = await sha256Text(token);
  if (!constantTimeEqual(actual, metadata.editTokenHash)) {
    throw new AppError(401, "invalid_edit_token", "Edit token is invalid");
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function rejectOversizedRequest(request: Request, limit: number, code: string): void {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > limit + REQUEST_OVERHEAD_ALLOWANCE_BYTES) {
    throw new AppError(413, code, `Request exceeds ${limit} bytes`);
  }
}

async function readMultipartForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new AppError(400, "invalid_multipart", "Request must be multipart form data");
  }
}

function formString(formData: FormData, name: string, maxLength: number): string | null {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim().slice(0, maxLength);
}

function resourceListPayload(config: AppConfig, upload: UploadRecord, resources: ResourceInfo[]) {
  const revision = uploadRevision(upload);
  return {
    id: upload.id,
    revision,
    contentRoot: contentRootUrl(config, upload.id),
    contentUrl: contentFrameSrc(config, upload.id, revision),
    resources,
    extractedBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
    fileCount: resources.length,
  };
}

function persistResourceMutation(
  repo: UploadsRepository,
  config: AppConfig,
  upload: UploadRecord,
  summary: ResourceWriteSummary,
) {
  const metadata = parseUploadMetadata(upload.metadataJson);
  const revision = (metadata.revision ?? 1) + 1;
  const metadataJson = serializeUploadMetadata({ ...metadata, revision });
  repo.updateMutableState(upload.id, {
    sha256: summary.sha256,
    extractedBytes: summary.extractedBytes,
    fileCount: summary.fileCount,
    metadataJson,
  });
  upload.metadataJson = metadataJson;
  return {
    id: upload.id,
    revision,
    contentRoot: contentRootUrl(config, upload.id),
    contentUrl: contentFrameSrc(config, upload.id, revision),
    resources: summary.resources,
    extractedBytes: summary.extractedBytes,
    fileCount: summary.fileCount,
  };
}

function clientIp(request: Request, server: AppServer | undefined, config: AppConfig): string {
  if (config.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return server?.requestIP(request)?.address ?? "unknown";
}

class UploadRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: AppConfig) {}

  check(ip: string): void {
    if (this.config.uploadRateLimitMax <= 0 || this.config.uploadRateLimitWindowSeconds <= 0) {
      return;
    }
    const now = Date.now();
    const since = now - this.config.uploadRateLimitWindowSeconds * 1000;
    const recent = (this.hits.get(ip) ?? []).filter((time) => time >= since);
    if (recent.length >= this.config.uploadRateLimitMax) {
      this.hits.set(ip, recent);
      throw new AppError(429, "rate_limit_exceeded", "Upload rate limit exceeded");
    }
    recent.push(now);
    this.hits.set(ip, recent);
  }
}

function isUploadExpired(upload: UploadRecord): boolean {
  if (upload.status === "deleted" || upload.status === "expired") {
    return true;
  }
  return Date.parse(upload.expiresAt) <= Date.now();
}

function markExpired(upload: UploadRecord, repo: UploadsRepository): void {
  if (upload.status === "ready") {
    repo.markExpired(upload.id);
    logEvent("info", "upload_expired", { id: upload.id, expiresAt: upload.expiresAt });
  }
}

function contentEtag(upload: UploadRecord, size: number, mtimeMs: number): string {
  return `W/"${upload.id}-${uploadRevision(upload)}-${size}-${Math.round(mtimeMs)}"`;
}

function htmlResponse(body: string, status: number, config: AppConfig): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...viewerHeaders(config),
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function viewerHeaders(config: AppConfig): Record<string, string> {
  const frameSources = ["'self'"];
  const origin = contentOrigin(config);
  if (origin) {
    frameSources.push(origin);
  }

  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `frame-src ${frameSources.join(" ")}`,
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Cache-Control": "no-store",
  };
}

function contentHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "public, max-age=0, must-revalidate",
  };
}

function handleError(error: unknown, pathname: string, config: AppConfig): Response {
  if (error instanceof AppError) {
    const event = error.status >= 500 ? "internal_error" : "validation_failure";
    logEvent(error.status >= 500 ? "error" : "warn", event, {
      path: pathname,
      status: error.status,
      code: error.code,
      message: error.message,
    });

    if (pathname.startsWith("/api/")) {
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    }
    return textResponse(error.message, error.status);
  }

  logEvent("error", "internal_error", {
    path: pathname,
    message: error instanceof Error ? error.message : String(error),
  });
  if (pathname.startsWith("/api/")) {
    return jsonResponse({ error: "Internal error", code: "internal_error" }, 500);
  }
  return htmlResponse(errorPage("Internal error", "The service could not complete the request."), 500, config);
}

function logEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}
