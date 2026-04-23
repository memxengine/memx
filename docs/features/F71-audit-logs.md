# F71 — Audit Logs + Retention

> Central append-only `audit_log` table capturing every meaningful action on a trail server — auth, uploads, ingests, candidate lifecycle, Neuron edits. Configurable retention policy. Required for SOC 2 (F73) og enterprise compliance.

## Problem

Trail har `activity_log` (F97) som tracker events, men det er ikke en fuld audit trail. En audit log skal være:
- **Immutable** — ingen kan slette eller ændre entries
- **Comprehensive** — dækker alle security-relevante handlinger
- **Retainable** — konfigurerbar retention (90 dage, 1 år, 7 år)
- **Exportable** — CSV/JSON export til compliance reviews

Uden audit log kan Trail ikke opfylde SOC 2 krav eller enterprise kunders compliance-behov.

## Solution

En ny `audit_log` tabel der er strengt append-only (ingen UPDATE/DELETE). Hver entry har: actor, action, target, metadata, timestamp. En retention policy job kører dagligt og arkiverer gamle entries til cold storage.

## Technical Design

### 1. Audit Log Schema

```typescript
// packages/db/src/schema.ts

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  /** Who performed the action */
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email'),
  /** Action type */
  action: text('action').notNull(),
  /** Target resource type and ID */
  targetType: text('target_type'), // 'document' | 'kb' | 'user' | 'tenant' | 'candidate'
  targetId: text('target_id'),
  /** Full event payload for audit trail */
  metadata: text('metadata'),
  /** IP address (if available) */
  ipAddress: text('ip_address'),
  /** User agent */
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
});

// No UPDATE or DELETE triggers — strictly append-only
```

### 2. Audit Logger

```typescript
// packages/core/src/audit/logger.ts

export type AuditAction =
  | 'auth.login' | 'auth.logout' | 'auth.failed'
  | 'document.upload' | 'document.delete' | 'document.edit'
  | 'candidate.approve' | 'candidate.reject' | 'candidate.create'
  | 'kb.create' | 'kb.delete' | 'kb.update'
  | 'user.create' | 'user.delete' | 'user.role_change'
  | 'tenant.create' | 'tenant.plan_change';

export interface AuditEntry {
  tenantId: string;
  actorId: string;
  actorEmail?: string;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAudit(
  trail: TrailDatabase,
  entry: AuditEntry,
): Promise<void> {
  await trail.db.insert(auditLog).values({
    id: crypto.randomUUID(),
    ...entry,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    createdAt: new Date().toISOString(),
  }).run();
}
```

### 3. Retention Policy

```typescript
// packages/core/src/audit/retention.ts

export interface RetentionConfig {
  /** Days to keep audit logs (default: 365) */
  retentionDays: number;
  /** Archive to cold storage before deleting (default: true) */
  archiveBeforeDelete: boolean;
}

export async function enforceRetention(
  trail: TrailDatabase,
  config: RetentionConfig = { retentionDays: 365, archiveBeforeDelete: true },
): Promise<{ archived: number; deleted: number }> {
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  if (config.archiveBeforeDelete) {
    // Export to cold storage before deleting
    const oldEntries = await trail.db
      .select()
      .from(auditLog)
      .where(lt(auditLog.createdAt, cutoff))
      .all();

    if (oldEntries.length > 0) {
      await archiveToStorage(oldEntries); // S3/R2/Tigris
    }
  }

  const result = await trail.db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, cutoff))
    .run();

  return { archived: 0, deleted: result.changes };
}
```

### 4. Integration Points

```typescript
// apps/server/src/middleware/auth.ts — log auth events
await logAudit(trail, {
  tenantId: tenant.id,
  actorId: user.id,
  actorEmail: user.email,
  action: 'auth.login',
  ipAddress: c.req.header('x-forwarded-for'),
  userAgent: c.req.header('user-agent'),
});

// apps/server/src/routes/uploads.ts — log uploads
await logAudit(trail, {
  tenantId: tenant.id,
  actorId: user.id,
  action: 'document.upload',
  targetType: 'document',
  targetId: docId,
  metadata: { filename, fileSize },
});
```

## Impact Analysis

### Files created (new)
- `packages/db/src/schema.ts` — audit_log table
- `packages/core/src/audit/logger.ts` — audit logging
- `packages/core/src/audit/retention.ts` — retention policy
- `apps/server/src/services/audit-scheduler.ts` — daily retention job

### Files modified
- `apps/server/src/middleware/auth.ts` — log auth events
- `apps/server/src/routes/uploads.ts` — log upload events
- `apps/server/src/routes/queue.ts` — log candidate lifecycle events
- `apps/server/src/app.ts` — start retention scheduler

### Downstream dependents for modified files

All modifications are additive — existing flows unchanged.

### Blast radius
- Audit log grows continuously — needs retention policy to prevent unbounded growth
- Every authenticated action generates an audit entry — high-volume endpoints may need batching
- IP address logging may have GDPR implications — make configurable

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `logAudit` inserts entry with correct fields
- [ ] Unit: `enforceRetention` deletes entries older than threshold
- [ ] Integration: Login → audit entry created
- [ ] Integration: Upload → audit entry created
- [ ] Integration: Retention job runs daily and archives old entries
- [ ] Regression: Existing auth/upload/queue flows unchanged

## Implementation Steps

1. Create audit_log table + migration
2. Create audit logger + unit tests
3. Create retention policy + scheduler
4. Integrate audit logging into auth, upload, queue routes
5. Daily retention job
6. Integration test: full audit trail for user actions

## Dependencies

- F97 (Activity Log) — audit log complements activity log
- F73 (SOC 2) — audit log is required for SOC 2 compliance

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Schema + logger + retention logic
- Day 2: Integration into routes + scheduler
- Day 3: Testing + GDPR considerations
