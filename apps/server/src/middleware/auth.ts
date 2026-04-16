import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { sessions, users, tenants, type TrailDatabase } from '@trail/db';
import { and, eq, gt } from 'drizzle-orm';

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

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const trail = c.get('trail') as TrailDatabase;
  const now = new Date().toISOString();
  const result = await trail.db
    .select({
      user: {
        id: users.id,
        tenantId: users.tenantId,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        onboarded: users.onboarded,
      },
      tenant: {
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        plan: tenants.plan,
      },
    })
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
