import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sessions, users, tenants, apiKeys, type TrailDatabase } from '@trail/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { INGEST_USER_ID } from '../bootstrap/ingest-user.js';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: 'owner' | 'curator' | 'reader';
  onboarded: boolean;
}

export interface AuthTenant {
  id: string;
  slug: string;
  name: string;
  plan: 'hobby' | 'pro' | 'business' | 'enterprise';
}

const USER_COLUMNS = {
  id: users.id,
  tenantId: users.tenantId,
  email: users.email,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  role: users.role,
  onboarded: users.onboarded,
} as const;

const TENANT_COLUMNS = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  plan: tenants.plan,
} as const;

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const trail = c.get('trail') as TrailDatabase;

  // Bearer token path — two sub-variants:
  //   (a) trail_<64hex>  → DB-backed API key (F111, per-user, revocable)
  //   (b) anything else  → legacy TRAIL_INGEST_TOKEN env-var comparison
  const authHeader = c.req.header('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const presented = authHeader.slice(7).trim();

    // (a) DB-backed API key
    if (presented.startsWith('trail_')) {
      const hash = createHash('sha256').update(presented).digest('hex');
      const row = await trail.db
        .select({ user: USER_COLUMNS, tenant: TENANT_COLUMNS, keyId: apiKeys.id })
        .from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.userId))
        .innerJoin(tenants, eq(tenants.id, users.tenantId))
        .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
        .get();
      if (!row) {
        return c.json({ error: 'Invalid or revoked API key' }, 401);
      }
      c.set('user', row.user);
      c.set('tenant', row.tenant);
      c.set('authType', 'bearer');
      // last_used_at is best-effort — don't block the request on it
      trail.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiKeys.id, row.keyId))
        .run()
        .catch(() => {});
      return next();
    }

    // (b) Legacy service-to-service env-var token
    const expected = process.env.TRAIL_INGEST_TOKEN;
    if (!expected) {
      return c.json({ error: 'Bearer auth not configured on this engine' }, 401);
    }
    // Constant-time compare — plain `!==` leaks per-byte timing that a
    // patient attacker could aggregate across many requests to recover
    // the token. Length check first: timingSafeEqual throws on mismatched
    // lengths, and that throw itself is a (tiny) timing side channel, so
    // we gate with a plain length check and only compare equal-length
    // buffers. Presenting a wrong-length token lands in the same 403
    // bucket as a wrong-byte token.
    const presentedBuf = Buffer.from(presented);
    const expectedBuf = Buffer.from(expected);
    const ok =
      presentedBuf.length === expectedBuf.length &&
      timingSafeEqual(presentedBuf, expectedBuf);
    if (!ok) {
      return c.json({ error: 'Invalid ingest token' }, 403);
    }
    const service = await trail.db
      .select({ user: USER_COLUMNS, tenant: TENANT_COLUMNS })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(eq(users.id, INGEST_USER_ID))
      .get();
    if (!service) {
      return c.json({ error: 'Ingest user not provisioned' }, 503);
    }
    c.set('user', service.user);
    c.set('tenant', service.tenant);
    c.set('authType', 'bearer');
    return next();
  }

  // Session-cookie path — how the admin UI and cc/MCP sessions auth.
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date().toISOString();
  const result = await trail.db
    .select({ user: USER_COLUMNS, tenant: TENANT_COLUMNS })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .get();

  if (!result) {
    return c.json({ error: 'Session expired' }, 401);
  }

  c.set('user', result.user);
  c.set('tenant', result.tenant);
  c.set('authType', 'session');
  return next();
}

export function getUser(c: Context): AuthUser {
  return c.get('user') as AuthUser;
}

export function getTenant(c: Context): AuthTenant {
  return c.get('tenant') as AuthTenant;
}

/** Resolve the per-request TrailDatabase. Always set by createApp. */
export function getTrail(c: Context): TrailDatabase {
  return c.get('trail') as TrailDatabase;
}
