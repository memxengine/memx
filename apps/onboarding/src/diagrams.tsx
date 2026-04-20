// Bauhaus-style schematic diagrams, one per onboarding step.
// All pure SVG; no external deps. Primitives: circle, square, triangle, grid.
// Ported from the Claude Design handoff bundle (Diagrams.jsx).

import type { ComponentChildren } from 'preact';
import type { Diagrams, TemplateKey } from './copy';

const DIAGRAM_ACCENT = '#E8A87C';
const DIAGRAM_RED = '#C23B22';
const DIAGRAM_BLUE = '#2F5D8F';

// Grid overlay — subtle coordinate system behind every diagram
function GridBg({ w = 440, h = 420, step = 20 }: { w?: number; h?: number; step?: number }) {
  const lines = [];
  for (let x = 0; x <= w; x += step)
    lines.push(
      <line key={`v${x}`} x1={x} y1={0} x2={x} y2={h} stroke="currentColor" stroke-opacity="0.06" />,
    );
  for (let y = 0; y <= h; y += step)
    lines.push(
      <line key={`h${y}`} x1={0} y1={y} x2={w} y2={y} stroke="currentColor" stroke-opacity="0.06" />,
    );
  return <g>{lines}</g>;
}

// Corner registration marks (like film / bauhaus drawings)
function RegistrationMarks({
  w = 440,
  h = 420,
  pad = 8,
  size = 12,
}: {
  w?: number;
  h?: number;
  pad?: number;
  size?: number;
}) {
  const s = size;
  return (
    <g stroke="currentColor" stroke-opacity="0.28" stroke-width="1" fill="none">
      <path d={`M${pad} ${pad + s} L${pad} ${pad} L${pad + s} ${pad}`} />
      <path d={`M${w - pad - s} ${pad} L${w - pad} ${pad} L${w - pad} ${pad + s}`} />
      <path d={`M${pad} ${h - pad - s} L${pad} ${h - pad} L${pad + s} ${h - pad}`} />
      <path d={`M${w - pad - s} ${h - pad} L${w - pad} ${h - pad} L${w - pad} ${h - pad - s}`} />
    </g>
  );
}

function AnnotLabel({
  x,
  y,
  children,
  anchor = 'start',
  size = 9.5,
}: {
  x: number;
  y: number;
  children: ComponentChildren;
  anchor?: 'start' | 'middle' | 'end';
  size?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      text-anchor={anchor}
      font-family="JetBrains Mono, ui-monospace, monospace"
      font-size={size}
      letter-spacing="1.1"
      fill="currentColor"
      fill-opacity="0.72"
      style={{ textTransform: 'uppercase' }}
    >
      {children}
    </text>
  );
}

// ═══════════════ STEP 1 · MEMEX / AS WE MAY THINK ═══════════════
export function MemexDiagram({ d }: { d: Diagrams['s1'] }) {
  const w = 440;
  const h = 420;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
      <GridBg w={w} h={h} />
      <RegistrationMarks w={w} h={h} />

      {/* SOURCE tri */}
      <g transform="translate(60, 80)">
        <polygon points="0,70 40,0 80,70" fill="none" stroke="currentColor" stroke-width="1.4" />
        <AnnotLabel x={40} y={92} anchor="middle">{d.source}</AnnotLabel>
        <AnnotLabel x={40} y={104} anchor="middle" size={8.5}>{d.sourceMeta}</AnnotLabel>
      </g>

      {/* ENGINE square — the memex */}
      <g transform="translate(180, 100)">
        <rect width="80" height="80" fill="none" stroke="currentColor" stroke-width="1.4" />
        <rect x="14" y="14" width="52" height="52" fill="none" stroke="currentColor" stroke-opacity="0.35" />
        <circle cx="40" cy="40" r="8" fill={DIAGRAM_ACCENT} />
        <AnnotLabel x={40} y={104} anchor="middle">{d.engine}</AnnotLabel>
        <AnnotLabel x={40} y={116} anchor="middle" size={8.5}>{d.engineMeta}</AnnotLabel>
      </g>

      {/* Neuron graph circle */}
      <g transform="translate(340, 140)">
        <circle cx="0" cy="0" r="42" fill="none" stroke="currentColor" stroke-width="1.4" />
        <circle cx="0" cy="0" r="4" fill="currentColor" />
        <circle cx="-16" cy="-10" r="3" fill="currentColor" />
        <circle cx="18" cy="-14" r="3" fill="currentColor" />
        <circle cx="-10" cy="16" r="3" fill="currentColor" />
        <circle cx="20" cy="14" r="3" fill="currentColor" />
        <circle cx="-28" cy="8" r="3" fill="currentColor" />
        <line x1="0" y1="0" x2="-16" y2="-10" stroke="currentColor" stroke-opacity="0.6" />
        <line x1="0" y1="0" x2="18" y2="-14" stroke="currentColor" stroke-opacity="0.6" />
        <line x1="0" y1="0" x2="-10" y2="16" stroke="currentColor" stroke-opacity="0.6" />
        <line x1="0" y1="0" x2="20" y2="14" stroke="currentColor" stroke-opacity="0.6" />
        <line x1="-16" y1="-10" x2="-28" y2="8" stroke="currentColor" stroke-opacity="0.4" />
        <line x1="18" y1="-14" x2="20" y2="14" stroke="currentColor" stroke-opacity="0.4" />
        <AnnotLabel x={0} y={66} anchor="middle">{d.neuron}</AnnotLabel>
        <AnnotLabel x={0} y={78} anchor="middle" size={8.5}>{d.neuronMeta}</AnnotLabel>
      </g>

      {/* connecting arrows */}
      <g stroke="currentColor" stroke-width="1.2" fill="none">
        <line x1="142" y1="150" x2="178" y2="140" />
        <polygon points="178,140 172,136 172,144" fill="currentColor" />
        <line x1="262" y1="140" x2="298" y2="140" />
        <polygon points="298,140 292,136 292,144" fill="currentColor" />
      </g>

      {/* curator loop — human feedback. Translated to 230 (was 260) so both
       * the "curator" label at y+76 and the "approves/rejects" sub at y+88
       * clear the quote separator line at abs y=340 — previously the sub-
       * label rendered at y=348 and collided with the quote block. */}
      <g transform="translate(220, 230)">
        <circle cx="20" cy="20" r="12" fill="none" stroke={DIAGRAM_RED} stroke-width="1.4" />
        <line
          x1="20"
          y1="36"
          x2="20"
          y2="60"
          stroke={DIAGRAM_RED}
          stroke-width="1.2"
          stroke-dasharray="3 3"
        />
        <polygon points="20,60 16,54 24,54" fill={DIAGRAM_RED} />
        <AnnotLabel x={20} y={76} anchor="middle">{d.curator}</AnnotLabel>
        <AnnotLabel x={20} y={88} anchor="middle" size={8.5}>{d.curatorMeta}</AnnotLabel>
      </g>

      {/* memex quote callout. `textLength` locks the Fraunces-italic string
       * to an exact pixel width regardless of font-loading timing, and the
       * separator line above it uses the same constant — so line and quote
       * always finish at the same x. Group translated to x=30 to centre the
       * 380px block inside the 440px viewBox ((440 - 380) / 2 = 30). */}
      <g transform="translate(30, 340)">
        <line x1="0" y1="0" x2="380" y2="0" stroke="currentColor" stroke-opacity="0.3" />
        <text
          x="0"
          y="22"
          font-family="Fraunces, Georgia, serif"
          font-style="italic"
          font-size="11.5"
          textLength="380"
          lengthAdjust="spacingAndGlyphs"
          fill="currentColor"
          fill-opacity="0.75"
        >
          {d.quote}
        </text>
        <AnnotLabel x={0} y={52}>{d.quoteAttrib}</AnnotLabel>
      </g>
    </svg>
  );
}

// ═══════════════ STEP 2 · CREATE KB ═══════════════
export function KbSchematic({
  name = '',
  slug = 'org-kb',
  d,
}: {
  name?: string;
  slug?: string;
  d: Diagrams['s2'];
}) {
  const w = 440;
  const h = 380;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
      <GridBg w={w} h={h} />
      <RegistrationMarks w={w} h={h} />

      {/* namespace container */}
      <g transform="translate(60, 60)">
        <rect width="320" height="240" fill="none" stroke="currentColor" stroke-width="1.4" />
        <line x1="0" y1="32" x2="320" y2="32" stroke="currentColor" stroke-width="1" />
        <text
          x="14"
          y="22"
          font-family="JetBrains Mono, monospace"
          font-size="11"
          letter-spacing="1"
          fill="currentColor"
        >
          /kb/{slug || '…'}
        </text>
        <AnnotLabel x={260} y={22} size={9}>{d.namespace}</AnnotLabel>

        {/* stored artifacts */}
        <g transform="translate(28, 60)">
          <rect width="84" height="60" fill="none" stroke="currentColor" />
          <AnnotLabel x={42} y={38} anchor="middle" size={9}>{d.sources}</AnnotLabel>
          <AnnotLabel x={42} y={76} anchor="middle" size={8.5}>{d.sourcesMeta}</AnnotLabel>
        </g>
        <g transform="translate(128, 60)">
          <polygon points="42,0 84,60 0,60" fill="none" stroke="currentColor" />
          <AnnotLabel x={42} y={40} anchor="middle" size={9}>{d.neuron}</AnnotLabel>
          <AnnotLabel x={42} y={76} anchor="middle" size={8.5}>{d.neuronMeta}</AnnotLabel>
        </g>
        <g transform="translate(228, 60)">
          <circle cx="42" cy="30" r="30" fill="none" stroke="currentColor" />
          <circle cx="42" cy="30" r="3" fill={DIAGRAM_ACCENT} />
          <AnnotLabel x={42} y={76} anchor="middle" size={8.5}>{d.queue}</AnnotLabel>
        </g>

        {/* bracket for kb name */}
        <g transform="translate(0, 170)">
          <line x1="14" y1="0" x2="306" y2="0" stroke="currentColor" stroke-opacity="0.35" />
          <line x1="14" y1="0" x2="14" y2="8" stroke="currentColor" stroke-opacity="0.35" />
          <line x1="306" y1="0" x2="306" y2="8" stroke="currentColor" stroke-opacity="0.35" />
          <text
            x="160"
            y="24"
            text-anchor="middle"
            font-family="Fraunces, Georgia, serif"
            font-size="15"
            fill="currentColor"
          >
            {name || d.untitled}
          </text>
          <AnnotLabel x={160} y={46} anchor="middle" size={9}>{d.displayName}</AnnotLabel>
        </g>
      </g>

      <AnnotLabel x={60} y={340}>{d.figLabel}</AnnotLabel>
      <AnnotLabel x={380} y={340} anchor="end">{d.storage}</AnnotLabel>
    </svg>
  );
}

// ═══════════════ STEP 3 · TEMPLATES ═══════════════
export function TemplateGlyph({ kind }: { kind: TemplateKey }) {
  const s = 22;
  if (kind === 'blank')
    return <rect x="4" y="4" width={s} height={s} fill="none" stroke="currentColor" stroke-width="1.3" />;
  if (kind === 'personal')
    return <circle cx="15" cy="15" r="11" fill="none" stroke="currentColor" stroke-width="1.3" />;
  if (kind === 'clinic')
    return (
      <g stroke="currentColor" stroke-width="1.3" fill="none">
        <rect x="4" y="4" width="22" height="22" />
        <line x1="15" y1="8" x2="15" y2="22" />
        <line x1="8" y1="15" x2="22" y2="15" />
      </g>
    );
  if (kind === 'engineering')
    return (
      <g stroke="currentColor" stroke-width="1.3" fill="none">
        <polygon points="15,4 26,24 4,24" />
        <circle cx="15" cy="18" r="3" fill={DIAGRAM_ACCENT} stroke="none" />
      </g>
    );
  if (kind === 'research')
    return (
      <g stroke="currentColor" stroke-width="1.3" fill="none">
        <circle cx="11" cy="15" r="7" />
        <circle cx="19" cy="15" r="7" />
      </g>
    );
  if (kind === 'legal')
    return (
      <g stroke="currentColor" stroke-width="1.3" fill="none">
        <line x1="15" y1="4" x2="15" y2="26" />
        <line x1="6" y1="10" x2="24" y2="10" />
        <circle cx="15" cy="18" r="5" />
      </g>
    );
  return null;
}

// ═══════════════ STEP 6 · LIVE INGEST (animated) ═══════════════
// Small source node on the left; neuron graph forming on the right.
export function IngestDiagram({ phase, d }: { phase: number; d: Diagrams['s6'] }) {
  // phase: 0 read → 1 extract → 2 compile → 3 link
  const w = 440;
  const h = 380;
  const neurons = [
    { id: 'N-01', x: 300, y: 120, r: 6, on: phase >= 1 },
    { id: 'N-02', x: 360, y: 170, r: 6, on: phase >= 1 },
    { id: 'N-03', x: 300, y: 220, r: 6, on: phase >= 2 },
    { id: 'N-04', x: 260, y: 170, r: 6, on: phase >= 2 },
    { id: 'N-05', x: 400, y: 240, r: 6, on: phase >= 3 },
    { id: 'N-06', x: 340, y: 280, r: 6, on: phase >= 3 },
  ];
  const edges: [number, number, number][] = [
    [0, 1, 1], [1, 2, 2], [0, 3, 2], [2, 3, 2],
    [1, 4, 3], [2, 5, 3], [4, 5, 3],
  ];
  const phaseKey = (['read', 'extract', 'compile', 'link'] as const)[phase];
  const phaseLabel = phaseKey ? d.phases[phaseKey] : '';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
      <GridBg w={w} h={h} />
      <RegistrationMarks w={w} h={h} />

      {/* source block */}
      <g transform="translate(50, 120)">
        <rect width="100" height="140" fill="none" stroke="currentColor" stroke-width="1.4" />
        <line x1="0" y1="26" x2="100" y2="26" stroke="currentColor" />
        <text
          x="10"
          y="18"
          font-family="JetBrains Mono, monospace"
          font-size="9"
          letter-spacing="1"
          fill="currentColor"
          fill-opacity="0.7"
        >
          {d.sourceFile}
        </text>
        {/* text lines */}
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <line
            key={i}
            x1="12"
            y1={42 + i * 10}
            x2={90 - (i % 3) * 10}
            y2={42 + i * 10}
            stroke="currentColor"
            stroke-opacity={phase >= 0 ? 0.15 + (i < phase * 3 ? 0.5 : 0) : 0.15}
            stroke-width="1"
          />
        ))}
        <AnnotLabel x={50} y={160} anchor="middle" size={9}>{d.rawBytes}</AnnotLabel>
      </g>

      {/* arrow line */}
      <g stroke="currentColor" fill="none">
        <line x1="150" y1="190" x2="230" y2="190" stroke-width="1.2" />
        <polygon points="230,190 224,186 224,194" fill="currentColor" />
        <text
          x="190"
          y="182"
          text-anchor="middle"
          font-family="JetBrains Mono, monospace"
          font-size="9"
          letter-spacing="1"
          fill="currentColor"
          fill-opacity="0.65"
          style={{ textTransform: 'uppercase' }}
        >
          {d.compile}
        </text>
      </g>

      {/* graph */}
      <g>
        {edges.map(([a, b, p], i) => {
          const na = neurons[a]!;
          const nb = neurons[b]!;
          return (
            <line
              key={i}
              x1={na.x}
              y1={na.y}
              x2={nb.x}
              y2={nb.y}
              stroke={DIAGRAM_ACCENT}
              stroke-opacity={phase >= p ? 0.85 : 0.12}
              stroke-width="1.1"
              style={{ transition: 'stroke-opacity 0.4s' }}
            />
          );
        })}
        {neurons.map((n, i) => (
          <g key={n.id} style={{ transition: 'opacity .4s', opacity: n.on ? 1 : 0.18 }}>
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={i === neurons.length - 1 && phase === 3 ? DIAGRAM_RED : 'currentColor'}
            />
            <text
              x={n.x + 10}
              y={n.y + 4}
              font-family="JetBrains Mono, monospace"
              font-size="8.5"
              letter-spacing="0.8"
              fill="currentColor"
              fill-opacity="0.6"
            >
              {n.id}
            </text>
          </g>
        ))}
      </g>

      <AnnotLabel x={50} y={340}>{d.figLabel}</AnnotLabel>
      <AnnotLabel x={380} y={340} anchor="end">
        {d.phaseTpl.replace('{phase}', String(phase + 1))}
      </AnnotLabel>

      <g transform="translate(50, 60)">
        <AnnotLabel x={0} y={0} size={9}>
          {phaseLabel}
        </AnnotLabel>
        <line x1="0" y1="6" x2="350" y2="6" stroke="currentColor" stroke-opacity="0.1" />
        <line
          x1="0"
          y1="6"
          x2={30 + phase * 106}
          y2="6"
          stroke={DIAGRAM_ACCENT}
          stroke-width="2"
          style={{ transition: 'all .4s' }}
        />
      </g>
    </svg>
  );
}

// ═══════════════ STEP 7 · CHAT DIAGRAM ═══════════════
export function ChatDiagram({ d }: { d: Diagrams['s7'] }) {
  const w = 440;
  const h = 380;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
      <GridBg w={w} h={h} />
      <RegistrationMarks w={w} h={h} />

      {/* query */}
      <g transform="translate(40, 80)">
        <circle cx="20" cy="20" r="20" fill="none" stroke="currentColor" stroke-width="1.4" />
        <circle cx="20" cy="20" r="3" fill={DIAGRAM_BLUE} />
        <AnnotLabel x={20} y={56} anchor="middle" size={9}>{d.query}</AnnotLabel>
      </g>

      {/* retriever (square) */}
      <g transform="translate(140, 80)">
        <rect width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4" />
        <line x1="0" y1="20" x2="40" y2="20" stroke="currentColor" stroke-opacity="0.3" />
        <line x1="20" y1="0" x2="20" y2="40" stroke="currentColor" stroke-opacity="0.3" />
        <AnnotLabel x={20} y={56} anchor="middle" size={9}>{d.fts5}</AnnotLabel>
      </g>

      {/* neurons triangle cluster */}
      <g transform="translate(240, 60)">
        <polygon points="40,0 80,70 0,70" fill="none" stroke="currentColor" stroke-width="1.4" />
        <circle cx="40" cy="22" r="3" fill={DIAGRAM_ACCENT} />
        <circle cx="24" cy="48" r="3" fill={DIAGRAM_ACCENT} />
        <circle cx="56" cy="48" r="3" fill={DIAGRAM_ACCENT} />
        <line x1="40" y1="22" x2="24" y2="48" stroke={DIAGRAM_ACCENT} stroke-width="1" />
        <line x1="40" y1="22" x2="56" y2="48" stroke={DIAGRAM_ACCENT} stroke-width="1" />
        <line x1="24" y1="48" x2="56" y2="48" stroke={DIAGRAM_ACCENT} stroke-width="1" />
        <AnnotLabel x={40} y={86} anchor="middle" size={9}>{d.neurons}</AnnotLabel>
      </g>

      {/* synthesis */}
      <g transform="translate(360, 80)">
        <rect x="0" y="0" width="40" height="40" fill="currentColor" />
        <AnnotLabel x={20} y={56} anchor="middle" size={9}>{d.answer}</AnnotLabel>
      </g>

      {/* flow arrows */}
      <g stroke="currentColor" stroke-width="1.2" fill="none">
        <line x1="82" y1="100" x2="138" y2="100" />
        <polygon points="138,100 132,96 132,104" fill="currentColor" />
        <line x1="182" y1="100" x2="238" y2="100" />
        <polygon points="238,100 232,96 232,104" fill="currentColor" />
        <line x1="322" y1="100" x2="358" y2="100" />
        <polygon points="358,100 352,96 352,104" fill="currentColor" />
      </g>

      {/* citations back — dashed */}
      <g stroke={DIAGRAM_ACCENT} stroke-width="1.2" fill="none" stroke-dasharray="3 3">
        <path d="M 360 140 Q 300 210 280 160" />
        <path d="M 360 140 Q 240 240 240 150" />
      </g>
      <AnnotLabel x={300} y={230} size={9}>{d.citations}</AnnotLabel>

      {/* footnote */}
      <AnnotLabel x={40} y={340}>{d.figLabel}</AnnotLabel>
      <AnnotLabel x={400} y={340} anchor="end">{d.provenance}</AnnotLabel>

      {/* big glyph */}
      <g transform="translate(150, 250)" opacity="0.9">
        <text
          x="0"
          y="20"
          font-family="Fraunces, Georgia, serif"
          font-style="italic"
          font-size="14"
          fill="currentColor"
          fill-opacity="0.7"
        >
          {d.motto}
        </text>
      </g>
    </svg>
  );
}

// ═══════════════ STEP 4 · SOURCES ═══════════════
export function SourcesDiagram({ count = 0, d }: { count?: number; d: Diagrams['s4'] }) {
  const w = 440;
  const h = 380;
  const tpl = count === 1 ? d.countOne : d.countMany;
  const countLabel = tpl
    .replace('{n}', String(count))
    .replace('{kb}', String(Math.max(0, count) * 14));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
      <GridBg w={w} h={h} />
      <RegistrationMarks w={w} h={h} />

      {/* source stack */}
      {[0, 1, 2, 3].map((i) => (
        <g
          key={i}
          transform={`translate(${60 + i * 14}, ${120 - i * 10})`}
          style={{ opacity: count > i ? 1 : 0.18, transition: 'opacity .3s' }}
        >
          <rect width="90" height="120" fill="var(--bg-card, #fff)" stroke="currentColor" stroke-width="1.2" />
          {[0, 1, 2, 3, 4, 5].map((li) => (
            <line
              key={li}
              x1="10"
              y1={18 + li * 12}
              x2={78 - (li % 2) * 10}
              y2={18 + li * 12}
              stroke="currentColor"
              stroke-opacity="0.35"
            />
          ))}
        </g>
      ))}
      <AnnotLabel x={110} y={280} anchor="middle">{countLabel}</AnnotLabel>

      {/* funnel */}
      <g transform="translate(240, 130)" stroke="currentColor" fill="none" stroke-width="1.2">
        <polygon points="0,0 100,0 70,60 30,60" />
        <line x1="30" y1="60" x2="30" y2="100" />
        <line x1="70" y1="60" x2="70" y2="100" />
        <line x1="30" y1="100" x2="70" y2="100" />
        <AnnotLabel x={50} y={120} anchor="middle" size={9}>{d.pipeline}</AnnotLabel>
      </g>

      {/* cooked output */}
      <g transform="translate(370, 140)">
        <circle
          cx="20"
          cy="20"
          r="20"
          fill={DIAGRAM_ACCENT}
          fill-opacity="0.15"
          stroke="currentColor"
          stroke-width="1.4"
        />
        <circle cx="20" cy="20" r="4" fill="currentColor" />
        <AnnotLabel x={20} y={60} anchor="middle" size={9}>{d.neurons}</AnnotLabel>
      </g>

      <AnnotLabel x={60} y={340}>{d.figLabel}</AnnotLabel>
      <AnnotLabel x={380} y={340} anchor="end">{d.media}</AnnotLabel>
    </svg>
  );
}

// ═══════════════ STEP 5 · TEAM ═══════════════
export function TeamDiagram({ members = 1, d }: { members?: number; d: Diagrams['s5'] }) {
  const w = 440;
  const h = 380;
  const seats: { x: number; y: number; shape: 'sq' | 'tri' | 'ci'; label: string }[] = [
    { x: 220, y: 100, shape: 'sq', label: d.admin },
    { x: 120, y: 220, shape: 'tri', label: d.curator },
    { x: 320, y: 220, shape: 'ci', label: d.curator },
    { x: 220, y: 280, shape: 'ci', label: d.reader },
  ];
  const memberLabel = (members === 1 ? d.memberOne : d.memberMany).replace('{n}', String(members));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
      <GridBg w={w} h={h} />
      <RegistrationMarks w={w} h={h} />

      {/* central KB */}
      <g transform="translate(220, 180)">
        <circle
          cx="0"
          cy="0"
          r="24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-dasharray="3 3"
        />
        <text
          x="0"
          y="4"
          text-anchor="middle"
          font-family="JetBrains Mono, monospace"
          font-size="9"
          letter-spacing="1"
          fill="currentColor"
          fill-opacity="0.7"
        >
          {d.kb}
        </text>
      </g>

      {seats.map((s, i) => (
        <g key={i} style={{ opacity: members > i ? 1 : 0.15, transition: 'opacity .25s' }}>
          <line x1={220} y1={180} x2={s.x} y2={s.y} stroke="currentColor" stroke-opacity="0.4" />
          <g transform={`translate(${s.x - 14}, ${s.y - 14})`}>
            {s.shape === 'sq' && (
              <rect width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" />
            )}
            {s.shape === 'ci' && (
              <circle cx="14" cy="14" r="14" fill="none" stroke="currentColor" stroke-width="1.4" />
            )}
            {s.shape === 'tri' && (
              <polygon points="14,0 28,28 0,28" fill="none" stroke="currentColor" stroke-width="1.4" />
            )}
          </g>
          <AnnotLabel x={s.x} y={s.y + 32} anchor="middle" size={9}>{s.label}</AnnotLabel>
        </g>
      ))}
      <AnnotLabel x={60} y={340}>{d.figLabel}</AnnotLabel>
      <AnnotLabel x={380} y={340} anchor="end">{memberLabel}</AnnotLabel>
    </svg>
  );
}
