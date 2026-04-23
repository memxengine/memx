# F80 — Federated Trail (`[[ext:…]]` Links)

> One trail instance can subscribe to another's public wiki. Cross-tenant citations via `[[ext:tenant/kb/page]]`. Link parser (F23) was designed for this from Phase 1.

## Problem

I dag er hver Trail isoleret — Sanne's wiki kan ikke linke til FysioDK's wiki, og omvendt. Men mange emner krydser organisationer: en zoneterapeut vil måske linke til en generisk anatomi-guide hosted af en anden Trail instans.

Federated Trail lader instanser "abonnere" på hinandens public wikis. Links resolveres på tværs af instanser via HTTP API.

## Solution

F23's `[[ext:tenant/kb/page]]` syntax resolveres til et HTTP call til den target instans's public read endpoint. Target instansen konfigurerer hvilke KBs der er public (F131). Source instansen cacher resolved content lokalt med TTL.

## Technical Design

### 1. Public Read Endpoint

```typescript
// apps/server/src/routes/public.ts

export const publicRoutes = new Hono();

publicRoutes.get('/public/:tenantSlug/:kbSlug/neurons/:neuronSlug', async (c) => {
  const tenantSlug = c.req.param('tenantSlug');
  const kbSlug = c.req.param('kbSlug');
  const neuronSlug = c.req.param('neuronSlug');

  // Find tenant + KB
  const tenant = await trail.db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).get();
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const kb = await trail.db
    .select()
    .from(knowledgeBases)
    .where(and(
      eq(knowledgeBases.tenantId, tenant.id),
      eq(knowledgeBases.slug, kbSlug),
      eq(knowledgeBases.publicVisibility, 'public'),
    ))
    .get();

  if (!kb) return c.json({ error: 'KB not found or not public' }, 404);

  // Find neuron
  const neuron = await trail.db
    .select()
    .from(documents)
    .where(and(
      eq(documents.knowledgeBaseId, kb.id),
      eq(documents.kind, 'wiki'),
      eq(documents.slug, neuronSlug),
    ))
    .get();

  if (!neuron) return c.json({ error: 'Neuron not found' }, 404);

  return c.json({
    id: neuron.id,
    title: neuron.title,
    content: neuron.content,
    slug: neuron.slug,
    updatedAt: neuron.updatedAt,
    tenantName: tenant.name,
    kbName: kb.name,
  });
});
```

### 2. Federated Link Resolver

```typescript
// packages/core/src/links/federated.ts

export interface FederatedNeuron {
  id: string;
  title: string;
  content: string;
  slug: string;
  updatedAt: string;
  tenantName: string;
  kbName: string;
  sourceUrl: string;
}

const cache = new Map<string, { data: FederatedNeuron; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function resolveFederatedLink(
  tenantSlug: string,
  kbSlug: string,
  neuronSlug: string,
  baseUrl: string,
): Promise<FederatedNeuron | null> {
  const cacheKey = `${tenantSlug}/${kbSlug}/${neuronSlug}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  try {
    const url = `${baseUrl}/public/${tenantSlug}/${kbSlug}/neurons/${neuronSlug}`;
    const res = await fetch(url);

    if (!res.ok) return null;

    const data = await res.json();
    const neuron: FederatedNeuron = {
      ...data,
      sourceUrl: url,
    };

    cache.set(cacheKey, { data: neuron, expires: Date.now() + CACHE_TTL });
    return neuron;
  } catch {
    return null;
  }
}
```

### 3. Integration with Link Resolver (F23)

```typescript
// packages/core/src/links/resolver.ts — extend for external links

if (link.type === 'external') {
  const [tenantSlug, kbSlug, ...pathParts] = link.pagePath.split('/');
  const neuronSlug = pathParts.join('/');

  // Resolve via federated API
  const baseUrl = process.env.TRAIL_FEDERATION_BASE_URL ?? 'https://app.trailmem.com';
  const neuron = await resolveFederatedLink(tenantSlug, kbSlug, neuronSlug, baseUrl);

  return {
    link,
    documentId: neuron?.id ?? null,
    documentTitle: neuron?.title ?? null,
    exists: !!neuron,
    url: neuron ? `/federated/${tenantSlug}/${kbSlug}/${neuronSlug}` : null,
  };
}
```

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/public.ts` — public read endpoint
- `packages/core/src/links/federated.ts` — federated link resolver with cache

### Files modified
- `apps/server/src/app.ts` — mount public routes (no auth)
- `packages/core/src/links/resolver.ts` — handle external link type
- `packages/db/src/schema.ts` — publicVisibility on knowledge_bases (F131)

### Downstream dependents for modified files

**`apps/server/src/app.ts`** — public routes are no-auth. Must be carefully scoped.

### Blast radius
- Public endpoint exposes wiki content — only KBs marked public are accessible
- Federation cache prevents excessive cross-instance calls
- Circular federation (A links to B links to A) handled by cache TTL

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Integration: Public endpoint returns neuron content for public KB
- [ ] Integration: Public endpoint returns 404 for private KB
- [ ] Integration: Federated link resolves to external neuron
- [ ] Integration: Cache prevents repeated external calls
- [ ] Security: Private KBs not accessible via public endpoint

## Implementation Steps

1. Create public read endpoint
2. Create federated link resolver with cache
3. Integrate with F23 link resolver
4. Add publicVisibility config to KB settings
5. Integration test: cross-instance link resolution
6. Security test: private KBs not exposed

## Dependencies

- F23 (Wiki-Link Parser) — `[[ext:...]]` syntax
- F131 (Public Visibility Column) — KB-level public flag

## Effort Estimate

**Small** — 1-2 days

- Day 1: Public endpoint + federated resolver
- Day 2: Integration + security testing
