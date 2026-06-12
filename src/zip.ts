import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { AppError } from "./types";
import { copyBytes } from "./lib/bytes";

export type ZipLimits = {
  maxExtractedBytes: number;
  maxFileCount: number;
  maxPathDepth: number;
  maxExtractedFileBytes: number;
};

export type ExtractionStats = {
  extractedBytes: number;
  fileCount: number;
};

type ZipEntry = {
  rawName: string;
  normalizedPath: string;
  isDirectory: boolean;
  compressionMethod: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

export async function extractZipArtifact(bytes: Uint8Array, destination: string, limits: ZipLimits): Promise<ExtractionStats> {
  const entries = parseCentralDirectory(bytes, limits);
  const files = entries.filter((entry) => !entry.isDirectory);
  if (files.length === 0) {
    throw new AppError(400, "empty_archive", "Zip archive does not contain any files");
  }

  const prefix = chooseRootPrefix(files);
  const seen = new Set<string>();
  let extractedBytes = 0;
  let fileCount = 0;

  for (const entry of files) {
    if (!entry.normalizedPath.startsWith(prefix)) {
      continue;
    }

    const outputPath = entry.normalizedPath.slice(prefix.length);
    if (!outputPath) {
      continue;
    }
    if (seen.has(outputPath)) {
      throw new AppError(400, "duplicate_archive_path", `Archive contains duplicate path after normalization: ${outputPath}`);
    }
    seen.add(outputPath);

    fileCount += 1;
    if (fileCount > limits.maxFileCount) {
      throw new AppError(413, "too_many_files", `Archive exceeds ${limits.maxFileCount} files`);
    }
    if (entry.uncompressedSize > limits.maxExtractedFileBytes) {
      throw new AppError(413, "extracted_file_too_large", `Archive entry exceeds ${limits.maxExtractedFileBytes} bytes: ${outputPath}`);
    }

    extractedBytes += entry.uncompressedSize;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new AppError(413, "extracted_archive_too_large", `Archive exceeds ${limits.maxExtractedBytes} extracted bytes`);
    }

    const content = inflateEntry(bytes, entry, limits.maxExtractedFileBytes);
    if (content.byteLength !== entry.uncompressedSize) {
      throw new AppError(422, "zip_size_mismatch", `Archive entry size mismatch: ${outputPath}`);
    }

    const finalPath = join(destination, outputPath);
    await mkdir(dirname(finalPath), { recursive: true });
    await Bun.write(finalPath, copyBytes(content));
  }

  return { extractedBytes, fileCount };
}

function parseCentralDirectory(bytes: Uint8Array, limits: ZipLimits): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new AppError(422, "invalid_zip", "Zip archive is missing an end-of-central-directory record");
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const recordsOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalRecords = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || recordsOnDisk !== totalRecords) {
    throw new AppError(422, "unsupported_zip", "Multi-disk zip archives are not supported");
  }
  if (centralDirectorySize === ZIP64_SENTINEL || centralDirectoryOffset === ZIP64_SENTINEL || totalRecords === 0xffff) {
    throw new AppError(422, "unsupported_zip64", "ZIP64 archives are not supported in the MVP");
  }
  if (totalRecords > limits.maxFileCount * 2) {
    throw new AppError(413, "too_many_entries", `Archive exceeds ${limits.maxFileCount} files`);
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.byteLength) {
    throw new AppError(422, "invalid_zip", "Zip central directory points outside the uploaded file");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let i = 0; i < totalRecords; i += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new AppError(422, "invalid_zip", "Zip central directory is malformed");
    }

    const versionMadeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;

    if (nextOffset > bytes.byteLength) {
      throw new AppError(422, "invalid_zip", "Zip central directory entry points outside the uploaded file");
    }
    if ((flags & 0x1) !== 0) {
      throw new AppError(400, "encrypted_zip", "Encrypted zip archives are not supported");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new AppError(422, "unsupported_compression", `Unsupported zip compression method: ${compressionMethod}`);
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new AppError(422, "unsupported_zip64", "ZIP64 archives are not supported in the MVP");
    }

    const rawName = decodeFileName(bytes.subarray(offset + 46, offset + 46 + fileNameLength), (flags & 0x800) !== 0);
    const normalizedPath = normalizeArchivePath(rawName, limits.maxPathDepth);
    const isDirectory = rawName.endsWith("/") || normalizedPath === "";
    const creatorSystem = versionMadeBy >> 8;
    const unixMode = externalAttributes >>> 16;
    if (creatorSystem === 3 && (unixMode & 0o170000) === 0o120000) {
      throw new AppError(400, "symlink_archive", `Archive contains a symlink: ${rawName}`);
    }

    entries.push({
      rawName,
      normalizedPath,
      isDirectory,
      compressionMethod,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
    });
    offset = nextOffset;
  }

  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumSize = 22;
  const maxCommentLength = 0xffff;
  const start = Math.max(0, view.byteLength - minimumSize - maxCommentLength);
  for (let offset = view.byteLength - minimumSize; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + minimumSize + commentLength === view.byteLength) {
        return offset;
      }
    }
  }
  return -1;
}

function decodeFileName(bytes: Uint8Array, utf8: boolean): string {
  const decoder = new TextDecoder(utf8 ? "utf-8" : "latin1", { fatal: false });
  return decoder.decode(bytes);
}

export function normalizeArchivePath(rawName: string, maxPathDepth: number): string {
  const name = rawName.replaceAll("\\", "/");
  if (name.includes("\0")) {
    throw new AppError(400, "unsafe_archive_path", "Archive contains a path with a null byte");
  }
  if (name.startsWith("/") || name.startsWith("//") || /^[a-zA-Z]:/.test(name)) {
    throw new AppError(400, "unsafe_archive_path", `Archive contains an absolute path: ${rawName}`);
  }

  const parts: string[] = [];
  for (const part of name.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new AppError(400, "unsafe_archive_path", `Archive contains path traversal: ${rawName}`);
    }
    parts.push(part);
  }

  if (parts.length > maxPathDepth) {
    throw new AppError(400, "archive_path_too_deep", `Archive path exceeds ${maxPathDepth} segments: ${rawName}`);
  }
  return parts.join("/");
}

function chooseRootPrefix(files: ZipEntry[]): string {
  const lowerPaths = files.map((entry) => entry.normalizedPath.toLowerCase());
  if (lowerPaths.includes("index.html") || lowerPaths.includes("index.htm")) {
    return "";
  }

  const topLevels = new Set<string>();
  let hasRootFile = false;
  for (const entry of files) {
    const parts = entry.normalizedPath.split("/");
    topLevels.add(parts[0] ?? "");
    if (parts.length === 1) {
      hasRootFile = true;
    }
  }

  // Single wrapper directory with no root-level files: strip it so contents sit at the root.
  if (topLevels.size === 1 && !hasRootFile) {
    const [topLevel] = [...topLevels];
    return `${topLevel}/`;
  }

  return "";
}

function inflateEntry(bytes: Uint8Array, entry: ZipEntry, maxOutputBytes: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.byteLength || view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
    throw new AppError(422, "invalid_zip", `Zip local file header is malformed: ${entry.rawName}`);
  }

  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) {
    throw new AppError(422, "invalid_zip", `Zip entry data points outside the uploaded file: ${entry.rawName}`);
  }

  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    if (compressed.byteLength > maxOutputBytes) {
      throw new AppError(413, "extracted_file_too_large", `Archive entry exceeds ${maxOutputBytes} bytes: ${entry.rawName}`);
    }
    return copyBytes(compressed);
  }

  // Cap the decompressed output so a malicious entry that lies about its
  // uncompressedSize in the central directory cannot force a huge allocation
  // (zip-bomb) before the post-inflate size check runs.
  try {
    return copyBytes(inflateRawSync(copyBytes(compressed), { maxOutputLength: maxOutputBytes }));
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AppError(413, "extracted_file_too_large", `Archive entry exceeds ${maxOutputBytes} bytes: ${entry.rawName}`);
    }
    throw new AppError(422, "extraction_failed", `Failed to inflate zip entry: ${entry.rawName}`);
  }
}

