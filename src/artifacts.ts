import { access, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import type { AppConfig } from "./config";
import { mimeTypeForPath } from "./mime";
import { extractZipArtifact } from "./zip";
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
    await rename(tempDir, finalDir);
    return {
      id,
      storagePath: id,
      ...artifact,
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
  return writeResourceFilesToRoot(config, root, inputs, { allowHtmlIndexFallback: false, requireIndex: false });
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

export function randomArtifactId(): string {
  return `u_${randomBase64Url(9)}`;
}

export function randomEditToken(): string {
  return `t_${randomBase64Url(18)}`;
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digestInput = copyBytes(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
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
  const summary = await writeResourceFilesToRoot(
    config,
    destination,
    files.map((file) => ({ file })),
    { allowHtmlIndexFallback: true, requireIndex: true },
  );
  return {
    kind: "resources",
    sha256: summary.sha256,
    uploadBytes,
    extractedBytes: summary.extractedBytes,
    fileCount: summary.fileCount,
    resources: summary.resources,
  };
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
}

async function writeResourceFilesToRoot(
  config: AppConfig,
  root: string,
  inputs: ResourceWriteInput[],
  options: { allowHtmlIndexFallback: boolean; requireIndex: boolean },
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
  if (options.requireIndex && !hasIndexResource(resources)) {
    throw new AppError(400, "missing_index", "Resource uploads must include an index.html or index.htm file");
  }
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
    path: normalizeResourcePath(input.path?.trim() || browserFilePath(input.file), config.maxPathDepth),
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

async function allocateArtifactId(storageDir: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomArtifactId();
    try {
      await access(join(storageDir, id));
    } catch {
      return id;
    }
  }
  throw new AppError(500, "id_generation_failed", "Could not allocate a unique upload ID");
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

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
