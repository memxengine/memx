# F162 — Source dedup via SHA-256 checksum

> Forhindrer at samme fil-bytes uploades to gange til samme KB. Hver Source får en `content_hash` (SHA-256 hex) ved upload. Et nyt upload med matchende hash i samme KB returnerer 409 Conflict med info om den eksisterende Source — curator kan vælge at åbne den eksisterende eller eksplicit tvinge gen-upload via `?force=true`. Backfill computer hash for alle eksisterende sources én gang ved boot. Tier: alle tenants. Effort: Small — ~1.5-2 timer. Status: Planned.

## Problem

Trail's upload-route i dag har **ingen** dedup-tjek. En curator (Christian, eller fremtidens Sanne) der gen-uploader samme PDF, DOCX, billede eller markdown:

1. Får en ny `documents`-row med ny ID
2. Får en ny ingest-job kørt
3. Brænder LLM-credits på syntese af præcis samme content som allerede er compiled
4. Får dubletter af compiled wiki-Neurons (compile-output er deterministisk men ikke perfekt — to runs giver subtile forskelle og to sæt cross-references)
5. Forurener KB-search-resultater med duplikater

Konkret use case nu: Christian skal til at populate Sanne's KB med flere kilder. Han har 3 GB Sanne-materiale fordelt på flere mapper og er ikke 100% sikker på hvad der allerede er uploaded. Uden dedup-flag bliver upload-flow'et "upload, vent 60 sekunder, opdage at det var en duplikat, slette manuelt, brænde 0.05 credits + LLM-tokens for ingenting". Med 30+ kilder er det en time tabt + stress.

Bredere: når Sanne selv eller fremtidige customers begynder at uploade, vil de fejle på samme måde og have det værre fordi de ikke har SQL-adgang til at rydde op.

## Secondary Pain Points

- **Re-upload "for at få ny version"** — hvis curator har rettet en faktuel fejl i en PDF og vil uploade en ny version, vil dedup-tjek på bytes lade dem gennem (ny bytes = ny hash). Det er korrekt opførsel, men curator har ingen synlig "denne erstatter den gamle"-mønster — vi får to næsten-ens-Sources. **Out of scope for v1**: F162 dækker kun "EKSAKT samme bytes". Versioning er separat feature.
- **Same-file-different-name confusion**: en PDF gemt som `dokument-v3.pdf` lokalt og som `Sanne-NADA-final.pdf` på upload tidspunktet skal stadig fanges hvis bytes er identiske. SHA-256 dækker dette automatisk.
- **Storage-blob duplikering**: hvis dedup forhindrer DB-row-oprettelse men blob er allerede skrevet til disk inden tjekket, har vi spildt diskplads. Vi skal compute hash fra request body før storage-write.
- **CRC vs SHA-256 forvirring**: nogle disk-formater (S3, ZIP) bruger CRC32. Vi bruger SHA-256 hex-string både for collision-resistance OG fordi det er én hash i stedet for to-at-vedligeholde. CRC tilføjer ingen værdi når SHA-256 allerede er der.

## Solution

### Schema

To migrations — vi kan ikke lægge UNIQUE-index på en kolonne der har NULL-rows (eller rettere: vi kan, men gamle rows med NULL hash ville aldrig blive backfilled hvis indexet allerede afviste duplicate-NULLs på en eller anden måde — sikrere at dele).

**Migration 0024** — tilføj kolonnen som nullable:

```sql
ALTER TABLE documents ADD COLUMN content_hash TEXT;
```

Det breaker ingen pre-F162 rows (de får NULL).

**Boot-time backfill** — ved næste server-start opdager bootstrap'en at der findes `kind='source'` rows med `content_hash IS NULL`. For hver: `storage.get(...)` → `crypto.createHash('sha256').update(bytes).digest('hex')` → UPDATE row. Idempotent — anden run finder ingen NULL-rows og er en no-op.

**Migration 0025** — efter backfill kører første gang, kan vi sikkert tilføje den partial unique index:

```sql
CREATE UNIQUE INDEX idx_documents_content_hash
  ON documents(tenant_id, knowledge_base_id, content_hash)
  WHERE kind='source' AND content_hash IS NOT NULL;
```

Partial unique — null hashes konflikter ikke (men de bør ikke eksistere efter backfill, så det er belt-and-suspenders).

**Bemærk migrations-orden:** 0024 lander først, server starter, bootstrap kører backfill, derefter 0025 lander ved næste server-start. Det betyder F162 v1 har en deploy-rækkefølge: ship 0024+backfill først, vent til alle deploys har kørt deres backfill, ship så 0025. For lokal dev (kun én engine) er det trivielt — for fremtidens multi-engine (F40.2 multi-tenant) skal vi tænke det igennem hvis backfill skal koordineres.

### Upload-route ændring

Snippet (kondenseret — fuld impl i commit):

```typescript
// apps/server/src/routes/uploads.ts

import { createHash } from 'node:crypto';

uploadRoutes.post('/sources', async (c) => {
  // ... eksisterende auth + multipart parse ...

  const fileBytes = await file.arrayBuffer();
  const contentHash = createHash('sha256').update(new Uint8Array(fileBytes)).digest('hex');
  const force = c.req.query('force') === 'true';

  // F162 — KB-scoped dedup. Same bytes in same KB = same Source.
  if (!force) {
    const existing = await trail.db
      .select({
        id: documents.id,
        filename: documents.filename,
        path: documents.path,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, tenant.id),
          eq(documents.knowledgeBaseId, kbId),
          eq(documents.kind, 'source'),
          eq(documents.contentHash, contentHash),
        ),
      )
      .get();
    if (existing) {
      return c.json(
        {
          error: 'A source with identical content already exists in this Trail.',
          code: 'duplicate_source',
          existingDocumentId: existing.id,
          existingFilename: existing.filename,
          existingPath: existing.path,
          existingCreatedAt: existing.createdAt,
          hint: 'Append ?force=true to upload anyway as a separate Source.',
        },
        409,
      );
    }
  }

  // Pass through — store bytes + insert row with content_hash set.
  await storage.put(...);
  await trail.db.insert(documents).values({ ..., contentHash, ... });
  // ... eksisterende ingest-job-enqueue ...
});
```

Hashing er computed PRE-storage-write så vi ikke spilder disk-plads på en blob der så afvises.

### Admin UI

`apps/admin/src/panels/sources.tsx` (eller hvor upload-handler bor) handler 409-responsen:

```typescript
catch (err) {
  if (err instanceof ApiError && err.status === 409 && err.code === 'duplicate_source') {
    setDuplicateConflict({
      file,
      existingDocumentId: err.body.existingDocumentId,
      existingFilename: err.body.existingFilename,
      existingPath: err.body.existingPath,
      existingCreatedAt: err.body.existingCreatedAt,
    });
    return;
  }
  // ... existing error handling ...
}
```

Custom modal (ikke native confirm — CLAUDE.md hard rule):

```tsx
<Modal
  open={duplicateConflict !== null}
  title={t('sources.duplicate.title')}
  onClose={() => setDuplicateConflict(null)}
  footer={
    <>
      <ModalButton onClick={() => setDuplicateConflict(null)}>
        {t('common.cancel')}
      </ModalButton>
      <ModalButton variant="primary" onClick={() => openExisting()}>
        {t('sources.duplicate.openExisting')}
      </ModalButton>
      <ModalButton variant="danger" onClick={() => uploadWithForce()}>
        {t('sources.duplicate.uploadAnyway')}
      </ModalButton>
    </>
  }
>
  <p>{t('sources.duplicate.body', {
    filename: duplicateConflict.existingFilename,
    date: formatDate(duplicateConflict.existingCreatedAt),
  })}</p>
</Modal>
```

Tre actions, varieret severity:
- **Annullér** (default — most common case where curator just opens the existing instead)
- **Åbn eksisterende** (links til Source-side)
- **Upload alligevel** (danger — explicit retry with `?force=true`, lander en separat Source-row med samme content_hash men forskellig id, breaks unique-index? **NEJ** — fordi unique-index er per `(tenant_id, knowledge_base_id, content_hash)`, og force-uploaden ville stadig kollidere. Vi skal LETTE constraintet for force-path, eller acceptere at force ikke virker i v1.)

**Beslutning**: i v1 betyder force=true at vi loosenes constraintet til at tillade duplikat-rows. Implementation: index'et ER unique, men force-pathway sætter `content_hash = NULL` (eller en suffix-decoreret variant) på den nye row så index'et ikke konflikter. Curator får sin duplicate, men dedup er tabt for den row. **Cleaner alternativ**: fjern unique-index helt, gør dedup-tjek pure i app-code; force=true bypasser bare app-tjekket. Det er lettere at forstå og giver os fleksibilitet senere.

**Final beslutning**: app-level dedup-tjek (ingen DB-level UNIQUE-constraint i v1). Schema får kolonnen + non-unique index (for hurtigt lookup), og app-koden enforcer uniqueness-policy. Det betyder ingen 0025 partial-unique-index i v1 — bare en almindelig non-unique index for lookup-performance.

### Revised migration plan

- **Migration 0024** (only): `ALTER TABLE documents ADD COLUMN content_hash TEXT` + `CREATE INDEX idx_documents_content_hash ON documents(tenant_id, knowledge_base_id, content_hash) WHERE content_hash IS NOT NULL` (non-unique, for lookup speed only).
- App-level enforcement i upload-route. Force=true bypasser tjekket ren, ingen schema-trick nødvendigt.
- Hvis vi senere vil hæve det til schema-level UNIQUE for safety, kan det migreres i F162.1 separat.

## Non-Goals

- **Versioning af Sources** — F162 dækker ikke "denne PDF erstatter den gamle". Det er en separat feature (måske F163 eller integration i F148/F150 link-integrity-flow).
- **Cross-KB dedup**: vi blokerer kun hvis samme bytes findes i samme KB. Cross-KB samme-bytes (samme reference-PDF i to fagområder) er en legitim use case.
- **Cross-tenant dedup**: aldrig. Tenant-isolering er hellig.
- **Storage-side dedup** (sharing af samme blob mellem to documents-rows): out of scope. Vi bruger ekstra diskplads for force-uploads. Hvis storage-pressure bliver et problem kan vi tilføje content-addressable storage senere.
- **Hash på chunks eller wiki-Neurons**: F158's `last_contradiction_scan_signature` er allerede content-derived hash for Neurons til lint-skip. F162 er kun for source-bytes.
- **CRC32 / MD5 / andre hashes**: SHA-256 er den eneste hash. Argumentet for "også CRC for fart" er ikke valid — SHA-256 i Bun's native crypto er ~1 GB/s, langt over disk-IO-loftet for typiske source-filer.
- **Rate-limit på dedup-tjek**: ikke nødvendigt. Dedup-tjekket er én indexed query — sub-millisecond. Ingen DOS-flade.

## Technical Design

### Migration 0024

```sql
-- F162 — Source dedup via SHA-256 content hash.
--
-- One nullable text column on documents + a non-unique partial index
-- for lookup performance. Uniqueness is enforced in app code (upload
-- route) so force=true uploads can bypass cleanly without schema
-- gymnastics.
--
-- content_hash is hex-encoded SHA-256 of the original file bytes,
-- computed at upload time. NULL on pre-F162 rows + on force-uploaded
-- duplicates. Backfill bootstrap populates NULL rows once per server
-- start until all sources have hashes.

ALTER TABLE documents ADD COLUMN content_hash TEXT;
--> statement-breakpoint
CREATE INDEX idx_documents_content_hash
  ON documents(tenant_id, knowledge_base_id, content_hash)
  WHERE kind = 'source' AND content_hash IS NOT NULL;
```

### Backfill bootstrap

`apps/server/src/bootstrap/backfill-content-hash.ts`:

```typescript
import { createHash } from 'node:crypto';
import { documents, type TrailDatabase } from '@trail/db';
import { and, eq, isNull } from 'drizzle-orm';
import { storage, sourcePath } from '../lib/storage.js';

/**
 * F162 — backfill content_hash for source rows that don't have one.
 * Idempotent: re-run is a no-op once all rows are populated.
 *
 * Runs at boot. On a fresh DB or one already backfilled the SELECT
 * returns 0 rows and we exit immediately. On an upgrade-deploy with
 * 100+ legacy sources it's ~1-5 seconds total — disk-IO bound on
 * the storage.get() calls, not CPU.
 */
export async function backfillContentHash(trail: TrailDatabase): Promise<void> {
  const rows = await trail.db
    .select({
      id: documents.id,
      tenantId: documents.tenantId,
      knowledgeBaseId: documents.knowledgeBaseId,
      filename: documents.filename,
    })
    .from(documents)
    .where(
      and(
        eq(documents.kind, 'source'),
        isNull(documents.contentHash),
        eq(documents.archived, false),
      ),
    )
    .all();

  if (rows.length === 0) return;
  console.log(`[F162] backfilling content_hash for ${rows.length} source(s)…`);

  let done = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const bytes = await storage.get(
        sourcePath(row.tenantId, row.knowledgeBaseId, row.id, row.filename),
      );
      if (!bytes) {
        skipped++;
        continue;
      }
      const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
      await trail.db
        .update(documents)
        .set({ contentHash: hash })
        .where(eq(documents.id, row.id))
        .run();
      done++;
    } catch (err) {
      console.warn(
        `[F162] backfill failed for ${row.id}: ${err instanceof Error ? err.message : err}`,
      );
      skipped++;
    }
  }

  console.log(`[F162] backfill done — ${done} hashed, ${skipped} skipped`);
}
```

Wired ind i `createApp` boot-path efter `runMigrations` + before `initFTS` (rough order — actual placement TBD by reading the existing bootstrap chain).

### Upload-route dedup-gate

Inserted i `uploadRoutes.post('/sources', ...)` PRE storage-write.

### Admin UI

Custom modal i `apps/admin/src/panels/sources.tsx` der reagerer på `409 + code === 'duplicate_source'`. Tre actions: Annullér / Åbn eksisterende / Upload alligevel.

i18n keys i `apps/admin/src/locales/{da,en}.json`:

```json
"sources": {
  "duplicate": {
    "title": "Filen findes allerede",
    "body": "En fil med præcis samme indhold blev uploaded {date} som {filename}. Upload skip'es som default for at undgå dubletter.",
    "openExisting": "Åbn eksisterende",
    "uploadAnyway": "Upload alligevel"
  }
}
```

## Rollout

Single-phase commit:

- [ ] Plan-doc landing
- [ ] Migration 0024 (column + non-unique index)
- [ ] schema.ts + journal.json updated
- [ ] Backfill bootstrap module + wired into createApp
- [ ] Upload-route dedup-gate
- [ ] Admin UI duplicate-modal + i18n
- [ ] Verify-script
- [ ] Post-deploy: backfill kører automatisk på næste server-start

Christian deploys → server restart → backfill computer hash for de 106 eksisterende sources i ~1-2 sekunder → fra det øjeblik er duplicate-detection live.

## Verify plan

`apps/server/scripts/verify-f162.ts`:

1. **Fresh upload computes hash + sets column**: upload probe-bytes, SELECT row → content_hash matches expected SHA-256.
2. **Re-upload same bytes → 409 with structured code**: second upload returns `409` + body `{ code: 'duplicate_source', existingDocumentId, existingFilename, existingPath, hint }`.
3. **`?force=true` bypasses**: third upload with `?force=true` returns 200, creates new row (with content_hash NULL since force-pathway doesn't set it — or alternatively: sets it but app-tjek skipped).
4. **Backfill populates NULL row**: insert source-row with content_hash=NULL directly via SQL, run backfill, verify hash now populated and matches storage bytes.
5. **Cross-KB same-tenant same-bytes**: upload to KB-A, then to KB-B (same tenant) → second one 200, NOT 409 (legitimate cross-KB use case).
6. **Cross-tenant same-bytes**: tenant-A uploads, tenant-B uploads same bytes → both 200 (tenant isolation must hold).

## Open Questions

- **Force-uploaded rows: hash NULL or duplicate hash?**
  - **NULL**: simpler, no constraint violations, but loses dedup-detection for the force-uploaded row going forward.
  - **Duplicate hash**: preserves audit trail, but app-tjek skal eksplicit kunne skippe på force-pathway (ingen DB-constraint at fight med since vi har non-unique index).
  - **Min beslutning for v1**: **duplicate hash**. App-tjek ser hashen, men force-pathway preset'er en flag der skipper tjekket. Cleaner audit, ingen "magic NULL" for force-rows.

- **Admin UI place: i sources.tsx upload-handler eller en shared upload-utility?**
  - Upload sker fra flere steder (top-level Upload-button, Sources-panel, drag-and-drop). Modal-handling bør sandsynligvis lives i en shared `useUploadHandler()` hook for at undgå duplication.
  - **Min beslutning**: Inline i sources.tsx for v1; refactor til hook hvis upload-flows multipliceres.

- **Skal vi rapportere dedup-stats i admin?**
  - "Du har sparet X uploads i sidste måned" o.l. data-viz?
  - **Out of scope for v1** — telemetri-feature for senere.

## Effort Estimate

1.5-2 timer total:
- Plan-doc: 30 min (this) ✓
- Migration + schema: 15 min
- Backfill bootstrap: 30 min
- Upload-route ændring: 30 min
- Admin UI modal + i18n: 30 min
- Verify-script: 30 min
- Documentation update + commit: 15 min

## Dependencies

- F08 ✅ PDF Pipeline (uploads.ts exists with file-handling pattern to extend)
- F25 ✅ Image Pipeline (same upload flow)
- Existing `storage` module + `sourcePath()` helper

## Related Features

- **F158** Idempotent Contradiction-Lint — same SHA-256-based content-signature pattern, adopted for Neurons. F162 is the source-side equivalent.
- **F142** New Neuron Modal — when curator creates Neurons by hand, no dedup applies (curator-authored content, not file-bytes).
- **F143** Persistent Ingest Queue — duplicate dedup happens BEFORE ingest job enqueue, so a duplicate doesn't burn a Queue slot.
