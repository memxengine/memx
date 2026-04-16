import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { users, sessions, tenants, type TrailDatabase } from '@trail/db';
import { and, eq, gt } from 'drizzle-orm';
import { slugify } from '@trail/core';
import type { AppBindings } from '../app.js';
import { getTrail } from '../middleware/auth.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3030';
const API_URL = process.env.API_URL ?? 'http://localhost:3031';

export const authRoutes = new Hono<AppBindings>();

authRoutes.get('/google', (c) => {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${API_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRoutes.get('/google/callback', async (c) => {
  const trail = getTrail(c);
  const code = c.req.query('code');
  if (!code) {
    return c.redirect(`${APP_URL}/login?error=no_code`);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${API_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    return c.redirect(`${APP_URL}/login?error=token_exchange`);
  }

  const tokens = (await tokenRes.json()) as { access_token: string };

  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoRes.ok) {
    return c.redirect(`${APP_URL}/login?error=userinfo`);
  }

  const googleUser = (await userInfoRes.json()) as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  const existingUser = await trail.db
    .select()
    .from(users)
    .where(eq(users.email, googleUser.email))
    .get();

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
    await trail.db
      .update(users)
      .set({
        displayName: googleUser.name,
        avatarUrl: googleUser.picture,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, userId))
      .run();
  } else {
    // First signup for this email → auto-create tenant + owner user.
    // Phase 1 is single-tenant; this keeps the schema honest without needing invites yet.
    const tenantId = crypto.randomUUID();
    const baseSlug = slugify(googleUser.name || googleUser.email.split('@')[0] || 'tenant') || 'tenant';
    const tenantSlug = await nextAvailableSlug(trail, baseSlug);

    await trail.db
      .insert(tenants)
      .values({
        id: tenantId,
        slug: tenantSlug,
        name: googleUser.name || googleUser.email,
        plan: 'hobby',
      })
      .run();

    userId = crypto.randomUUID();
    await trail.db
      .insert(users)
      .values({
        id: userId,
        tenantId,
        email: googleUser.email,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture,
        role: 'owner',
      })
      .run();
  }

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await trail.db.insert(sessions).values({ id: sessionId, userId, expiresAt }).run();

  setCookie(c, 'session', sessionId, {
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });

  deleteCookie(c, 'oauth_state');

  return c.redirect(`${APP_URL}/wikis`);
});

authRoutes.post('/logout', (c) => {
  deleteCookie(c, 'session');
  return c.json({ ok: true });
});

/**
 * Dev-only shortcut: sets the session cookie to a pre-seeded value and
 * redirects to the admin. Lets us skip Google OAuth while running against
 * a scratch tenant. Enabled only when `TRAIL_DEV_AUTH=1`.
 *
 * Usage: open `${API_URL}/api/auth/dev-login?session=dev` in a browser.
 *        The engine sets `session=<value>`, redirects to `${APP_URL}`,
 *        and requireAuth then resolves the session from the seeded row.
 *
 * Removed before Fly deploy (F33) — or gated so it never ships to prod.
 */
authRoutes.get('/dev-login', (c) => {
  if (process.env.TRAIL_DEV_AUTH !== '1') {
    return c.json({ error: 'dev-login disabled (set TRAIL_DEV_AUTH=1 in the engine env)' }, 403);
  }
  const sessionId = c.req.query('session') ?? 'dev';
  setCookie(c, 'session', sessionId, {
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return c.redirect(APP_URL);
});

authRoutes.get('/me', async (c) => {
  const trail = getTrail(c);
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ user: null });
  }

  const now = new Date().toISOString();
  const result = await trail.db
    .select({
      id: users.id,
      tenantId: users.tenantId,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      onboarded: users.onboarded,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .get();

  return c.json({ user: result ?? null });
});

async function nextAvailableSlug(trail: TrailDatabase, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  while (await trail.db.select().from(tenants).where(eq(tenants.slug, candidate)).get()) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
