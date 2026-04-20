// Step screens S1–S7 + Done.
// Ported from the Claude Design handoff bundle (Screens.jsx).

import type { ComponentChildren, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BauhausSelect } from './components/bauhaus-select';
import type { Copy, Lang, TemplateKey } from './copy';
import {
  ChatDiagram,
  IngestDiagram,
  KbSchematic,
  MemexDiagram,
  SourcesDiagram,
  TeamDiagram,
  TemplateGlyph,
} from './diagrams';

export interface OnboardingState {
  step: number;
  lang: Lang;
  kbName: string;
  kbSlug: string;
  kbSlugTouched: boolean;
  kbDesc: string;
  tpl: TemplateKey | null;
  customSchema: boolean;
  sources: { n: string; s: string; status: 'ok' | 'work' | 'idle'; label: string }[];
  connectors: string[];
  invites: { email: string; role: string }[];
  autoApprove: boolean;
  ingestRun: number;
}

export type SetState = (patch: Partial<OnboardingState>) => void;

// Slugify
const slugify = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .replace(/[å]/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

// Tiny copy-to-clipboard icon button. Sits next to the slug preview in S2
// so the curator can grab the full URL without highlighting + cmd-c. Flips
// glyph + border to the success colour for 1.2s on copy. Silent fallback
// when `navigator.clipboard` is unavailable (old browsers, sandboxed iframes)
// — the user can still drag-select the host/slug text manually.
function CopyUrlButton({ url, disabled = false }: { url: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (): Promise<void> => {
    if (disabled || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied — silent per the fallback described above */
    }
  };
  return (
    <button
      type="button"
      class={`slug-copy${copied ? ' copied' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={copied ? 'Kopieret' : 'Kopiér URL'}
      aria-label={copied ? 'Kopieret' : 'Kopiér URL'}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="5" y="5" width="8" height="8" />
          <path d="M3 11V4a1 1 0 0 1 1-1h7" />
        </svg>
      )}
    </button>
  );
}

// ─────── Shared primitives ───────
function Eyebrow({ children }: { children: ComponentChildren }) {
  return (
    <div className="eyebrow">
      <span className="tick" />
      {children}
    </div>
  );
}

function SchematicFrame({
  children,
  title,
  fig,
  scale,
}: {
  children: ComponentChildren;
  title: string;
  fig: string;
  scale: string;
}) {
  return (
    <div>
      <div className="schematic-frame">
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 16,
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--fg-subtle)',
          }}
        >
          {title}
        </div>
        {children}
      </div>
      <div className="schem-caption">
        <span>{fig}</span>
        <span>{scale}</span>
      </div>
    </div>
  );
}

// ─────── S1 · Concept ───────
export function S1Concept({ t, onNext }: { t: Copy; onNext: () => void }) {
  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s1.eyebrow}</Eyebrow>
        <h1 className="display">{t.s1.h1}</h1>
        <p className="lede">{t.s1.lede}</p>
        <div style={{ display: 'grid', gap: 14, marginBottom: 24 }}>
          {t.s1.bullets.map(([k, head, body]) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '60px 1fr',
                gap: 16,
                paddingBottom: 14,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.1em',
                  color: 'var(--fg-subtle)',
                  paddingTop: 4,
                }}
              >
                {k}
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 17, marginBottom: 4 }}>
                  {head}
                </div>
                <div style={{ color: 'var(--fg-muted)', fontSize: 13.5, lineHeight: 1.5 }}>
                  {body}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={onNext}>
            {t.s1.cta} <span className="arrow">→</span>
          </button>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--fg-subtle)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {t.s1.time}
          </span>
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s1.frameTitle}
          fig={t.diagrams.s1.caption}
          scale={t.diagrams.scale}
        >
          <MemexDiagram d={t.diagrams.s1} />
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── S2 · KB ───────
export function S2Kb({
  t,
  state,
  set,
}: {
  t: Copy;
  state: OnboardingState;
  set: SetState;
}) {
  const slug = state.kbSlug || slugify(state.kbName);
  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s2.eyebrow}</Eyebrow>
        <h1 className="display">{t.s2.h1}</h1>
        <p className="lede">{t.s2.lede}</p>

        <div className="field">
          <label>
            {t.s2.nameLabel}
            <span className="hint">— {t.s2.nameHint}</span>
          </label>
          <input
            type="text"
            value={state.kbName}
            placeholder={t.s2.namePh}
            onInput={(e) =>
              set({
                kbName: (e.target as HTMLInputElement).value,
                kbSlug: state.kbSlugTouched
                  ? state.kbSlug
                  : slugify((e.target as HTMLInputElement).value),
              })
            }
          />
        </div>

        <div className="field">
          <label>
            {t.s2.slugLabel}
            <span className="hint">— {t.s2.slugHint}</span>
          </label>
          <input
            type="text"
            value={slug}
            placeholder="org-kb"
            onInput={(e) =>
              set({
                kbSlug: slugify((e.target as HTMLInputElement).value),
                kbSlugTouched: true,
              })
            }
          />
          <div className="slug-preview">
            <span className="host">admin.trailmem.com/kb/</span>
            <span className="slug">{slug || '…'}</span>
            <CopyUrlButton url={`admin.trailmem.com/kb/${slug}`} disabled={!slug} />
          </div>
          <div className="sub-hint">{t.s2.sub}</div>
        </div>

        <div className="field">
          <label>
            {t.s2.descLabel}
            <span className="hint">— {t.s2.descHint}</span>
          </label>
          <textarea
            value={state.kbDesc}
            placeholder={t.s2.descPh}
            onInput={(e) => set({ kbDesc: (e.target as HTMLTextAreaElement).value })}
          />
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s2.frameTitle}
          fig={t.diagrams.s2.caption}
          scale={t.diagrams.scale}
        >
          <KbSchematic name={state.kbName} slug={slug} d={t.diagrams.s2} />
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── S3 · Template ───────
export function S3Template({
  t,
  state,
  set,
}: {
  t: Copy;
  state: OnboardingState;
  set: SetState;
}) {
  const typeMap: Record<TemplateKey, [string, number, number, 'sq' | 'ci' | 'tri'][]> = {
    blank: [
      ['entity', 100, 80, 'sq'],
      ['concept', 340, 80, 'ci'],
      ['source', 220, 310, 'tri'],
    ],
    personal: [
      ['person', 100, 80, 'ci'],
      ['note', 340, 80, 'sq'],
      ['quote', 220, 310, 'tri'],
    ],
    clinic: [
      ['patient', 100, 80, 'ci'],
      ['protocol', 340, 80, 'sq'],
      ['diagnosis', 100, 300, 'tri'],
      ['exercise', 340, 300, 'ci'],
    ],
    engineering: [
      ['service', 100, 80, 'sq'],
      ['adr', 340, 80, 'sq'],
      ['incident', 100, 300, 'tri'],
      ['runbook', 340, 300, 'ci'],
    ],
    research: [
      ['paper', 100, 80, 'sq'],
      ['author', 340, 80, 'ci'],
      ['claim', 220, 310, 'tri'],
    ],
    legal: [
      ['case', 100, 80, 'sq'],
      ['clause', 340, 80, 'sq'],
      ['party', 100, 300, 'ci'],
      ['ruling', 340, 300, 'tri'],
    ],
  };
  const types = state.tpl ? typeMap[state.tpl] : [];

  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s3.eyebrow}</Eyebrow>
        <h1 className="display">{t.s3.h1}</h1>
        <p className="lede">{t.s3.lede}</p>

        <div className="grid-templates">
          {t.s3.templates.map((tpl) => (
            <div
              key={tpl.k}
              className={`tpl-card ${state.tpl === tpl.k ? 'selected' : ''}`}
              onClick={() => set({ tpl: tpl.k, customSchema: false })}
            >
              <span className="radio" />
              <div className="glyph">
                <svg viewBox="0 0 30 30" width="28" height="28">
                  <TemplateGlyph kind={tpl.k} />
                </svg>
              </div>
              <div className="title">{tpl.t}</div>
              <div className="sub">{tpl.s}</div>
              <div className="desc">{tpl.d}</div>
              <div className="tags">
                {tpl.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 16,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--fg-subtle)',
            letterSpacing: '0.08em',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={state.customSchema}
              onChange={(e) => {
                const checked = (e.target as HTMLInputElement).checked;
                set({ customSchema: checked, tpl: checked ? null : state.tpl });
              }}
            />
            {t.s3.alt}
          </label>
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s3.frameTitle}
          fig={t.diagrams.s3.caption}
          scale={t.diagrams.scale}
        >
          <svg viewBox="0 0 440 380" width="100%" style={{ color: 'var(--fg)' }}>
            <defs>
              <pattern id="g3" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" stroke-opacity="0.06" />
              </pattern>
            </defs>
            <rect width="440" height="380" fill="url(#g3)" />
            {/* central kb */}
            <circle
              cx="220"
              cy="190"
              r="30"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-dasharray="3 3"
            />
            <text
              x="220"
              y="194"
              text-anchor="middle"
              font-family="JetBrains Mono, monospace"
              font-size="10"
              letter-spacing="1"
              fill="currentColor"
              fill-opacity="0.7"
            >
              kb
            </text>
            {/* emitted neuron types — vary by tpl */}
            {types.map(([lbl, x, y, shape], i) => (
              <g key={i}>
                <line x1="220" y1="190" x2={x} y2={y} stroke="currentColor" stroke-opacity="0.35" />
                {shape === 'sq' && (
                  <rect
                    x={x - 14}
                    y={y - 14}
                    width="28"
                    height="28"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                  />
                )}
                {shape === 'ci' && (
                  <circle cx={x} cy={y} r="14" fill="none" stroke="currentColor" stroke-width="1.4" />
                )}
                {shape === 'tri' && (
                  <polygon
                    points={`${x},${y - 14} ${x + 14},${y + 14} ${x - 14},${y + 14}`}
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                  />
                )}
                <text
                  x={x}
                  y={y + 36}
                  text-anchor="middle"
                  font-family="JetBrains Mono, monospace"
                  font-size="9.5"
                  letter-spacing="1"
                  fill="currentColor"
                  fill-opacity="0.75"
                >
                  {lbl}
                </text>
              </g>
            ))}
            {!state.tpl && (
              <text
                x="220"
                y="250"
                text-anchor="middle"
                font-family="Fraunces, Georgia, serif"
                font-style="italic"
                font-size="13"
                fill="currentColor"
                fill-opacity="0.5"
              >
                {t.diagrams.s3.selectPrompt}
              </text>
            )}
            <text
              x="30"
              y="360"
              font-family="JetBrains Mono, monospace"
              font-size="9.5"
              letter-spacing="1"
              fill="currentColor"
              fill-opacity="0.55"
            >
              {t.diagrams.s3.figLabel}
            </text>
            <text
              x="410"
              y="360"
              text-anchor="end"
              font-family="JetBrains Mono, monospace"
              font-size="9.5"
              letter-spacing="1"
              fill="currentColor"
              fill-opacity="0.55"
            >
              {t.diagrams.s3.mutable}
            </text>
          </svg>
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── S4 · Sources ───────
export function S4Sources({
  t,
  state,
  set,
}: {
  t: Copy;
  state: OnboardingState;
  set: SetState;
}) {
  const [drag, setDrag] = useState(false);
  const addFile = () => {
    const next = [...state.sources];
    if (next.length < t.s4.samples.length) {
      const sample = t.s4.samples[next.length];
      if (sample) next.push(sample);
    }
    set({ sources: next });
  };
  const connectorDefs: { id: string; name: string; glyph: string }[] = [
    { id: 'mcp', name: 'MCP', glyph: '△' },
    { id: 'webclip', name: 'Web clipper', glyph: '◐' },
    { id: 'gh', name: 'GitHub', glyph: '◇' },
    { id: 'notion', name: 'Notion', glyph: '▢' },
  ];
  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s4.eyebrow}</Eyebrow>
        <h1 className="display">{t.s4.h1}</h1>
        <p className="lede">{t.s4.lede}</p>

        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFile();
          }}
          onClick={addFile}
        >
          <svg width="44" height="44" viewBox="0 0 44 44" style={{ color: 'var(--fg)' }}>
            <rect x="1" y="1" width="42" height="42" fill="none" stroke="currentColor" stroke-dasharray="3 3" />
            <line x1="22" y1="12" x2="22" y2="32" stroke="currentColor" stroke-width="1.5" />
            <line x1="12" y1="22" x2="32" y2="22" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <div className="big">{t.s4.drop}</div>
          <div className="small">{t.s4.dropSub}</div>
        </div>

        {state.sources.length > 0 && (
          <div style={{ marginTop: 24 }}>
            {state.sources.map((f, i) => (
              <div className="src-row" key={i}>
                <div className="glyph">{f.n.split('.').pop()?.toUpperCase().slice(0, 3) ?? ''}</div>
                <div>
                  <div className="name">{f.n}</div>
                  <div className="meta">{f.s}</div>
                </div>
                <div className={`status ${f.status}`}>{f.label}</div>
                <button
                  className="btn ghost"
                  style={{ padding: '8px 12px', fontSize: 10 }}
                  onClick={() => set({ sources: state.sources.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 36 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
              marginBottom: 6,
            }}
          >
            {t.s4.connectors}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{t.s4.connectorSub}</div>
          <div className="connector-grid">
            {connectorDefs.map((c) => (
              <div
                key={c.id}
                className={`connector ${state.connectors.includes(c.id) ? 'enabled' : ''}`}
                onClick={() =>
                  set({
                    connectors: state.connectors.includes(c.id)
                      ? state.connectors.filter((x) => x !== c.id)
                      : [...state.connectors, c.id],
                  })
                }
              >
                <div className="cglyph">{c.glyph}</div>
                <div className="cname">{c.name}</div>
                <div className="cstatus">{state.connectors.includes(c.id) ? 'ON' : 'OFF'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s4.frameTitle}
          fig={(state.sources.length === 1 ? t.diagrams.s4.captionOne : t.diagrams.s4.captionMany).replace(
            '{n}',
            String(state.sources.length),
          )}
          scale={t.diagrams.scale}
        >
          <SourcesDiagram count={state.sources.length} d={t.diagrams.s4} />
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── S5 · Team ───────
export function S5Team({
  t,
  state,
  set,
}: {
  t: Copy;
  state: OnboardingState;
  set: SetState;
}) {
  const invites = state.invites.length ? state.invites : [{ email: '', role: 'curator' }];
  const update = (i: number, patch: Partial<{ email: string; role: string }>) => {
    const next = invites.map((row, idx) => (idx === i ? { ...row, ...patch } : row));
    set({ invites: next });
  };
  const add = () => set({ invites: [...invites, { email: '', role: 'reader' }] });
  const rm = (i: number) => set({ invites: invites.filter((_, idx) => idx !== i) });
  const filled = invites.filter((r) => r.email.includes('@')).length + 1; // +admin

  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s5.eyebrow}</Eyebrow>
        <h1 className="display">{t.s5.h1}</h1>
        <p className="lede">{t.s5.lede}</p>

        <div className="role-legend">
          {t.s5.roles.map(([k, n, d]) => (
            <div className="k" key={k}>
              <b>
                {k} · {n}
              </b>
              <span>{d}</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 24 }}>
          <div
            className="invite-row"
            style={{
              gridTemplateColumns: '1fr 150px 28px',
              marginBottom: 12,
              paddingBottom: 10,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--fg-muted)',
                padding: '10px 0',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              you@example.com
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--fg)',
                padding: '10px 12px',
                border: '1px solid var(--border)',
                background: 'var(--bg-sunken)',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              Admin · you
            </div>
            <div />
          </div>
          {invites.map((row, i) => (
            <div className="invite-row" key={i}>
              <input
                type="email"
                placeholder={t.s5.emailPh}
                value={row.email}
                onInput={(e) => update(i, { email: (e.target as HTMLInputElement).value })}
              />
              <BauhausSelect<'admin' | 'curator' | 'reader'>
                value={row.role as 'admin' | 'curator' | 'reader'}
                options={[
                  { value: 'admin', label: 'Admin' },
                  { value: 'curator', label: 'Curator' },
                  { value: 'reader', label: 'Reader' },
                ]}
                onChange={(v) => update(i, { role: v })}
                ariaLabel="Role"
              />
              <button className="rm" onClick={() => rm(i)}>
                ×
              </button>
            </div>
          ))}
          <button className="btn ghost" onClick={add} style={{ marginTop: 8 }}>
            {t.s5.addRow}
          </button>
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s5.frameTitle}
          fig={(filled === 1 ? t.diagrams.s5.captionOne : t.diagrams.s5.captionMany).replace(
            '{n}',
            String(filled),
          )}
          scale={t.diagrams.scale}
        >
          <TeamDiagram members={Math.max(1, filled)} d={t.diagrams.s5} />
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── S6 · Ingest (animated) ───────
interface IngestLog {
  text: [string, string];
  cls?: string;
}
interface IngestNeuron {
  id: string;
  title: string;
  tag: string;
  fresh?: boolean;
}

export function S6Ingest({
  t,
  state,
  set,
}: {
  t: Copy;
  state: OnboardingState;
  set: SetState;
}) {
  const [phase, setPhase] = useState(0);
  const [logs, setLogs] = useState<IngestLog[]>([]);
  const [neurons, setNeurons] = useState<IngestNeuron[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPhase(0);
    setLogs([]);
    setNeurons([]);

    const script: {
      delay: number;
      phase?: number;
      log?: [string, string];
      cls?: string;
      neuron?: IngestNeuron;
    }[] = [
      { delay: 400, phase: 0, log: ['t+0000', 'READ shoulder-protocol-2026.pdf · 18 pages · 412kb'] },
      { delay: 600, phase: 0, log: ['t+0123', 'PARSE ok · 4,218 tokens extracted'] },
      { delay: 600, phase: 1, log: ['t+0412', 'EXTRACT entities → 6 candidates'] },
      { delay: 400, phase: 1, log: ['t+0508', '  · Frozen Shoulder (diagnosis) · conf 0.94'], cls: 'ok' },
      { delay: 350, phase: 1, log: ['t+0521', "  · Codman's Pendulum (exercise) · conf 0.88"], cls: 'ok' },
      { delay: 350, phase: 2, log: ['t+0712', 'COMPILE neuron N-01 · diagnosis/frozen-shoulder'] },
      { delay: 350, phase: 2, neuron: { id: 'N-01', title: 'Frozen Shoulder', tag: 'DIAGNOSIS' } },
      { delay: 350, phase: 2, log: ['t+0840', 'COMPILE neuron N-02 · exercise/codmans-pendulum'] },
      { delay: 350, phase: 2, neuron: { id: 'N-02', title: "Codman's Pendulum", tag: 'EXERCISE' } },
      { delay: 350, phase: 2, log: ['t+0914', 'COMPILE neuron N-03 · protocol/shoulder-week-1'] },
      { delay: 350, phase: 2, neuron: { id: 'N-03', title: 'Shoulder Week 1', tag: 'PROTOCOL' } },
      { delay: 450, phase: 3, log: ['t+1112', 'LINK N-01 ↔ N-02 · mentioned_in'], cls: 'hl' },
      { delay: 300, phase: 3, log: ['t+1118', 'LINK N-01 ↔ N-03 · treated_by'], cls: 'hl' },
      { delay: 400, phase: 3, neuron: { id: 'N-04', title: 'Patient · Marianne H.', tag: 'PATIENT', fresh: true } },
      { delay: 300, phase: 3, log: ['t+1240', 'CANDIDATE queued → curator review'], cls: 'warn' },
      { delay: 300, phase: 3, log: ['t+1244', 'DONE · 4 neurons · 3 trails · queue=1'], cls: 'ok' },
    ];
    let i = 0;
    const tick = () => {
      if (i >= script.length) return;
      const stepItem = script[i++]!;
      if (stepItem.phase !== undefined) setPhase(stepItem.phase);
      if (stepItem.log) {
        const log = stepItem.log;
        const cls = stepItem.cls;
        setLogs((l) => [...l, { text: log, cls }]);
      }
      if (stepItem.neuron) {
        const n = stepItem.neuron;
        setNeurons((ns) => [...ns, n]);
      }
      timer.current = setTimeout(tick, stepItem.delay);
    };
    timer.current = setTimeout(tick, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state.ingestRun]);

  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s6.eyebrow}</Eyebrow>
        <h1 className="display">{t.s6.h1}</h1>
        <p className="lede">{t.s6.lede}</p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 14,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {t.s6.phases.map((p, i) => (
              <span
                key={i}
                style={{
                  color: phase >= i ? 'var(--fg)' : 'var(--fg-subtle)',
                  display: 'inline-flex',
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: phase >= i ? 'var(--accent)' : 'var(--fg-subtle)',
                  }}
                />
                {p}
              </span>
            ))}
          </div>
          <button
            className="btn ghost"
            style={{ padding: '8px 14px', fontSize: 10 }}
            onClick={() => set({ ingestRun: (state.ingestRun || 0) + 1 })}
          >
            {t.s6.replay}
          </button>
        </div>

        <div className="ingest-log">
          {logs.map((l, i) => (
            <div key={i}>
              <span className="t">{l.text[0]}</span>
              <span className={l.cls || ''}>{l.text[1]}</span>
            </div>
          ))}
          {phase < 3 && (
            <div>
              <span className="t">t+{(1300 + logs.length * 10).toString().padStart(4, '0')}</span>
              <span className="typing">_</span>
            </div>
          )}
        </div>

        <div className="neuron-feed">
          {neurons.map((n) => (
            <div key={n.id} className={`neuron-pill ${n.fresh ? 'new' : ''}`}>
              <span className="n-id">{n.id}</span>
              <span className="n-title">{n.title}</span>
              <span className="n-tag">
                {n.tag}
                {n.fresh ? ' · CANDIDATE' : ''}
              </span>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 24,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--fg-subtle)',
            letterSpacing: '0.06em',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={state.autoApprove}
              onChange={(e) => set({ autoApprove: (e.target as HTMLInputElement).checked })}
            />
            {t.s6.autoApprove}
          </label>
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s6.frameTitle}
          fig={t.diagrams.s6.captionTpl
            .replace('{phase}', String(phase + 1))
            .replace('{n}', String(neurons.length))
            .replace('{q}', String(neurons.filter((n) => n.fresh).length))}
          scale={t.diagrams.scale}
        >
          <IngestDiagram phase={phase} d={t.diagrams.s6} />
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── S7 · Query ───────
interface ChatMsg {
  role: 'user' | 'ai';
  text?: string;
  html?: VNode;
}

export function S7Query({
  t,
  state,
  lang,
}: {
  t: Copy;
  state: OnboardingState;
  lang: Lang;
}) {
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [pending, setPending] = useState(false);

  const scripted: Record<Lang, Record<string, { html: VNode }>> = {
    da: {
      'Hvad er protokollen for frozen shoulder?': {
        html: (
          <>
            Vores aktuelle protokol for <span className="cite">[[Frozen Shoulder]]</span> er struktureret
            over 6 uger. I uge 1 starter vi med <span className="cite">[[Codmans Pendulum]]</span> for at
            genoprette scapulothorakal rytme uden at belaste kapslen, efterfulgt af passive mobiliseringer.
            Protokollen er senest opdateret i <span className="cite">[[Shoulder Week 1]]</span>.
          </>
        ),
      },
      'Hvem er Marianne fra Haslev?': {
        html: (
          <>
            Marianne H. (Haslev, 63 år) er registreret med frossen skulder · højre side, dokumenteret i{' '}
            <span className="cite">[[case-marianne-haslev.pdf]]</span>. Hun følger{' '}
            <span className="cite">[[Shoulder Week 1]]</span>-protokollen. Kandidatnoten er i kurator-køen
            og afventer godkendelse.
          </>
        ),
      },
    },
    en: {
      'What is the protocol for frozen shoulder?': {
        html: (
          <>
            Our current protocol for <span className="cite">[[Frozen Shoulder]]</span> runs over 6 weeks.
            Week 1 starts with <span className="cite">[[Codman's Pendulum]]</span> to restore
            scapulothoracic rhythm without loading the capsule, followed by passive mobilisations. The
            protocol was most recently updated in <span className="cite">[[Shoulder Week 1]]</span>.
          </>
        ),
      },
      'Who is Marianne from Haslev?': {
        html: (
          <>
            Marianne H. (Haslev, 63) is recorded with frozen shoulder · right side, documented in{' '}
            <span className="cite">[[case-marianne-haslev.pdf]]</span>. She is on the{' '}
            <span className="cite">[[Shoulder Week 1]]</span> protocol. The candidate note sits in the
            curator queue pending approval.
          </>
        ),
      },
    },
  };

  const ask = (q: string) => {
    if (!q.trim()) return;
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    setInput('');
    setPending(true);
    const bank = scripted[lang];
    const keys = Object.keys(bank);
    const match =
      keys.find((k) => q.toLowerCase().includes(k.toLowerCase().slice(0, 10))) ?? keys[0]!;
    setTimeout(() => {
      setMsgs((m) => [...m, { role: 'ai', html: bank[match]!.html }]);
      setPending(false);
    }, 900);
  };

  return (
    <div className="page">
      <div className="left">
        <Eyebrow>{t.s7.eyebrow}</Eyebrow>
        <h1 className="display">{t.s7.h1}</h1>
        <p className="lede">{t.s7.lede}</p>

        <div className="chat">
          <div className="chat-head">
            <span>CHAT · kb/{state.kbSlug || 'your-kb'}</span>
            <span>∵ 4 neurons · 3 trails</span>
          </div>
          <div className="chat-body">
            {msgs.length === 0 && (
              <div
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontStyle: 'italic',
                  color: 'var(--fg-subtle)',
                  fontSize: 15,
                }}
              >
                try one of the prompts below ↓
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="msg user">
                  {m.text}
                </div>
              ) : (
                <div key={i} className="msg ai">
                  {m.html}
                </div>
              ),
            )}
            {pending && (
              <div className="msg ai">
                <span className="typing">thinking</span>
              </div>
            )}
          </div>
          <div className="chat-suggest">
            {t.s7.suggest.map((s) => (
              <span key={s} className="s" onClick={() => ask(s)}>
                {s}
              </span>
            ))}
          </div>
          <div className="chat-input">
            <input
              value={input}
              placeholder={t.s7.ph}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && ask(input)}
            />
            <button className="send" onClick={() => ask(input)}>
              ↩ ENTER
            </button>
          </div>
        </div>
      </div>
      <div className="right">
        <SchematicFrame
          title={t.diagrams.s7.frameTitle}
          fig={t.diagrams.s7.caption}
          scale={t.diagrams.scale}
        >
          <ChatDiagram d={t.diagrams.s7} />
        </SchematicFrame>
      </div>
    </div>
  );
}

// ─────── Done ───────
export function SDone({ t, onExit }: { t: Copy; onExit: () => void }) {
  return (
    <div className="page" style={{ gridTemplateColumns: '1fr' }}>
      <div className="left" style={{ maxWidth: 780, margin: '0 auto', textAlign: 'center' }}>
        <Eyebrow>{t.sDone.eyebrow}</Eyebrow>
        <h1 className="display" style={{ fontSize: 'clamp(44px, 5vw, 68px)' }}>
          {t.sDone.h1}
        </h1>
        <p className="lede" style={{ margin: '0 auto 28px' }}>
          {t.sDone.lede}
        </p>

        <div
          className="done-stack"
          style={{ textAlign: 'left', maxWidth: 520, margin: '20px auto 28px' }}
        >
          {t.sDone.checks.map((c, i) => (
            <div className="done-row" key={i}>
              <div className="chk x">✓</div>
              <div>{c}</div>
              <div className="num">ok</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button className="btn primary" onClick={onExit}>
            {t.sDone.openAdmin} <span className="arrow">→</span>
          </button>
          <a href="/docs" className="btn ghost">
            {t.sDone.docs}
          </a>
        </div>
        <div
          style={{
            marginTop: 24,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            letterSpacing: '0.14em',
            color: 'var(--fg-subtle)',
          }}
        >
          {t.sDone.tip}
        </div>
      </div>
    </div>
  );
}
