import { access, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import type { AppConfig } from "./config";
import { mimeTypeForPath } from "./mime";
import { extractZipArtifact } from "./zip";
import { MANIFEST_FILENAME } from "./bundle";
import { renderGeneratedIndex } from "./generated-index";
import { copyBytes } from "./lib/bytes";
import { buildShareId, generateArtifactId, generateSuffix } from "./names";
import { AppError, type ResourceInfo, type StoredArtifact, type UploadKind } from "./types";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

export type ResourceWriteInput = {
  file: File;
  path?: string | null;
};

export type ResourceWriteSummary = {
  resources: ResourceInfo[];
  extractedBytes: number;
  fileCount: number;
  sha256: string;
};

type PreparedResourceInput = {
  file: File;
  path: string;
};

export async function storeUploadedArtifact(config: AppConfig, input: File | File[]): Promise<StoredArtifact> {
  const files = Array.isArray(input) ? input : [input];
  if (files.length === 0) {
    throw new AppError(400, "missing_file", "Multipart field 'file' is required");
  }

  const uploadBytes = files.reduce((total, file) => total + file.size, 0);
  if (uploadBytes > config.maxUploadBytes) {
    throw new AppError(413, "upload_too_large", `Upload exceeds ${config.maxUploadBytes} bytes`);
  }

  await mkdir(config.storageDir, { recursive: true });

  const id = await allocateArtifactId(config.storageDir);
  const tempDir = await mkdtemp(join(config.storageDir, ".tmp-"));
  const finalDir = join(config.storageDir, id);

  try {
    const artifact =
      files.length === 1
        ? await storeSingleInitialArtifact(config, files[0], tempDir, uploadBytes)
        : await storeInitialResourceSet(config, files, tempDir, uploadBytes);
    // A root see.json promotes the upload to a first-class bundle. (A single .html upload
    // is stored as index.html and can never carry a manifest, so this only hits zip/resources.)
    const kind = artifact.resources.some((resource) => resource.path === MANIFEST_FILENAME)
      ? "bundle"
      : artifact.kind;
    await rename(tempDir, finalDir);
    return {
      id,
      storagePath: id,
      ...artifact,
      kind,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    await rm(finalDir, { recursive: true, force: true });
    throw error;
  }
}

export async function addOrReplaceResources(
  config: AppConfig,
  storagePath: string,
  inputs: ResourceWriteInput[],
): Promise<ResourceWriteSummary> {
  const root = resolve(config.storageDir, storagePath);
  return writeResourceFilesToRoot(config, root, inputs, { allowHtmlIndexFallback: false });
}

export async function deleteResource(
  config: AppConfig,
  storagePath: string,
  resourcePath: string,
): Promise<ResourceWriteSummary> {
  const root = resolve(config.storageDir, storagePath);
  const normalizedPath = normalizeResourcePath(resourcePath, config.maxPathDepth);
  const existing = await listResourcesAtRoot(root);
  const target = existing.find((resource) => resource.path === normalizedPath);
  if (!target) {
    throw new AppError(404, "resource_not_found", "Resource not found");
  }

  if (isIndexPath(normalizedPath) && !existing.some((resource) => resource.path !== normalizedPath && isIndexPath(resource.path))) {
    throw new AppError(400, "missing_index", "A share must keep an index.html or index.htm resource");
  }

  await unlink(resolveResourceFile(root, normalizedPath));
  await removeEmptyParents(root, posix.dirname(normalizedPath));
  return await summarizeResourceList(await listResourcesAtRoot(root));
}

export async function listResources(config: AppConfig, storagePath: string): Promise<ResourceInfo[]> {
  return listResourcesAtRoot(resolve(config.storageDir, storagePath));
}

export async function deleteArtifact(config: AppConfig, storagePath: string): Promise<void> {
  await rm(join(config.storageDir, storagePath), { recursive: true, force: true });
}

export function decodeResourcePathFromUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(400, "invalid_path", "Resource path is not valid URI encoding");
  }
}

// Canonicalize a stored resource path. Intentionally does NOT trim surrounding whitespace, so it
// stays aligned with the archive normalizer (zip.ts `normalizeArchivePath`): a whitespace-named
// zip resource is stored verbatim and must remain addressable for read/edit/delete. The resource
// WRITE path additionally trims (see `inputWritePath` / `resourceWritePath`) — guards that
// validate a write must canonicalize through those, not this, to match what the writer stores.
export function normalizeResourcePath(rawName: string, maxPathDepth: number): string {
  const name = rawName.replaceAll("\\", "/");
  if (name.includes("\0")) {
    throw new AppError(400, "invalid_resource_path", "Resource path cannot contain a null byte");
  }
  if (name.startsWith("/") || name.startsWith("//") || /^[a-zA-Z]:/.test(name)) {
    throw new AppError(400, "invalid_resource_path", "Resource path cannot be absolute");
  }

  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new AppError(400, "invalid_resource_path", "Resource path cannot contain traversal");
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new AppError(400, "invalid_resource_path", "Resource path is required");
  }
  if (parts.length > maxPathDepth) {
    throw new AppError(400, "resource_path_too_deep", `Resource path exceeds ${maxPathDepth} segments`);
  }
  return parts.join("/");
}

// The exact stored path the resource writer (`writeResourceFilesToRoot`) produces for a
// client-supplied path string: trim THEN normalize. Guards that validate a write — most notably
// the strict see.json manifest check — MUST address the path through this, because a guard that
// canonicalizes differently from the writer is precisely how malformed-manifest bypasses recur
// (`./see.json`, `see.json/`, `"%20see.json%20"`).
export function resourceWritePath(rawPath: string, maxPathDepth: number): string {
  return normalizeResourcePath(rawPath.trim(), maxPathDepth);
}

// The stored path the writer produces for a whole write input — the provided path (trimmed) or,
// when absent, the file's own name. This is the single canonicalization shared by the writer and
// the multipart see.json guard so the two cannot drift.
export function inputWritePath(input: ResourceWriteInput, maxPathDepth: number): string {
  return normalizeResourcePath(input.path?.trim() || browserFilePath(input.file), maxPathDepth);
}

export function randomEditToken(): string {
  return `t_${randomBase64Url(18)}`;
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBytes(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function manifestSha256(resources: ResourceInfo[]): Promise<string> {
  const manifest = resources
    .map((resource) => `${resource.path}\0${resource.bytes}\0${resource.sha256}`)
    .join("\n");
  return sha256Text(manifest);
}

async function storeSingleInitialArtifact(
  config: AppConfig,
  file: File,
  destination: string,
  uploadBytes: number,
): Promise<Omit<StoredArtifact, "id" | "storagePath">> {
  const originalFilename = file.name || "upload";
  const extension = getExtension(originalFilename);
  const kind = kindFromExtension(extension);
  if (!kind) {
    throw new AppError(400, "invalid_file_type", "Upload must be a .html, .htm, .zip, or multiple static resource files");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Bytes(bytes);

  if (kind === "html") {
    await storeHtml(bytes, destination);
  } else {
    await storeZip(bytes, destination, config);
  }

  const resources = await listResourcesAtRoot(destination);
  const stats = summarizeResources(resources);
  return {
    kind,
    sha256,
    uploadBytes,
    extractedBytes: stats.extractedBytes,
    fileCount: stats.fileCount,
    resources,
  };
}

async function storeInitialResourceSet(
  config: AppConfig,
  files: File[],
  destination: string,
  uploadBytes: number,
): Promise<Omit<StoredArtifact, "id" | "storagePath">> {
  await writeResourceFilesToRoot(
    config,
    destination,
    files.map((file) => ({ file })),
    { allowHtmlIndexFallback: true },
  );
  await ensureGeneratedIndex(destination);
  const summary = await summarizeResourceList(await listResourcesAtRoot(destination));
  return {
    kind: "resources",
    sha256: summary.sha256,
    uploadBytes,
    extractedBytes: summary.extractedBytes,
    fileCount: summary.fileCount,
    resources: summary.resources,
  };
}

// Generate a fallback index page when an upload has no index.html (a real index always wins).
async function ensureGeneratedIndex(root: string): Promise<void> {
  const resources = await listResourcesAtRoot(root);
  if (resources.length === 0 || hasIndexResource(resources)) {
    return;
  }
  await Bun.write(join(root, "index.html"), renderGeneratedIndex(resources));
}

async function storeHtml(bytes: Uint8Array, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await Bun.write(join(destination, "index.html"), bytes);
}

async function storeZip(bytes: Uint8Array, destination: string, config: AppConfig): Promise<void> {
  await mkdir(destination, { recursive: true });
  await extractZipArtifact(bytes, destination, {
    maxExtractedBytes: config.maxExtractedBytes,
    maxFileCount: config.maxFileCount,
    maxPathDepth: config.maxPathDepth,
    maxExtractedFileBytes: config.maxExtractedFileBytes,
  });
  await ensureGeneratedIndex(destination);
}

async function writeResourceFilesToRoot(
  config: AppConfig,
  root: string,
  inputs: ResourceWriteInput[],
  options: { allowHtmlIndexFallback: boolean },
): Promise<ResourceWriteSummary> {
  await mkdir(root, { recursive: true });
  const existing = await listResourcesAtRoot(root);
  const existingByPath = new Map(existing.map((resource) => [resource.path, resource]));
  const prepared = prepareResourceInputs(config, inputs, options.allowHtmlIndexFallback);

  let nextBytes = existing.reduce((total, resource) => total + resource.bytes, 0);
  let nextCount = existing.length;

  for (const resource of prepared) {
    if (resource.file.size > config.maxExtractedFileBytes) {
      throw new AppError(413, "resource_too_large", `Resource exceeds ${config.maxExtractedFileBytes} bytes: ${resource.path}`);
    }
    const previous = existingByPath.get(resource.path);
    if (!previous) {
      nextCount += 1;
    }
    nextBytes = nextBytes - (previous?.bytes ?? 0) + resource.file.size;
  }

  if (nextCount > config.maxFileCount) {
    throw new AppError(413, "too_many_files", `Share exceeds ${config.maxFileCount} resources`);
  }
  if (nextBytes > config.maxExtractedBytes) {
    throw new AppError(413, "extracted_archive_too_large", `Share exceeds ${config.maxExtractedBytes} stored bytes`);
  }

  for (const resource of prepared) {
    const targetPath = resolveResourceFile(root, resource.path);
    await mkdir(dirname(targetPath), { recursive: true });
    const bytes = new Uint8Array(await resource.file.arrayBuffer());
    const tempPath = join(dirname(targetPath), `.tmp-${randomBase64Url(9)}`);
    await Bun.write(tempPath, bytes);
    await rename(tempPath, targetPath);
  }

  const resources = await listResourcesAtRoot(root);
  return await summarizeResourceList(resources);
}

function prepareResourceInputs(
  config: AppConfig,
  inputs: ResourceWriteInput[],
  allowHtmlIndexFallback: boolean,
): PreparedResourceInput[] {
  if (inputs.length === 0) {
    throw new AppError(400, "missing_file", "Multipart field 'file' is required");
  }

  const prepared = inputs.map((input) => ({
    file: input.file,
    path: inputWritePath(input, config.maxPathDepth),
  }));

  if (allowHtmlIndexFallback && !prepared.some((resource) => isIndexPath(resource.path))) {
    const htmlResources = prepared.filter((resource) => HTML_EXTENSIONS.has(getExtension(resource.path)));
    if (htmlResources.length === 1) {
      htmlResources[0].path = "index.html";
    }
  }

  const seen = new Set<string>();
  for (const resource of prepared) {
    if (seen.has(resource.path)) {
      throw new AppError(400, "duplicate_resource_path", `Duplicate resource path: ${resource.path}`);
    }
    seen.add(resource.path);
  }

  return prepared;
}

async function listResourcesAtRoot(root: string): Promise<ResourceInfo[]> {
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const resources: ResourceInfo[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const directory = relativeDir ? join(root, relativeDir) : root;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const fullPath = join(root, relativePath);
      const info = await lstat(fullPath);
      const bytes = new Uint8Array(await Bun.file(fullPath).arrayBuffer());
      resources.push({
        path: relativePath,
        bytes: info.size,
        sha256: await sha256Bytes(bytes),
        updatedAt: info.mtime.toISOString(),
        contentType: mimeTypeForPath(relativePath),
      });
    }
  }

  await walk("");
  return resources.sort((left, right) => left.path.localeCompare(right.path));
}

async function summarizeResourceList(resources: ResourceInfo[]): Promise<ResourceWriteSummary> {
  const stats = summarizeResources(resources);
  return {
    resources,
    ...stats,
    sha256: await manifestSha256(resources),
  };
}

function summarizeResources(resources: ResourceInfo[]): { extractedBytes: number; fileCount: number } {
  return {
    extractedBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
    fileCount: resources.length,
  };
}

async function artifactDirExists(storageDir: string, id: string): Promise<boolean> {
  try {
    await access(join(storageDir, id));
    return true;
  } catch {
    return false;
  }
}

async function allocateArtifactId(storageDir: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = generateArtifactId();
    if (!(await artifactDirExists(storageDir, id))) {
      return id;
    }
  }
  throw new AppError(500, "id_generation_failed", "Could not allocate a unique upload ID");
}

/**
 * Finds a free id for a claimed prefix. Prefers `<prefix>-<preferredSuffix>` (so a
 * claim keeps the share's existing suffix when possible); if that is taken, draws
 * fresh suffixes until one is free. `taken` lets the caller veto ids that exist in
 * the database even if no directory does.
 */
export async function allocateClaimedId(
  storageDir: string,
  prefix: string,
  preferredSuffix: string,
  taken: (id: string) => boolean = () => false,
): Promise<string> {
  const candidates = [preferredSuffix];
  for (let i = 0; i < 8; i += 1) {
    candidates.push(generateSuffix());
  }
  for (const suffix of candidates) {
    const id = buildShareId(prefix, suffix);
    if (!taken(id) && !(await artifactDirExists(storageDir, id))) {
      return id;
    }
  }
  throw new AppError(500, "id_generation_failed", "Could not allocate a unique name");
}

/** Renames a stored artifact directory (used when a share's prefix is claimed). */
export async function renameArtifact(config: AppConfig, fromStoragePath: string, toStoragePath: string): Promise<void> {
  await rename(join(config.storageDir, fromStoragePath), join(config.storageDir, toStoragePath));
}

function resolveResourceFile(root: string, resourcePath: string): string {
  const full = resolve(root, resourcePath);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (full !== root && full.startsWith(rootWithSep)) {
    return full;
  }
  throw new AppError(400, "invalid_resource_path", "Resource path escapes the share root");
}

async function removeEmptyParents(root: string, relativeDir: string): Promise<void> {
  let current = relativeDir;
  while (current && current !== ".") {
    try {
      await rmdir(join(root, current));
    } catch {
      return;
    }
    current = posix.dirname(current);
  }
}

function hasIndexResource(resources: ResourceInfo[]): boolean {
  return resources.some((resource) => isIndexPath(resource.path));
}

function isIndexPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "index.html" || lower === "index.htm";
}

function kindFromExtension(extension: string): UploadKind | null {
  if (HTML_EXTENSIONS.has(extension)) {
    return "html";
  }
  if (extension === ".zip") {
    return "zip";
  }
  return null;
}

function getExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

function browserFilePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath || file.name || "resource";
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

