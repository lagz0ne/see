import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Server } from "bun";
import type { AppConfig } from "./config";
import {
  addOrReplaceResources,
  allocateClaimedId,
  decodeResourcePathFromUrl,
  deleteArtifact,
  deleteResource,
  listResources,
  randomEditToken,
  renameArtifact,
  sha256Text,
  storeUploadedArtifact,
  type ResourceWriteInput,
  type ResourceWriteSummary,
} from "./artifacts";
import { generateSuffix, normalizeClaimPrefix, SHARE_ID_PATTERN, splitShareId } from "./names";
import { applyPatchBatch, MAX_OPS_PER_BATCH } from "./patch/apply";
import type { RawOp } from "./patch/types";
import { UploadsRepository } from "./db";
import { mimeTypeForPath } from "./mime";
import { errorPage, expiredPage, notFoundPage, uploadPage, viewerPage } from "./pages";
import { deriveBundleState, MANIFEST_FILENAME, parseManifest, type BundleManifest } from "./bundle";
import {
  parseUploadMetadata,
  passwordRequired,
  serializeUploadMetadata,
  uploadBundle,
  uploadRevision,
  uploadWorkspace,
  type BundleState,
  type WorkspaceSettings,
} from "./upload-metadata";
import { contentFrameSrc, contentOrigin, contentRootUrl, isContentHost, viewerUrl } from "./urls";
import { AppError, type ResourceInfo, type UploadRecord } from "./types";
import { eventBus } from "./events";

type AppServer = Pick<Server<unknown>, "requestIP">;

const ID_PATTERN = SHARE_ID_PATTERN;
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
      if (method === "GET" && url.pathname === "/sdk/see-inspect.js") {
        return await handleSdk();
      }
      if (method === "GET" && url.pathname === "/llms.txt") {
        return await handleLlmsTxt();
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

      const apiSettingsMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/settings$/);
      if (apiSettingsMatch) {
        if (method === "GET") {
          return await handleGetSettings(apiSettingsMatch[1], repo, config);
        }
        if (method === "PATCH") {
          return await handlePatchSettings(request, apiSettingsMatch[1], repo, config);
        }
        return textResponse("Method Not Allowed", 405);
      }

      const apiEventsMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/events$/);
      if (apiEventsMatch) {
        if (method === "GET") {
          return handleEvents(request, apiEventsMatch[1], repo);
        }
        return textResponse("Method Not Allowed", 405);
      }

      const apiClaimMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/claim$/);
      if (apiClaimMatch) {
        if (method === "POST") {
          return await handleClaimName(request, apiClaimMatch[1], repo, config);
        }
        return textResponse("Method Not Allowed", 405);
      }

      const apiPatchMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/patch$/);
      if (apiPatchMatch) {
        if (method === "POST") {
          return await handlePatchBatch(request, apiPatchMatch[1], repo, config);
        }
        return textResponse("Method Not Allowed", 405);
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
  const editTokenHash = await hashEditToken(editToken);

  const artifact = await storeUploadedArtifact(config, files);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + config.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // A bundle upload (root see.json) is validated strictly here: a malformed manifest
  // rejects the whole upload so authors fail loudly. Clean the stored artifact on reject.
  let bundleWorkspace: WorkspaceSettings | undefined;
  let bundleState: BundleState | undefined;
  if (artifact.kind === "bundle") {
    try {
      const manifest = await readManifest(config, artifact.storagePath);
      if (manifest) {
        const derived = deriveBundleState(manifest, htmlPagesOf(artifact.resources), { strict: true });
        bundleWorkspace = Object.keys(derived.workspace).length > 0 ? derived.workspace : undefined;
        bundleState = derived.bundle;
      }
    } catch (error) {
      await deleteArtifact(config, artifact.storagePath);
      throw error;
    }
  }

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
    metadataJson: serializeUploadMetadata({
      editTokenHash,
      revision: 1,
      workspace: bundleWorkspace,
      bundle: bundleState,
    }),
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

async function handleGetSettings(id: string, repo: UploadsRepository, config: AppConfig): Promise<Response> {
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

  const workspace = uploadWorkspace(upload);
  const resources = await listResources(config, upload.storagePath);
  const htmlPages = resources
    .map((r) => r.path)
    .filter((p) => /\.(html|htm)$/i.test(p))
    .sort();

  return jsonResponse({
    id: upload.id,
    passwordRequired: passwordRequired(upload),
    homepage: workspace.homepage ?? null,
    exposed: workspace.exposed ?? [],
    barDefault: workspace.barDefault ?? true,
    tweaks: workspace.tweaks ?? {},
    htmlPages,
  });
}

async function handlePatchSettings(request: Request, id: string, repo: UploadsRepository, config: AppConfig): Promise<Response> {
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

  // Auth must be checked BEFORE applying any changes.
  await requireEditToken(request, upload);

  // Settings payloads are small; reject oversized bodies before buffering JSON.
  rejectOversizedRequest(request, 64 * 1024, "settings_too_large");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new AppError(400, "invalid_json", "Body must be JSON");
  }

  // For a bundle, see.json owns homepage/exposed/bar/tweaks — settings come from editing
  // the manifest. The password is not in the manifest, so it stays editable here.
  if (upload.kind === "bundle") {
    const managed = ["homepage", "exposed", "barDefault", "tweaks"].filter((key) => key in body);
    if (managed.length > 0) {
      throw new AppError(
        400,
        "bundle_managed",
        `This share is a bundle — edit see.json to change ${managed.join(", ")}`,
      );
    }
  }

  // Compute htmlPages for validation
  const resources = await listResources(config, upload.storagePath);
  const htmlPages = resources
    .map((r) => r.path)
    .filter((p) => /\.(html|htm)$/i.test(p))
    .sort();

  const currentMetadata = parseUploadMetadata(upload.metadataJson);
  const currentWorkspace = currentMetadata.workspace ?? {};

  // Build the new workspace by merging existing with provided fields
  const newWorkspace = { ...currentWorkspace };

  if ("homepage" in body) {
    const hp = body["homepage"];
    if (hp === null || hp === "") {
      delete newWorkspace.homepage;
    } else if (typeof hp === "string") {
      if (!htmlPages.includes(hp)) {
        throw new AppError(400, "invalid_setting", "homepage must be an existing HTML page");
      }
      newWorkspace.homepage = hp;
    }
  }

  if ("exposed" in body) {
    const exp = body["exposed"];
    if (!Array.isArray(exp) || !exp.every((e) => typeof e === "string")) {
      throw new AppError(400, "invalid_setting", "exposed must be an array of strings");
    }
    const invalid = exp.find((e) => !htmlPages.includes(e));
    if (invalid !== undefined) {
      throw new AppError(400, "invalid_setting", `exposed entry "${invalid}" must be an existing HTML page`);
    }
    newWorkspace.exposed = [...new Set(exp as string[])];
  }

  if ("barDefault" in body) {
    const bd = body["barDefault"];
    if (typeof bd !== "boolean") {
      throw new AppError(400, "invalid_setting", "barDefault must be a boolean");
    }
    newWorkspace.barDefault = bd;
  }

  if ("tweaks" in body) {
    const tw = body["tweaks"];
    if (!tw || typeof tw !== "object" || Array.isArray(tw)) {
      throw new AppError(400, "invalid_setting", "tweaks must be an object of primitive values");
    }
    const tweaksObj = tw as Record<string, unknown>;
    const tweakEntries = Object.entries(tweaksObj);
    if (tweakEntries.length > 100) {
      throw new AppError(400, "invalid_setting", "tweaks supports at most 100 keys");
    }
    for (const [k, v] of tweakEntries) {
      if (k.length > 64) {
        throw new AppError(400, "invalid_setting", "tweaks keys must be at most 64 characters");
      }
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new AppError(400, "invalid_setting", "tweaks must be an object of primitive values");
      }
      if (typeof v === "string" && v.length > 2048) {
        throw new AppError(400, "invalid_setting", "tweaks values must be at most 2048 characters");
      }
    }
    const validTweaks = tweaksObj as Record<string, string | number | boolean>;
    if (Object.keys(validTweaks).length === 0) {
      delete newWorkspace.tweaks;
    } else {
      newWorkspace.tweaks = validTweaks;
    }
  }

  // Handle password change only when the "password" key is present in the body
  let newEditTokenHash = currentMetadata.editTokenHash;
  if ("password" in body) {
    const pw = body["password"];
    if (pw === null || pw === "") {
      // Clear the password → public edit
      newEditTokenHash = undefined;
    } else if (typeof pw === "string") {
      newEditTokenHash = await hashEditToken(pw);
    }
  }

  // Build final metadata: preserve revision, update editTokenHash and workspace
  const newMetadata = {
    ...currentMetadata,
    ...(newEditTokenHash !== undefined ? { editTokenHash: newEditTokenHash } : { editTokenHash: undefined }),
    workspace: Object.keys(newWorkspace).length > 0 ? newWorkspace : undefined,
  };
  // Remove undefined keys for clean serialization
  if (newMetadata.editTokenHash === undefined) {
    delete newMetadata.editTokenHash;
  }
  if (newMetadata.workspace === undefined) {
    delete newMetadata.workspace;
  }

  const newMetadataJson = serializeUploadMetadata(newMetadata);
  repo.updateMetadata(upload.id, newMetadataJson);
  upload.metadataJson = newMetadataJson;
  eventBus.emit(upload.id, { type: "update", revision: uploadRevision(upload) });

  const updatedWorkspace = uploadWorkspace(upload);
  return jsonResponse({
    id: upload.id,
    passwordRequired: passwordRequired(upload),
    homepage: updatedWorkspace.homepage ?? null,
    exposed: updatedWorkspace.exposed ?? [],
    barDefault: updatedWorkspace.barDefault ?? true,
    tweaks: updatedWorkspace.tweaks ?? {},
    htmlPages,
  });
}

// Global cap on concurrent SSE streams so a client cannot exhaust memory/timers
// by opening unbounded connections (each holds a heartbeat timer + listener).
const MAX_SSE_CONNECTIONS = 1000;
let activeSseConnections = 0;

function handleEvents(request: Request, id: string, repo: UploadsRepository): Response {
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
  if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
    return jsonResponse({ error: "Too many live connections", code: "too_many_connections" }, 429);
  }

  const encoder = new TextEncoder();
  const initialRevision = uploadRevision(upload);

  // Shared cleanup state — captured in the closure so both start() and cancel() share it.
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    activeSseConnections -= 1;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
  }

  activeSseConnections += 1;

  // Construct under try/catch so a synchronous throw during stream setup still
  // releases the connection slot (cleanup is only wired up inside start()).
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new ReadableStream({
      start(controller) {
        function safeEnqueue(chunk: Uint8Array): void {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            cleanup();
          }
        }

        // Send the initial revision event immediately.
        safeEnqueue(encoder.encode("data: " + JSON.stringify({ type: "update", revision: initialRevision }) + "\n\n"));

        // Subscribe to future updates for this upload id.
        unsubscribe = eventBus.subscribe(id, (data) => {
          safeEnqueue(encoder.encode("data: " + JSON.stringify(data) + "\n\n"));
        });

        // Heartbeat every 25 seconds to keep the connection alive through proxies.
        heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(": ping\n\n"));
        }, 25_000);

        // Clean up when the client disconnects (abort signal fires on request cancellation).
        request.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        // Called when the consumer cancels the reader (e.g. reader.cancel() in tests).
        cleanup();
      },
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function claimPayload(config: AppConfig, upload: UploadRecord) {
  return {
    id: upload.id,
    viewerUrl: viewerUrl(config, upload.id),
    contentUrl: contentRootUrl(config, upload.id),
    revision: uploadRevision(upload),
  };
}

// POST /api/uploads/:id/claim — owner picks a friendly prefix ("name") for the share.
// The conflict-free suffix is preserved when possible so the id stays stable-ish.
async function handleClaimName(
  request: Request,
  id: string,
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

  // Renaming a share is an owner action — gate it behind the edit token.
  await requireEditToken(request, upload);
  rejectOversizedRequest(request, 64 * 1024, "claim_too_large");

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    throw new AppError(400, "invalid_json", "Body must be JSON");
  }

  const prefix = normalizeClaimPrefix(body.name);
  const current = splitShareId(upload.id);
  if (current?.prefix === prefix) {
    // Already claimed to this name — nothing to do.
    return jsonResponse(claimPayload(config, upload));
  }

  const oldId = upload.id;
  const oldStoragePath = upload.storagePath;
  const newId = await allocateClaimedId(
    config.storageDir,
    prefix,
    current?.suffix ?? generateSuffix(),
    (candidate) => repo.findById(candidate) !== null,
  );

  await renameArtifact(config, oldStoragePath, newId);
  try {
    repo.rename(oldId, newId, newId);
  } catch (error) {
    // Roll back the directory move so the share stays reachable under its old id.
    await renameArtifact(config, newId, oldStoragePath).catch(() => {});
    throw error;
  }
  upload.id = newId;
  upload.storagePath = newId;

  // Nudge any live viewers on the old id to follow the rename.
  eventBus.emit(oldId, {
    type: "renamed",
    id: newId,
    viewerUrl: viewerUrl(config, newId),
    contentUrl: contentRootUrl(config, newId),
  });

  logEvent("info", "share_claimed", { id: newId, previousId: oldId });

  return jsonResponse(claimPayload(config, upload));
}

async function handlePatchBatch(
  request: Request,
  id: string,
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

  // Auth before any read/write.
  await requireEditToken(request, upload);
  rejectOversizedRequest(request, config.maxExtractedFileBytes, "patch_too_large");

  let body: { ops?: unknown; dryRun?: unknown };
  try {
    body = (await request.json()) as { ops?: unknown; dryRun?: unknown };
  } catch {
    throw new AppError(400, "invalid_json", "Body must be JSON");
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    throw new AppError(400, "invalid_patch", 'Body must include a non-empty "ops" array');
  }
  if (body.ops.length > MAX_OPS_PER_BATCH) {
    throw new AppError(400, "too_many_ops", `A batch may contain at most ${MAX_OPS_PER_BATCH} ops`);
  }
  const dryRun = body.dryRun === true;

  const root = resolve(config.storageDir, upload.storagePath);
  const readFile = async (file: string): Promise<string | null> => {
    let decoded: string;
    try {
      decoded = decodeResourcePathFromUrl(file);
    } catch {
      return null;
    }
    const filePath = await resolveContentFile(root, decoded, false);
    if (!filePath) return null;
    return await Bun.file(filePath).text();
  };

  const batch = await applyPatchBatch(body.ops as RawOp[], readFile);

  // Atomic: if any op was invalid/unappliable, write nothing.
  if (!batch.ok) {
    return jsonResponse({ ok: false, dryRun, code: "patch_failed", results: batch.results }, 422);
  }

  // If the patch produces a new see.json, validate the resulting manifest loudly before
  // writing (also surfaced on dryRun). Patches can only edit existing files, so the HTML
  // page set is unchanged — validate against the current resource list.
  for (const [file, content] of batch.outputs) {
    if (decodeResourcePathFromUrl(file) !== MANIFEST_FILENAME) {
      continue;
    }
    try {
      const manifest = parseManifest(content);
      deriveBundleState(manifest, htmlPagesOf(await listResources(config, upload.storagePath)), { strict: true });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "see.json is invalid";
      return jsonResponse({ ok: false, dryRun, code: "invalid_manifest", error: message, results: batch.results }, 422);
    }
    break;
  }

  if (dryRun || batch.outputs.size === 0) {
    // Dry run, or every op legitimately matched zero nodes — report without writing.
    return jsonResponse({ ok: true, dryRun, revision: uploadRevision(upload), changed: [], results: batch.results });
  }

  const inputs: ResourceWriteInput[] = [];
  for (const [file, content] of batch.outputs) {
    const decoded = decodeResourcePathFromUrl(file);
    const f = new File([content], decoded.split("/").pop() || "resource", { type: mimeTypeForPath(decoded) });
    inputs.push({ file: f, path: decoded });
  }
  const summary = await addOrReplaceResources(config, upload.storagePath, inputs);
  const payload = await persistResourceMutation(repo, config, upload, summary);

  logEvent("info", "resource_patch_batch_success", {
    id: upload.id,
    opCount: body.ops.length,
    changedFiles: batch.outputs.size,
    revision: payload.revision,
  });

  return jsonResponse({
    ok: true,
    dryRun: false,
    revision: payload.revision,
    changed: [...batch.outputs.keys()],
    results: batch.results,
  });
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
    if (!resourcePath) {
      // No path specified — return the full resource list.
      return jsonResponse(resourceListPayload(config, upload, await listResources(config, upload.storagePath)));
    }
    // Non-empty path — serve the raw file bytes for the inline editor.
    const decodedPath = decodeResourcePathFromUrl(resourcePath);
    const root = resolve(config.storageDir, upload.storagePath);
    const filePath = await resolveContentFile(root, decodedPath, false);
    if (!filePath) {
      return jsonResponse({ error: "Resource not found", code: "resource_not_found" }, 404);
    }
    return new Response(Bun.file(filePath), {
      status: 200,
      headers: {
        "Content-Type": mimeTypeForPath(decodedPath),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
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
    const payload = await persistResourceMutation(repo, config, upload, summary);
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
    // Replacing a bundle's see.json: validate the new manifest loudly before writing.
    if (decodedPath === MANIFEST_FILENAME) {
      const manifest = parseManifest(new TextDecoder().decode(bytes));
      deriveBundleState(manifest, htmlPagesOf(await listResources(config, upload.storagePath)), { strict: true });
    }
    const file = new File([bytes], decodedPath.split("/").pop() || "resource", {
      type: request.headers.get("content-type") || "",
    });
    const summary = await addOrReplaceResources(config, upload.storagePath, [{ file, path: decodedPath }]);
    const payload = await persistResourceMutation(repo, config, upload, summary);
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
    const payload = await persistResourceMutation(repo, config, upload, summary);
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

  // For root requests, check workspace.homepage first; fall back to normal index resolution.
  let filePath: string | null;
  if (!assetPath) {
    const homepage = uploadWorkspace(upload).homepage;
    if (homepage && homepage.length > 0) {
      filePath = await resolveContentFile(root, homepage, false);
    } else {
      filePath = null;
    }
    if (!filePath) {
      filePath = await resolveContentFile(root, assetPath, config.spaFallback);
    }
  } else {
    filePath = await resolveContentFile(root, assetPath, config.spaFallback);
  }

  if (!filePath) {
    return textResponse("Not Found", 404, contentHeaders());
  }

  const info = await stat(filePath);
  const contentType = mimeTypeForPath(filePath);
  const etag = contentEtag(upload, info.size, info.mtimeMs);
  const headers: Record<string, string> = {
    ...contentHeaders(),
    "Content-Type": contentType,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  // Bundle wiring: when this is a bundle that opted into capabilities and we are serving
  // an HTML document, inject the first-party SDK + its config. This is the one place the
  // platform writes into uploaded content — only our own SDK, only for opted-in bundles,
  // only into sandboxed (no allow-same-origin) HTML.
  const bundle = upload.kind === "bundle" ? uploadBundle(upload) : undefined;
  if (bundle && bundle.capabilities.length > 0 && contentType.startsWith("text/html")) {
    const html = await Bun.file(filePath).text();
    const snippet = bundleInjectionSnippet(config, uploadWorkspace(upload), bundle);
    const injected = await injectBundleSdk(html, snippet);
    // Content-Length now reflects the rewritten body; ETag still keys on revision (which
    // bumps whenever see.json changes), so caches invalidate correctly.
    return new Response(injected, { status: 200, headers });
  }

  const file = Bun.file(filePath, { type: contentType });
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

// Serves the opt-in inspector SDK that uploaded pages include with a <script> tag. Served from
// source (not dist/) since it is hand-authored plain JS, and only on the public origin.
async function handleSdk(): Promise<Response> {
  const sdkPath = join(process.cwd(), "src", "sdk", "see-inspect.js");
  try {
    const info = await stat(sdkPath);
    if (!info.isFile()) {
      return textResponse("Not Found", 404);
    }
  } catch {
    return textResponse("Not Found", 404);
  }

  const type = "text/javascript; charset=utf-8";
  return new Response(Bun.file(sdkPath, { type }), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Serves the agent-facing capability docs at /llms.txt.
async function handleLlmsTxt(): Promise<Response> {
  const docsPath = join(process.cwd(), "src", "docs", "llms.txt");
  try {
    const info = await stat(docsPath);
    if (!info.isFile()) {
      return textResponse("Not Found", 404);
    }
  } catch {
    return textResponse("Not Found", 404);
  }

  const type = "text/plain; charset=utf-8";
  return new Response(Bun.file(docsPath, { type }), {
    status: 200,
    headers: {
      "Content-Type": type,
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

// Matches a legacy SHA-256 hex digest (64 lowercase hex chars) so we can keep
// verifying edit tokens stored before the switch to a slow password hash.
const LEGACY_SHA256_HASH = /^[0-9a-f]{64}$/;

// Hashes an edit token / password for storage. Uses a slow, salted KDF (argon2id
// via Bun.password) so a leaked metadata row cannot be brute-forced offline the
// way a bare SHA-256 digest could.
async function hashEditToken(value: string): Promise<string> {
  return Bun.password.hash(value);
}

// Verifies a presented token against a stored hash. Transparently handles both
// the new argon2id hashes and legacy SHA-256 digests from older uploads.
async function verifyEditToken(token: string, storedHash: string): Promise<boolean> {
  if (LEGACY_SHA256_HASH.test(storedHash)) {
    return constantTimeEqual(await sha256Text(token), storedHash);
  }
  try {
    return await Bun.password.verify(token, storedHash);
  } catch {
    return false;
  }
}

// Validates the password (edit token) for mutation requests.
// When no editTokenHash is set, the upload allows public editing — return immediately.
// When a hash is present, the Bearer token or x-edit-token header must match it.
async function requireEditToken(request: Request, upload: UploadRecord): Promise<void> {
  const metadata = parseUploadMetadata(upload.metadataJson);
  if (!metadata.editTokenHash) {
    // No password set — public edit, allow mutation.
    return;
  }

  const token = bearerToken(request) || request.headers.get("x-edit-token") || "";
  if (!token) {
    throw new AppError(401, "edit_token_required", "Edit token is required");
  }

  if (!(await verifyEditToken(token, metadata.editTokenHash))) {
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

function htmlPagesOf(resources: ResourceInfo[]): string[] {
  return resources
    .map((resource) => resource.path)
    .filter((path) => /\.(html|htm)$/i.test(path))
    .sort();
}

// Read + parse a bundle's root see.json. Returns null when there is no manifest. Throws
// AppError(invalid_manifest) on malformed JSON/schema (caller decides loud vs. lenient).
async function readManifest(config: AppConfig, storagePath: string): Promise<BundleManifest | null> {
  const file = Bun.file(join(resolve(config.storageDir, storagePath), MANIFEST_FILENAME));
  if (!(await file.exists())) {
    return null;
  }
  return parseManifest(await file.text());
}

// Re-derive workspace + bundle state from see.json after a mutation. Lenient: a malformed
// or stale manifest never throws here (loud validation happens pre-write in the editing
// paths) — it keeps the previous state so a write is never left half-applied.
async function rederiveManifestState(
  config: AppConfig,
  storagePath: string,
  resources: ResourceInfo[],
  previous: { workspace?: WorkspaceSettings; bundle?: BundleState },
): Promise<{ workspace?: WorkspaceSettings; bundle?: BundleState }> {
  try {
    const manifest = await readManifest(config, storagePath);
    if (!manifest) {
      return previous;
    }
    const derived = deriveBundleState(manifest, htmlPagesOf(resources), { strict: false });
    return {
      workspace: Object.keys(derived.workspace).length > 0 ? derived.workspace : undefined,
      bundle: derived.bundle,
    };
  } catch (error) {
    logEvent("warn", "manifest_rederive_failed", {
      storagePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return previous;
  }
}

// Build the <head> snippet that wires the first-party SDK into a bundle's served HTML:
// an inline config the SDK reads (capabilities, tweak defs+values, inspect targets) plus
// the SDK <script> loaded absolutely from the public origin.
function bundleInjectionSnippet(config: AppConfig, workspace: WorkspaceSettings, bundle: BundleState): string {
  const tweakValues = workspace.tweaks ?? {};
  const tweakDefs = bundle.tweakDefs ?? {};
  const tweaks: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(tweakValues)) {
    tweaks[id] = { ...(tweakDefs[id] ?? {}), value };
  }
  const payload = {
    capabilities: bundle.capabilities,
    ...(Object.keys(tweaks).length > 0 ? { tweaks } : {}),
    ...(bundle.inspect && bundle.inspect.length > 0 ? { inspect: bundle.inspect } : {}),
  };
  // Escape "<" so the JSON can never break out of the <script> element (</script>, <!--).
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const sdkUrl = `${config.publicBaseUrl}/sdk/see-inspect.js`;
  return `<script>window.__SEE_BUNDLE__=${json};</script><script src="${sdkUrl}"></script>`;
}

// Inject the snippet into served HTML using HTMLRewriter (safe on malformed markup).
// Prefers <head>; falls back to the start of <body>, then to prepending the document.
async function injectBundleSdk(html: string, snippet: string): Promise<string> {
  let injected = false;
  const headPass = new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(snippet, { html: true });
        injected = true;
      },
    })
    .transform(new Response(html));
  let out = await headPass.text();
  if (injected) {
    return out;
  }

  injected = false;
  const bodyPass = new HTMLRewriter()
    .on("body", {
      element(el) {
        el.prepend(snippet, { html: true });
        injected = true;
      },
    })
    .transform(new Response(out));
  out = await bodyPass.text();
  return injected ? out : snippet + out;
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

async function persistResourceMutation(
  repo: UploadsRepository,
  config: AppConfig,
  upload: UploadRecord,
  summary: ResourceWriteSummary,
) {
  const metadata = parseUploadMetadata(upload.metadataJson);
  const revision = (metadata.revision ?? 1) + 1;
  // Bundles: see.json is the source of truth, so re-derive workspace + bundle state on
  // every change. Non-bundles keep their existing workspace untouched.
  const { workspace, bundle } = await rederiveManifestState(config, upload.storagePath, summary.resources, {
    workspace: metadata.workspace,
    bundle: metadata.bundle,
  });
  const metadataJson = serializeUploadMetadata({ ...metadata, revision, workspace, bundle });
  repo.updateMutableState(upload.id, {
    sha256: summary.sha256,
    extractedBytes: summary.extractedBytes,
    fileCount: summary.fileCount,
    metadataJson,
  });
  upload.metadataJson = metadataJson;
  eventBus.emit(upload.id, { type: "update", revision });
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
  private static readonly MAX_TRACKED_IPS = 50_000;

  constructor(private readonly config: AppConfig) {}

  check(ip: string): void {
    if (this.config.uploadRateLimitMax <= 0 || this.config.uploadRateLimitWindowSeconds <= 0) {
      return;
    }
    const now = Date.now();
    const since = now - this.config.uploadRateLimitWindowSeconds * 1000;
    // Hard-bound the map so distinct keys cannot grow memory unboundedly. Map
    // preserves insertion order, so the first key is the oldest-tracked IP —
    // evicting it is O(1) and keeps this off the per-request hot path.
    if (!this.hits.has(ip) && this.hits.size >= UploadRateLimiter.MAX_TRACKED_IPS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) {
        this.hits.delete(oldest);
      }
    }
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
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), display-capture=(self)",
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
