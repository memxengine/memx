/**
 * Storage abstraction — Phase 1 uses local filesystem.
 * Phase 2 will add Cloudflare R2 / S3 implementations behind the same interface.
 */

export interface Storage {
  /** Upload raw bytes at a given path. */
  put(path: string, data: Uint8Array | Buffer, contentType?: string): Promise<void>;

  /** Fetch raw bytes at a given path, or null if missing. */
  get(path: string): Promise<Uint8Array | null>;

  /** Delete a file. No-op if missing. */
  delete(path: string): Promise<void>;

  /** Check existence. */
  exists(path: string): Promise<boolean>;

  /** Generate a short-lived URL (for direct browser access in Phase 2+). */
  signedUrl(path: string, expiresSec?: number): Promise<string>;

  /** List all paths under a prefix. */
  list(prefix: string): Promise<string[]>;
}

export { LocalStorage } from './local.js';
