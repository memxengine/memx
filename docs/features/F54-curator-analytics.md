# F54 — Analytics Dashboard for Curators

> Dashboard for curators: queue depth over time, approval rate, auto-approval rate, gap queries, reader feedback trends. Drives what to ingest next.

## Problem

Curatorer har ingen oversigt over hvordan deres Trail performer over tid. De ved ikke om queue'en vokser eller krymper, om auto-approval fungerer, eller hvilke emner der har flest gaps. Uden analytics er curation reaktiv i stedet for proaktiv.

## Solution

Et analytics dashboard i admin der viser:
1. **Queue metrics**: pending/approved/rejected over tid (7/30/90 dage)
2. **Approval rate**: % auto-approved vs manual, per connector
3. **Gap analysis**: mest forespurgte emner uden gode svar (fra F57)
4. **Reader feedback**: feedback trends per kategori
5. **Ingest volume**: sources uploaded per dag/uge

Data aggregeres fra `queue_candidates`, `activity_log`, og `usage_events` tabellerne.

## Technical Design

### 1. Analytics Endpoint

```typescript
// apps/server/src/routes/analytics.ts

export const analyticsRoutes = new Hono();

analyticsRoutes.get('/analytics/queue', async (c) => {
  const tenant = getTenant(c);
  const kbId = c.req.query('kbId');
  const days = parseInt(c.req.query('days') ?? '30');

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Daily queue stats
  const dailyStats = await trail.db
    .select({
      date: sql<string>`date(${queueCandidates.createdAt})`,
      status: queueCandidates.status,
      count: sql<number>`count(*)`,
    })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.tenantId, tenant.id),
      kbId ? eq(queueCandidates.knowledgeBaseId, kbId) : undefined,
      gt(queueCandidates.createdAt, cutoff),
    ))
    .groupBy(sql`date(${queueCandidates.createdAt})`, queueCandidates.status)
    .all();

  // Approval rate
  const totalResolved = await trail.db
    .select({ count: sql<number>`count(*)` })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.tenantId, tenant.id),
      inArray(queueCandidates.status, ['approved', 'rejected', 'dismissed']),
      gt(queueCandidates.createdAt, cutoff),
    ))
    .get();

  const autoApproved = await trail.db
    .select({ count: sql<number>`count(*)` })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.tenantId, tenant.id),
      eq(queueCandidates.autoApproved, true),
      gt(queueCandidates.createdAt, cutoff),
    ))
    .get();

  // Per-connector breakdown
  const connectorStats = await trail.db
    .select({
      connector: sql<string>`json_extract(${queueCandidates.metadata}, '$.connector')`,
      count: sql<number>`count(*)`,
    })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.tenantId, tenant.id),
      gt(queueCandidates.createdAt, cutoff),
    ))
    .groupBy(sql`json_extract(${queueCandidates.metadata}, '$.connector')`)
    .all();

  return c.json({
    dailyStats,
    approvalRate: totalResolved?.count ? (autoApproved?.count ?? 0) / totalResolved.count : 0,
    connectorStats,
    period: { days, from: cutoff, to: new Date().toISOString() },
  });
});

analyticsRoutes.get('/analytics/gaps', async (c) => {
  // Top gap queries (from F57 gap suggestions)
  const gaps = await trail.db
    .select({
      topic: sql<string>`json_extract(${queueCandidates.metadata}, '$.topic')`,
      count: sql<number>`count(*)`,
    })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.tenantId, getTenant(c).id),
      eq(queueCandidates.kind, 'gap_suggestion'),
    ))
    .groupBy(sql`json_extract(${queueCandidates.metadata}, '$.topic')`)
    .orderBy(sql`count(*) desc`)
    .limit(20)
    .all();

  return c.json({ gaps });
});

analyticsRoutes.get('/analytics/feedback', async (c) => {
  const feedback = await trail.db
    .select({
      category: sql<string>`json_extract(${queueCandidates.metadata}, '$.category')`,
      count: sql<number>`count(*)`,
    })
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.tenantId, getTenant(c).id),
      eq(queueCandidates.kind, 'reader_feedback'),
    ))
    .groupBy(sql`json_extract(${queueCandidates.metadata}, '$.category')`)
    .all();

  return c.json({ feedback });
});
```

### 2. Dashboard UI

```typescript
// apps/admin/src/pages/analytics-dashboard.tsx

import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export function AnalyticsDashboard() {
  const [queueData, setQueueData] = useState(null);
  const [gapData, setGapData] = useState(null);
  const [feedbackData, setFeedbackData] = useState(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    fetch(`/api/v1/analytics/queue?days=${days}`)
      .then(r => r.json())
      .then(setQueueData);
    fetch('/api/v1/analytics/gaps')
      .then(r => r.json())
      .then(setGapData);
    fetch('/api/v1/analytics/feedback')
      .then(r => r.json())
      .then(setFeedbackData);
  }, [days]);

  return h('div', { class: 'analytics-page' }, [
    h('h1', {}, 'Analytics'),
    h('div', { class: 'analytics-controls' }, [
      h('button', { class: days === 7 ? 'active' : '', onClick: () => setDays(7) }, '7 days'),
      h('button', { class: days === 30 ? 'active' : '', onClick: () => setDays(30) }, '30 days'),
      h('button', { class: days === 90 ? 'active' : '', onClick: () => setDays(90) }, '90 days'),
    ]),
    h('div', { class: 'analytics-grid' }, [
      h('div', { class: 'analytics-card' }, [
        h('h2', {}, 'Queue Depth'),
        // Simple bar chart of daily pending counts
        queueData?.dailyStats?.map((day) =>
          h('div', { class: 'bar-chart-row' }, [
            h('span', { class: 'bar-label' }, day.date),
            h('div', { class: 'bar', style: { width: `${(day.count / maxCount) * 100}%` } }),
            h('span', { class: 'bar-value' }, day.count),
          ])
        ),
      ]),
      h('div', { class: 'analytics-card' }, [
        h('h2', {}, 'Approval Rate'),
        h('div', { class: 'approval-rate' }, [
          h('span', { class: 'rate-number' }, `${((queueData?.approvalRate ?? 0) * 100).toFixed(1)}%`),
          h('span', { class: 'rate-label' }, 'auto-approved'),
        ]),
      ]),
      h('div', { class: 'analytics-card' }, [
        h('h2', {}, 'Top Gaps'),
        gapData?.gaps?.map((gap) =>
          h('div', { class: 'gap-item' }, [
            h('span', { class: 'gap-topic' }, gap.topic),
            h('span', { class: 'gap-count' }, `${gap.count} queries`),
          ])
        ),
      ]),
      h('div', { class: 'analytics-card' }, [
        h('h2', {}, 'Reader Feedback'),
        feedbackData?.feedback?.map((fb) =>
          h('div', { class: 'feedback-item' }, [
            h('span', { class: 'feedback-category' }, fb.category),
            h('span', { class: 'feedback-count' }, fb.count),
          ])
        ),
      ]),
    ]),
  ]);
}
```

## Impact Analysis

### Files created (new)
- `apps/server/src/routes/analytics.ts` — analytics endpoints
- `apps/admin/src/pages/analytics-dashboard.tsx` — dashboard UI
- `apps/admin/src/styles/analytics.css` — dashboard styling

### Files modified
- `apps/server/src/app.ts` — mount analytics routes
- `apps/admin/src/router.ts` — add /analytics route

### Downstream dependents for modified files

**`apps/server/src/app.ts`** — no downstream dependents.

**`apps/admin/src/router.ts`** — adding route is additive.

### Blast radius
- Analytics queries aggregate over large tables — may need indexes on `createdAt`, `tenantId`, `status`
- Dashboard is read-only — no write impact
- Data is tenant-scoped — no cross-tenant leakage

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Integration: GET /analytics/queue returns daily stats
- [ ] Integration: GET /analytics/gaps returns top gap topics
- [ ] Integration: GET /analytics/feedback returns feedback by category
- [ ] Integration: Analytics dashboard renders with data
- [ ] Integration: Time range selector (7/30/90 days) updates data
- [ ] Regression: Existing admin pages unaffected

## Implementation Steps

1. Create analytics endpoints for queue, gaps, feedback
2. Add database indexes for analytics queries
3. Create analytics dashboard UI
4. Add time range selector
5. Integration test: dashboard loads with real data
6. Test with large datasets (10k+ queue candidates)

## Dependencies

- F57 (Gap Suggestions) — gap data source
- F31 (Reader Feedback) — feedback data source
- F97 (Activity Log) — optional data source for additional metrics

## Effort Estimate

**Medium** — 2-3 days

- Day 1: Analytics endpoints + database indexes
- Day 2: Dashboard UI with charts
- Day 3: Polish + performance testing with large datasets
