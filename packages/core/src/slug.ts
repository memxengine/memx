// Re-export the canonical implementation so existing
// `import { slugify } from '@trail/core'` imports keep working. The actual
// body lives in @trail/shared so the admin (browser bundle, no node:crypto)
// and CLI scripts can share it without pulling a server-side dep.
export { slugify, uniqueSlug } from '@trail/shared';
