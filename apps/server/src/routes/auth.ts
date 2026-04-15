import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, users, sessions, tenants } from '@trail/db';
import { and, eq, gt } from 'drizzle-orm';
import { slugify } from '../lib/slug.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3030';
const API_URL = process.env.API_URL ?? 'http://localhost:3031';

export const authRoutes = new Hono();

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

  const existingUser = db.select().from(users).where(eq(users.email, googleUser.email)).get();

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
    db.update(users)
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
    const tenantSlug = await nextAvailableSlug(baseSlug);

    db.insert(tenants)
      .values({
        id: tenantId,
        slug: tenantSlug,
        name: googleUser.name || googleUser.email,
        plan: 'hobby',
      })
      .run();

    userId = crypto.randomUUID();
    db.insert(users)
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
  db.insert(sessions).values({ id: sessionId, userId, expiresAt }).run();

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

authRoutes.get('/me', (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ user: null });
  }

  const now = new Date().toISOString();
  const result = db
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

async function nextAvailableSlug(base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  while (db.select().from(tenants).where(eq(tenants.slug, candidate)).get()) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
