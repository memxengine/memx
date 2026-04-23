# F84 — Dedicated PostgreSQL Option

> Enterprise option for customers with strict data-residency or existing Postgres. Same Drizzle schema, different storage adapter.

## Problem

Nogle enterprise kunder kan ikke bruge SQLite/libSQL af compliance-grunde: de kræver PostgreSQL med row-level security, audit logging, og existing infrastructure. Trail's schema er allerede tenant-aware — det skal bare køre på Postgres i stedet for SQLite.

## Solution

`@trail/db` adapter pattern (F42) udvides med en PostgreSQL adapter. Samme Drizzle schema, samme queries — kun connection string og driver ændres. Drizzle understøtter både SQLite og Postgres med samme schema definition.

## Technical Design

### 1. Postgres Adapter

```typescript
// packages/db/src/adapters/postgres.ts

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../schema.js';

export function createPostgresAdapter(connectionString: string): TrailDatabase {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  return {
    db,
    dialect: 'postgres',
    async migrate() {
      // Run Drizzle migrations
      await migrate(db, { migrationsFolder: './drizzle' });
    },
    async close() {
      await pool.end();
    },
  };
}
```

### 2. Database Factory

```typescript
// packages/db/src/factory.ts

export type DatabaseDialect = 'libsql' | 'postgres';

export interface DatabaseConfig {
  dialect: DatabaseDialect;
  /** For libsql: path to .db file */
  url?: string;
  /** For postgres: connection string */
  connectionString?: string;
}

export function createDatabase(config: DatabaseConfig): TrailDatabase {
  switch (config.dialect) {
    case 'libsql':
      return createLibSQLAdapter(config.url!);
    case 'postgres':
      return createPostgresAdapter(config.connectionString!);
    default:
      throw new Error(`Unknown dialect: ${config.dialect}`);
  }
}
```

### 3. Schema Compatibility

```typescript
// packages/db/src/schema.ts — ensure Postgres compatibility

// Most Drizzle types work on both SQLite and Postgres.
// Exceptions:
// - FTS5: Postgres uses pg_trgm or tsvector instead
// - JSON: Postgres uses jsonb, SQLite uses text
// - Auto-increment: Postgres uses SERIAL, SQLite uses AUTOINCREMENT

// FTS5 alternative for Postgres:
export const documentsSearch = pgTable('documents_search', {
  documentId: text('document_id').primaryKey(),
  content: text('content').notNull(),
  // pg_trgm index for full-text search
});
```

### 4. Migration Strategy

```typescript
// packages/db/src/migrate.ts

export async function migrate(db: TrailDatabase): Promise<void> {
  if (db.dialect === 'postgres') {
    // Run Postgres-specific migrations
    await migratePostgres(db);
  } else {
    // Run libSQL migrations (existing)
    await migrateLibSQL(db);
  }
}
```

## Impact Analysis

### Files created (new)
- `packages/db/src/adapters/postgres.ts` — Postgres adapter
- `packages/db/src/factory.ts` — database factory
- `packages/db/src/migrate.ts` — dialect-aware migration

### Files modified
- `packages/db/package.json` — add `pg`, `drizzle-orm/node-postgres`
- `apps/server/src/bootstrap/database.ts` — use factory instead of direct libSQL

### Downstream dependents for modified files

**`apps/server/src/bootstrap/database.ts`** — changing to factory pattern is internal. All consumers use `c.get('trail')` unchanged.

### Blast radius
- Postgres adapter is opt-in via env var — existing libSQL unchanged
- FTS5 needs Postgres alternative (pg_trgm) — search behavior may differ slightly
- Connection pooling for Postgres — different from libSQL's file-based approach

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Postgres adapter creates correct connection
- [ ] Unit: Factory returns correct adapter based on config
- [ ] Integration: Postgres migration creates all tables
- [ ] Integration: CRUD operations work on Postgres
- [ ] Integration: Search works with pg_trgm
- [ ] Regression: libSQL adapter unchanged

## Implementation Steps

1. Create Postgres adapter with Drizzle
2. Create database factory
3. Add FTS5 alternative for Postgres (pg_trgm)
4. Update bootstrap to use factory
5. Integration test: full Trail on Postgres
6. Test migration from libSQL to Postgres (data export/import)

## Dependencies

- F42 (Pluggable Storage) — same adapter pattern
- F02 (Tenant-Aware Schema) — schema already multi-tenant

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Postgres adapter + factory + migrations
- Day 2: FTS5 alternative + integration testing
- Day 3: Data migration tools + documentation
