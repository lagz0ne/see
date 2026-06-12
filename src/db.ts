import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { UploadKind, UploadRecord, UploadStatus } from "./types";

type UploadRow = {
  id: string;
  title: string | null;
  original_filename: string;
  kind: UploadKind;
  status: UploadStatus;
  sha256: string;
  upload_bytes: number;
  extracted_bytes: number;
  file_count: number;
  storage_path: string;
  created_at: string;
  expires_at: string;
  deleted_at: string | null;
  metadata_json: string | null;
};

export class UploadsRepository {
  db: Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        title TEXT NULL,
        original_filename TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('html', 'zip', 'resources', 'bundle')),
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'expired', 'deleted')),
        sha256 TEXT NOT NULL,
        upload_bytes INTEGER NOT NULL,
        extracted_bytes INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        deleted_at TEXT NULL,
        metadata_json TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON uploads(expires_at);
      CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);
    `);
  }

  insert(record: UploadRecord): void {
    this.db
      .query(
        `INSERT INTO uploads (
          id, title, original_filename, kind, status, sha256, upload_bytes,
          extracted_bytes, file_count, storage_path, created_at, expires_at,
          deleted_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.title,
        record.originalFilename,
        record.kind,
        record.status,
        record.sha256,
        record.uploadBytes,
        record.extractedBytes,
        record.fileCount,
        record.storagePath,
        record.createdAt,
        record.expiresAt,
        record.deletedAt,
        record.metadataJson,
      );
  }

  findById(id: string): UploadRecord | null {
    const row = this.db.query("SELECT * FROM uploads WHERE id = ?").get(id) as UploadRow | null;
    return row ? fromRow(row) : null;
  }

  markExpired(id: string): void {
    this.db
      .query("UPDATE uploads SET status = 'expired' WHERE id = ? AND status = 'ready'")
      .run(id);
  }

  markDeleted(id: string, deletedAt: string): void {
    this.db
      .query("UPDATE uploads SET status = 'deleted', deleted_at = ? WHERE id = ?")
      .run(deletedAt, id);
  }

  updateMutableState(
    id: string,
    values: {
      sha256: string;
      extractedBytes: number;
      fileCount: number;
      metadataJson: string;
    },
  ): void {
    this.db
      .query(
        `UPDATE uploads
          SET sha256 = ?, extracted_bytes = ?, file_count = ?, metadata_json = ?
          WHERE id = ? AND status = 'ready'`,
      )
      .run(values.sha256, values.extractedBytes, values.fileCount, values.metadataJson, id);
  }

  // Reassigns a share's id (and matching storage path) when its friendly prefix is
  // claimed. The id is the primary key; SQLite permits updating it and there are no
  // foreign keys referencing uploads.
  rename(oldId: string, newId: string, newStoragePath: string): void {
    this.db
      .query("UPDATE uploads SET id = ?, storage_path = ? WHERE id = ? AND status = 'ready'")
      .run(newId, newStoragePath, oldId);
  }

  updateMetadata(id: string, metadataJson: string): void {
    this.db
      .query("UPDATE uploads SET metadata_json = ? WHERE id = ? AND status = 'ready'")
      .run(metadataJson, id);
  }


  expiredForCleanup(nowIso: string): UploadRecord[] {
    const rows = this.db
      .query("SELECT * FROM uploads WHERE expires_at <= ? AND status IN ('ready', 'expired') ORDER BY expires_at ASC")
      .all(nowIso) as UploadRow[];
    return rows.map(fromRow);
  }

  close(): void {
    this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.close(false);
  }
}

function fromRow(row: UploadRow): UploadRecord {
  return {
    id: row.id,
    title: row.title,
    originalFilename: row.original_filename,
    kind: row.kind,
    status: row.status,
    sha256: row.sha256,
    uploadBytes: row.upload_bytes,
    extractedBytes: row.extracted_bytes,
    fileCount: row.file_count,
    storagePath: row.storage_path,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
    metadataJson: row.metadata_json,
  };
}
