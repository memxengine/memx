/**
 * F153 — Pluggable backup destination interface.
 *
 * Shape intentionally mirrors @webhouse/cms's BackupProvider interface so
 * a future Tigris / generic-S3 / pCloud adapter drops in without
 * touching the scheduler. Today's only live provider is R2; others stay
 * roadmap until real demand shows up.
 */

import type { Readable } from 'node:stream';

export interface BackupProvider {
  readonly id: string;
  readonly name: string;

  /**
   * Upload a backup file. Implementations should use multipart upload so
   * file size isn't bounded by a single-PUT ceiling. Returns the key
   * (not the local path) that was written + the byte count the provider
   * observed.
   */
  upload(
    filename: string,
    body: Readable,
    contentLength: number,
  ): Promise<{ key: string; size: number }>;

  /** List all backups under the provider's configured prefix. */
  list(): Promise<CloudBackupFile[]>;

  /** Stream a specific backup back. */
  download(filename: string): Promise<Readable>;

  /** Delete one backup from the provider. */
  delete(filename: string): Promise<void>;

  /**
   * Verify connectivity + permissions without uploading. Used by the
   * admin "test connection" button. Returns ok=true and a human string
   * on success; ok=false with a user-safe message on any failure.
   */
  test(): Promise<{ ok: boolean; message: string }>;
}

export interface CloudBackupFile {
  /** File name relative to the provider's configured prefix. */
  filename: string;
  /** Bytes. */
  size: number;
  /** ISO timestamp of last-modified according to the provider. */
  lastModified: string;
}

/** Top-level config selecting which provider to build. */
export interface BackupProviderConfig {
  type: 'off' | 'r2';
  r2?: R2ProviderConfig;
}

export interface R2ProviderConfig {
  /** e.g. https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  /** Bucket name. */
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix for every uploaded object. Default 'trail-db/'. */
  prefix?: string;
}
