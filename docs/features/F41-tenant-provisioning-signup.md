# F41 — Tenant Provisioning + Signup Flow

> Offentlig signup flow der opretter tenant + første bruger. Email verification, OAuth provider picker. Hooks til Stripe (F43) for plan selection.

## Problem

I dag oprettes tenants manuelt eller via første OAuth login (auto-create). Der er ingen offentlig signup-side hvor nye brugere kan registrere sig, vælge plan, og få deres egen Trail instans. For at Trail kan scale til SaaS (Phase 2), skal der være et selvbetjent signup flow.

## Solution

En signup flow i tre trin:
1. **Email + password** eller **OAuth picker** (Google/GitHub)
2. **Plan selection** (Hobby free / Pro $29 / Business $199) — hvis Stripe er konfigureret (F43), redirect til Stripe checkout
3. **Tenant creation** — auto-provision KB, set owner role, send welcome email

Flowet er en standalone side (`/signup`) der ikke kræver auth. Efter succes redirectes brugeren til admin dashboard med ny tenant.

## Technical Design

### 1. Signup Endpoint

```typescript
// apps/server/src/routes/signup.ts

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { tenants, users, knowledgeBases } from '@trail/db';

const signupSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).optional(),
  plan: z.enum(['hobby', 'pro', 'business']).default('hobby'),
  oauthProvider: z.enum(['google', 'github']).optional(),
});

export const signupRoutes = new Hono();

signupRoutes.post('/signup', zValidator('json', signupSchema), async (c) => {
  const { email, displayName, plan, oauthProvider } = c.req.valid('json');

  // Check if email already exists
  const existing = await trail.db.select().from(users).where(eq(users.email, email)).get();
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409);
  }

  // Create tenant
  const tenantId = crypto.randomUUID();
  const tenantSlug = generateSlug(displayName ?? email);

  await trail.db.insert(tenants).values({
    id: tenantId,
    slug: tenantSlug,
    name: displayName ?? email.split('@')[0],
    plan,
    createdAt: new Date().toISOString(),
  }).run();

  // Create user
  const userId = crypto.randomUUID();
  await trail.db.insert(users).values({
    id: userId,
    tenantId,
    email,
    displayName: displayName ?? null,
    role: 'owner',
    onboarded: false,
    createdAt: new Date().toISOString(),
  }).run();

  // Create default knowledge base
  const kbId = crypto.randomUUID();
  await trail.db.insert(knowledgeBases).values({
    id: kbId,
    tenantId,
    createdBy: userId,
    name: 'My Trail',
    slug: 'my-trail',
    language: 'en',
    lintPolicy: 'trusting',
    createdAt: new Date().toISOString(),
  }).run();

  // If Stripe is configured and plan is paid, redirect to checkout
  if (plan !== 'hobby' && process.env.STRIPE_SECRET_KEY) {
    const checkoutUrl = await createStripeCheckoutSession(userId, tenantId, plan);
    return c.json({ redirect: checkoutUrl, tenantId, userId });
  }

  // Create session and return
  const sessionId = crypto.randomUUID();
  await trail.db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }).run();

  setCookie(c, 'session', sessionId, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 30 * 24 * 60 * 60 });

  return c.json({ tenantId, userId, redirect: '/admin' });
});
```

### 2. Email Verification (Optional)

```typescript
// apps/server/src/routes/signup.ts — email verification flow

signupRoutes.post('/signup/verify', async (c) => {
  const { token } = await c.req.json();
  // Verify token, mark user as verified
  // ...
});
```

### 3. Signup Page (Admin App)

```typescript
// apps/admin/src/pages/signup.tsx

import { h } from 'preact';
import { useState } from 'preact/hooks';

export function SignupPage() {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [plan, setPlan] = useState('hobby');

  const handleSignup = async () => {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, plan }),
    });
    const data = await res.json();
    if (data.redirect) {
      window.location.href = data.redirect;
    }
  };

  return h('div', { class: 'signup-page' }, [
    h('h1', {}, 'Create your Trail'),
    step === 1 && h('div', { class: 'signup-step' }, [
      h('input', { type: 'email', value: email, onInput: (e) => setEmail(e.target.value), placeholder: 'Email' }),
      h('button', { onClick: () => setStep(2) }, 'Continue'),
      h('div', { class: 'oauth-buttons' }, [
        h('button', { class: 'oauth-google' }, 'Sign up with Google'),
        h('button', { class: 'oauth-github' }, 'Sign up with GitHub'),
      ]),
    ]),
    step === 2 && h('div', { class: 'signup-step' }, [
      h('h2', {}, 'Choose your plan'),
      h('div', { class: 'plan-cards' }, [
        h('div', { class: `plan-card ${plan === 'hobby' ? 'selected' : ''}`, onClick: () => setPlan('hobby') }, [
          h('h3', {}, 'Hobby'),
          h('p', {}, 'Free'),
          h('ul', {}, [h('li', {}, '1 KB'), h('li', {}, '100 sources'), h('li', {}, '1k queries/mo')]),
        ]),
        h('div', { class: `plan-card ${plan === 'pro' ? 'selected' : ''}`, onClick: () => setPlan('pro') }, [
          h('h3', {}, 'Pro'),
          h('p', {}, '$29/mo'),
          h('ul', {}, [h('li', {}, '5 KBs'), h('li', {}, '2k sources'), h('li', {}, '50k queries/mo')]),
        ]),
        h('div', { class: `plan-card ${plan === 'business' ? 'selected' : ''}`, onClick: () => setPlan('business') }, [
          h('h3', {}, 'Business'),
          h('p', {}, '$199/mo'),
          h('ul', {}, [h('li', {}, 'Unlimited'), h('li', {}, 'SSO'), h('li', {}, 'Priority support')]),
        ]),
      ]),
      h('button', { class: 'btn-primary', onClick: handleSignup }, plan === 'hobby' ? 'Start free' : 'Subscribe'),
    ]),
  ]);
}
```

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/signup.ts` — signup endpoint
- `apps/admin/src/pages/signup.tsx` — signup page UI
- `apps/admin/src/styles/signup.css` — signup page styling

### Files modified
- `apps/server/src/app.ts` — mount signup routes (no auth required)
- `apps/server/src/middleware/auth.ts` — skip auth for `/api/signup`
- `packages/db/src/schema.ts` — ensure tenants/users tables support signup flow

### Downstream dependents for modified files

**`apps/server/src/app.ts`** — no downstream dependents.

**`apps/server/src/middleware/auth.ts`** — adding signup to public paths is additive. Existing auth flow unchanged.

### Blast radius
- Signup is public — rate limiting needed to prevent abuse
- Tenant slugs must be unique — collision handling required
- Default KB creation is part of signup — if it fails, tenant/user should be rolled back
- Stripe integration is optional — signup works without it (hobby plan)

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Signup creates tenant + user + default KB
- [ ] Unit: Duplicate email returns 409
- [ ] Unit: Tenant slug is unique (collision handling)
- [ ] Integration: POST /signup → returns session cookie + redirect
- [ ] Integration: Signup page renders plan cards
- [ ] Integration: Hobby plan signup skips Stripe
- [ ] Integration: Pro/Business plan signup redirects to Stripe (if configured)
- [ ] Regression: Existing OAuth login flow unchanged
- [ ] Regression: Auth middleware still protects `/api/v1/*` routes

## Implementation Steps

1. Create `apps/server/src/routes/signup.ts` with POST endpoint
2. Add signup to public paths in auth middleware
3. Create signup page in admin app
4. Add plan selection UI with Stripe redirect logic
5. Add rate limiting for signup endpoint
6. Integration test: full signup flow → tenant created → user logged in
7. Test collision handling for tenant slugs
8. Test Stripe redirect (mock checkout session)

## Dependencies

- F03 (Google OAuth) — OAuth provider option in signup
- F43 (Stripe Billing) — optional checkout redirect for paid plans

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Signup endpoint + tenant/user/KB creation + unit tests
- Day 2: Signup page UI + plan selection + Stripe integration
- Day 3: Rate limiting + collision handling + integration testing
