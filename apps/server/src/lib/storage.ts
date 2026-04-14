import { join } from 'node:path';
import { DATA_DIR } from '@memx/db';
import { LocalStorage } from '@memx/storage';

// Phase 1: local filesystem under the same DATA_DIR as the SQLite DB.
// The uploads subdir mirrors the future R2 layout ({tenantId}/{kbId}/{docId}/...)
// so migrating to R2 in Phase 2 is a prefix swap.
const UPLOADS_ROOT = process.env.MEMX_UPLOADS_DIR ?? join(DATA_DIR, 'uploads');

export const storage = new LocalStorage(UPLOADS_ROOT);

export function sourcePath(tenantId: string, kbId: string, docId: string, ext: string): string {
  return `${tenantId}/${kbId}/${docId}/source.${ext}`;
}

export function imagePath(tenantId: string, kbId: string, docId: string, filename: string): string {
  return `${tenantId}/${kbId}/${docId}/images/${filename}`;
}
