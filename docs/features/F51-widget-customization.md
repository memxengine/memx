# F51 — Widget Customization (CSS Variables + Branding)

> CSS variable set på `<trail-chat>` for colors, fonts, border radius. Per-tenant brand defaults served from widget's `GET /config` endpoint.

## Problem

Når Trail widgetten embeddes på eksterne sites, ser den ud som Trail — ikke som den site den er embeddet på. En fysioterapi-klinik vil have widgetten i deres brand-farver, ikke Trails amber/charcoal. Uden customization er widgetten et fremmedelement der bryder med site-designet.

## Solution

Widgetten eksponerer CSS custom properties (variables) der kan overrides via attributter eller inline styles. Per-tenant config endpoint serverer brand defaults (primary color, font, border radius) som injecteres som CSS variables på widget shadow root.

## Technical Design

### 1. CSS Variables

```css
/* apps/widget/src/styles/variables.css */

:host {
  --trail-primary: #1a1715;
  --trail-primary-hover: #2d2825;
  --trail-accent: #e8a87c;
  --trail-bg: #faf9f5;
  --trail-bg-secondary: #f0ede8;
  --trail-text: #1a1715;
  --trail-text-muted: #6b6560;
  --trail-border: #e5e2dc;
  --trail-border-radius: 8px;
  --trail-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --trail-font-size: 14px;
  --trail-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
```

### 2. Widget Config Attribute

```typescript
// apps/widget/src/trail-chat.ts

class TrailChat extends LitElement {
  @property() tenant: string = '';
  @property() kb: string = '';
  @property() theme: 'light' | 'dark' | 'auto' = 'auto';
  @property() primaryColor: string = '';
  @property() accentColor: string = '';
  @property() borderRadius: string = '';
  @property() fontFamily: string = '';

  connectedCallback() {
    super.connectedCallback();
    this.applyCustomStyles();
    this.loadTenantConfig();
  }

  private applyCustomStyles() {
    const style = document.createElement('style');
    const vars: string[] = [];
    if (this.primaryColor) vars.push(`--trail-primary: ${this.primaryColor}`);
    if (this.accentColor) vars.push(`--trail-accent: ${this.accentColor}`);
    if (this.borderRadius) vars.push(`--trail-border-radius: ${this.borderRadius}`);
    if (this.fontFamily) vars.push(`--trail-font-family: ${this.fontFamily}`);

    if (vars.length > 0) {
      style.textContent = `:host { ${vars.join('; ')}; }`;
      this.shadowRoot!.appendChild(style);
    }
  }

  private async loadTenantConfig() {
    if (!this.tenant) return;
    const res = await fetch(`/api/v1/config?tenant=${this.tenant}`);
    if (res.ok) {
      const config = await res.json();
      // Apply tenant brand defaults
      if (config.brand?.primaryColor) this.primaryColor = config.brand.primaryColor;
      if (config.brand?.accentColor) this.accentColor = config.brand.accentColor;
      if (config.brand?.borderRadius) this.borderRadius = config.brand.borderRadius;
      this.applyCustomStyles();
    }
  }
}
```

### 3. Config Endpoint

```typescript
// apps/server/src/routes/config.ts

export const configRoutes = new Hono();

configRoutes.get('/config', async (c) => {
  const tenantSlug = c.req.query('tenant');
  if (!tenantSlug) return c.json({ error: 'tenant required' }, 400);

  const tenant = await trail.db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).get();
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

  const brand = (tenant.brandConfig as any) ?? {};

  return c.json({
    tenant: tenant.name,
    brand: {
      primaryColor: brand.primaryColor ?? null,
      accentColor: brand.accentColor ?? null,
      borderRadius: brand.borderRadius ?? null,
      fontFamily: brand.fontFamily ?? null,
    },
    features: {
      feedback: tenant.plan !== 'hobby',
      citations: true,
    },
  });
});
```

### 4. Brand Config Schema

```typescript
// packages/db/src/schema.ts

// Extend tenants table:
brandConfig: text('brand_config'), // JSON: { primaryColor, accentColor, borderRadius, fontFamily }
```

## Impact Analysis

### Files created (new)
- `apps/widget/src/styles/variables.css` — CSS custom properties
- `apps/server/src/routes/config.ts` — config endpoint
- `apps/admin/src/pages/brand-settings.tsx` — brand config UI

### Files modified
- `apps/widget/src/trail-chat.ts` — add customization attributes + config loading
- `packages/db/src/schema.ts` — add brandConfig to tenants table
- `apps/server/src/app.ts` — mount config route (public, no auth)

### Downstream dependents for modified files

**`apps/widget/src/trail-chat.ts`** — adding attributes is additive. Existing embeds without customization attributes work unchanged.

**`packages/db/src/schema.ts`** — adding brandConfig column is additive.

### Blast radius
- Config endpoint is public (no auth) — only returns brand colors, no sensitive data
- CSS variables are scoped to widget shadow DOM — no leakage to host page
- Default values ensure widget always renders even without config

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Widget applies custom CSS variables from attributes
- [ ] Unit: Widget loads tenant config and applies brand defaults
- [ ] Integration: GET /config returns correct brand config for tenant
- [ ] Integration: Widget on external site uses tenant brand colors
- [ ] Manual: Embed widget with `primary-color="#ff0000"` → red theme
- [ ] Regression: Widget without customization attributes uses defaults

## Implementation Steps

1. Create CSS variables file for widget
2. Add customization attributes to trail-chat web component
3. Create config endpoint (public, tenant-scoped)
4. Add brandConfig column to tenants table
5. Create brand settings page in admin
6. Integration test: embed widget → verify CSS variables applied
7. Test tenant config loading + fallback to defaults

## Dependencies

- F29 (Trail Chat Widget) — widget is the customization target
- F40 (Multi-Tenancy) — per-tenant brand config

## Effort Estimate

**Small** — 1-2 days

- Day 1: CSS variables + widget attributes + config endpoint
- Day 2: Admin brand settings UI + integration testing
