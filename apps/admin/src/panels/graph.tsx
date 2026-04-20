/**
 * F99 — Neuron Graph panel.
 *
 * Full-trail pan/zoom graph view rendered by Sigma.js over a
 * graphology data model. v1 runs force-layout client-side (FA2's
 * synchronous `assign()` — fine at Sanne-scale); the compile-time
 * layout path + incremental updates are F99 follow-up work.
 *
 * Click a node → deep-link to the reader. Hover → tooltip. Search
 * box dims non-matching nodes via Sigma's nodeReducer so typing
 * stays smooth at large N.
 *
 * Admin is Preact + dark-only. Node colours come from CSS variables
 * so the graph tracks theme changes without re-render.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import Sigma from 'sigma';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import {
  fetchGraph,
  ApiError,
  type GraphNode,
  type GraphEdge,
  type GraphEdgeType,
} from '../api';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';

interface CameraState {
  x: number;
  y: number;
  ratio: number;
  angle: number;
}

/**
 * Per-(kbId) camera state persisted in sessionStorage so a round-trip
 * through a reader page returns to the same zoom/pan. Tab close / hard
 * navigate clears it; normal back-button works seamlessly.
 */
function cameraKey(kbId: string): string {
  return `trail.admin.graph-camera.${kbId}`;
}
function saveCamera(kbId: string, cam: CameraState): void {
  try {
    sessionStorage.setItem(cameraKey(kbId), JSON.stringify(cam));
  } catch {
    // sessionStorage disabled (safari private mode) — fall through.
  }
}
function loadCamera(kbId: string): CameraState | null {
  try {
    const raw = sessionStorage.getItem(cameraKey(kbId));
    if (!raw) return null;
    const cam = JSON.parse(raw) as CameraState;
    if (typeof cam.x !== 'number' || typeof cam.y !== 'number') return null;
    return cam;
  } catch {
    return null;
  }
}

interface HoverState {
  x: number;
  y: number;
  node: GraphNode;
}

type NodeCategory = 'neuron' | 'orphan' | 'hub';

function categoryOf(node: GraphNode): NodeCategory {
  if (node.hub) return 'hub';
  if (node.orphan) return 'orphan';
  return 'neuron';
}

/**
 * F137 — palette for typed edges. Edges inherit `cites` (the default)
 * when `edgeType` is null or unknown, so the palette key set is also
 * the set of visual distinctions we make:
 *
 *   cites        → quiet neutral grey (matches pre-F137 look)
 *   is-a         → violet (taxonomic, leans hub-family)
 *   part-of      → teal (compositional)
 *   contradicts  → red (attention)
 *   supersedes   → orange (replacement)
 *   example-of   → green (instantiation)
 *   caused-by    → amber (provenance)
 *
 * Alpha is baked in (~35-60%) so edges remain visually secondary to
 * nodes at any reasonable zoom. Sigma's default thin stroke + the
 * type-specific colour carry the semantic.
 */
const EDGE_TYPE_PALETTE: Record<GraphEdgeType, string> = {
  'cites': 'rgba(140,140,150,0.35)',
  'is-a': 'rgba(167,139,250,0.55)',       // violet
  'part-of': 'rgba(20,184,166,0.55)',     // teal
  'contradicts': 'rgba(239,68,68,0.65)',  // red
  'supersedes': 'rgba(251,146,60,0.6)',   // orange
  'example-of': 'rgba(74,222,128,0.55)',  // green
  'caused-by': 'rgba(245,158,11,0.55)',   // amber
};

const EDGE_TYPE_KEYS: GraphEdgeType[] = [
  'cites',
  'is-a',
  'part-of',
  'contradicts',
  'supersedes',
  'example-of',
  'caused-by',
];

function edgeTypeOf(e: GraphEdge): GraphEdgeType {
  if (!e.edgeType) return 'cites';
  return (EDGE_TYPE_PALETTE[e.edgeType as GraphEdgeType] ? e.edgeType : 'cites') as GraphEdgeType;
}

export function GraphPanel() {
  const routeInfo = useRoute();
  const { route } = useLocation();
  const kbId = routeInfo.params.kbId ?? '';
  useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);
  const [search, setSearch] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);
  // Legend-chip-driven category filter. Default = all three active,
  // so the graph renders the same as pre-filter until the user
  // clicks a chip. Clicking a chip toggles its category; clicking
  // every chip off resets to all-on so the view never goes empty.
  const [activeCats, setActiveCats] = useState<Set<NodeCategory>>(
    () => new Set<NodeCategory>(['neuron', 'orphan', 'hub']),
  );
  // F137 — edge-type filter. Same toggle semantics as node categories.
  // Default = all seven types visible; clicking the last one re-enables
  // everything so the graph never goes edge-less.
  const [activeEdgeTypes, setActiveEdgeTypes] = useState<Set<GraphEdgeType>>(
    () => new Set<GraphEdgeType>(EDGE_TYPE_KEYS),
  );
  const nodeLookup = useRef<Map<string, GraphNode>>(new Map());
  const edgeTypeLookup = useRef<Map<string, GraphEdgeType>>(new Map());
  // Mirror the active-cats + search state into refs so the Sigma
  // nodeReducer closure reads the latest values on every refresh.
  // Without this, the reducer captures the initial state at Sigma-
  // construction time and chip clicks have no effect.
  const activeCatsRef = useRef(activeCats);
  activeCatsRef.current = activeCats;
  const activeEdgeTypesRef = useRef(activeEdgeTypes);
  activeEdgeTypesRef.current = activeEdgeTypes;
  const searchRef = useRef('');

  const searchLower = search.trim().toLowerCase();
  searchRef.current = searchLower;

  function toggleCat(cat: NodeCategory): void {
    setActiveCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
        if (next.size === 0) {
          return new Set<NodeCategory>(['neuron', 'orphan', 'hub']);
        }
      } else {
        next.add(cat);
      }
      return next;
    });
  }

  function toggleEdgeType(type: GraphEdgeType): void {
    setActiveEdgeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
        if (next.size === 0) return new Set<GraphEdgeType>(EDGE_TYPE_KEYS);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  // Style tokens pulled out of the DOM once per mount so Sigma's
  // renderer doesn't recompute every frame. `label` + `labelShadow`
  // track the foreground tokens so text on the canvas stays legible
  // in both themes — Sigma's own default (#000) is invisible on dark.
  const colours = useMemo(() => {
    if (typeof window === 'undefined') {
      return {
        accent: '#E8A87C',
        orphan: '#22d3ee',
        hub: '#a78bfa',
        edge: 'rgba(140,140,150,0.35)',
        label: '#e4e4e7',
      };
    }
    const style = getComputedStyle(document.documentElement);
    // Token choices:
    //  - `orphan` (cyan) + `hub` (violet) are hardcoded, NOT theme
    //    tokens. trail's whole palette is warm (accent peach, danger
    //    burnt-orange, warning amber) so every semantic token
    //    collides with the accent hue. Cyan is the complementary pole
    //    for orphan; violet is a third distinct hue for structural
    //    hub Neurons (overview, log, glossary).
    //  - `edge` uses a neutral-grey with low alpha (not `--color-fg-
    //    subtle`, which reads fine as text but FAR too bright when
    //    multiplied across 138 lines). Hairline width (size 0.5 on the
    //    edges) handles the rest.
    return {
      accent: style.getPropertyValue('--color-accent').trim() || '#E8A87C',
      orphan: '#22d3ee',
      hub: '#a78bfa',
      edge: 'rgba(140,140,150,0.35)',
      label: style.getPropertyValue('--color-fg').trim() || '#e4e4e7',
    };
  }, []);

  useEffect(() => {
    if (!kbId || !containerRef.current) return;

    let cancelled = false;
    const container = containerRef.current;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchGraph(kbId);
        if (cancelled) return;

        const graph = new Graph({ type: 'undirected', multi: false });
        nodeLookup.current.clear();

        // Pre-identify edge-less hubs. We place them AFTER FA2 runs so
        // their coordinates match the actual post-iteration scale (FA2
        // produces arbitrary ranges like -200..200; hardcoding 0..1
        // pins collapses to a single pixel once Sigma autofits).
        const connectedIds = new Set<string>();
        for (const e of data.edges) {
          connectedIds.add(e.source);
          connectedIds.add(e.target);
        }
        const orphanHubIds = data.nodes
          .filter((n) => n.hub && !connectedIds.has(n.id))
          .map((n) => n.id);

        for (const n of data.nodes) {
          nodeLookup.current.set(n.id, n);
          const color = n.hub
            ? colours.hub
            : n.orphan
              ? colours.orphan
              : colours.accent;
          // F141 — scale UP from baseline using usage weight. We pick
          // `1 + w*0.8` (range [1.0, 1.8]) not trail-optimizer's
          // suggested `0.5 + w*1.5` because w=0 means "unknown" not
          // "cold" (rollup hasn't fired for new KBs), and shrinking
          // unknown nodes would mislead curators into thinking the
          // engine labelled them low-value when we just have no data
          // yet. Hot nodes (w=1) render 80% bigger than baseline —
          // visible at a glance without drowning the graph layout.
          const scaledSize = n.size * (1 + (n.usageWeight ?? 0) * 0.8);
          graph.addNode(n.id, {
            label: n.label,
            size: scaledSize,
            color,
            // Seed positions randomly; FA2 settles them (edge-less hubs
            // will be overridden to bbox-top after FA2 below).
            x: n.x ?? Math.random(),
            y: n.y ?? Math.random(),
          });
        }
        edgeTypeLookup.current.clear();
        for (const e of data.edges) {
          // Sigma refuses duplicate undirected edges between the same
          // endpoints; filter defensively to match the DB-side de-dup.
          if (graph.hasEdge(e.source, e.target)) continue;
          const type = edgeTypeOf(e);
          // F137 — colour per edge-type from the palette. Hairline width
          // (0.5) still applies — the colour carries the semantic, not
          // the stroke weight. A subsequent interactive pass could
          // dashify 'contradicts' / 'supersedes' via a custom edge
          // program if distinction needs more lift.
          const edgeKey = graph.addEdge(e.source, e.target, {
            color: EDGE_TYPE_PALETTE[type],
            size: 0.5,
          });
          edgeTypeLookup.current.set(edgeKey, type);
        }

        // Only run FA2 when we have edges — a disconnected cluster of
        // islands just spreads nodes randomly across the viewport,
        // which looks worse than the random-seed grid we start with.
        if (graph.order > 1 && graph.size > 0) {
          forceAtlas2.assign(graph, {
            iterations: Math.min(500, 50 + graph.order * 2),
            settings: {
              gravity: 1,
              scalingRatio: 10,
              slowDown: 2,
              barnesHutOptimize: graph.order > 1000,
            },
          });
        }

        // Post-FA2 bbox of the connected cluster — we park edge-less
        // hubs above its top edge, spaced across its width. Hardcoding
        // world-coords doesn't work: FA2 produces arbitrary ranges
        // (-200..200 or similar) and Sigma autofits to whatever the
        // whole graph spans, so pin positions have to live in the
        // same coordinate frame.
        if (orphanHubIds.length > 0) {
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          graph.forEachNode((id, attrs) => {
            if (orphanHubIds.includes(id)) return;
            if (typeof attrs.x === 'number' && typeof attrs.y === 'number') {
              if (attrs.x < minX) minX = attrs.x;
              if (attrs.x > maxX) maxX = attrs.x;
              if (attrs.y < minY) minY = attrs.y;
            }
          });
          if (Number.isFinite(minX) && Number.isFinite(maxX)) {
            const width = Math.max(1, maxX - minX);
            // Park hubs one "half-cluster-width" ABOVE the top of the
            // cluster. That gives a clear gap plus leaves room for
            // labels to render without colliding with cluster nodes.
            const hubY = minY - width * 0.15;
            const total = orphanHubIds.length;
            orphanHubIds.forEach((id, i) => {
              // Spread across 70% of the cluster width, centred.
              const t = total === 1 ? 0.5 : i / (total - 1);
              const hubX = minX + width * (0.15 + 0.7 * t);
              graph.setNodeAttribute(id, 'x', hubX);
              graph.setNodeAttribute(id, 'y', hubY);
            });
          }
        }

        graphRef.current = graph;
        const renderer = new Sigma(graph, container, {
          renderEdgeLabels: false,
          defaultEdgeColor: colours.edge,
          defaultEdgeType: 'line',
          labelColor: { color: colours.label },
          labelWeight: '500',
          labelSize: 12,
          labelFont: 'var(--font-ui, system-ui)',
          labelDensity: 1,
          // Suppress Sigma's default hover-highlight (it draws a white
          // backdrop box behind the hovered node's label). Our own
          // floating tooltip covers that job; the backdrop box just
          // adds visual noise on a dense graph.
          defaultDrawNodeHover: () => {},
          nodeReducer: (nodeId, attrs) => {
            const node = nodeLookup.current.get(nodeId);
            if (!node) return attrs;
            // Read latest state via refs — otherwise the closure
            // captures the mount-time values and every refresh uses
            // stale filters.
            const cats = activeCatsRef.current;
            const q = searchRef.current;
            const catActive = cats.has(categoryOf(node));
            const searchMatch =
              !q ||
              node.label.toLowerCase().includes(q) ||
              node.tags.some((tag) => tag.toLowerCase().includes(q));
            if (catActive && searchMatch) return attrs;
            // Hide the node entirely (plus its label and any attached
            // edges via the edgeReducer below). Position stays fixed
            // so the visible cluster doesn't reflow when chips toggle.
            return { ...attrs, hidden: true };
          },
          edgeReducer: (edgeId, attrs) => {
            // Hide an edge whenever either of its endpoints is
            // node-filtered, OR when the edge's type is chip-filtered
            // out (F137). `graph` is the local graphology instance
            // from the surrounding closure — it's fully built before
            // Sigma starts calling these reducers.
            const edgeType = edgeTypeLookup.current.get(edgeId) ?? 'cites';
            const activeTypes = activeEdgeTypesRef.current;
            if (!activeTypes.has(edgeType)) {
              return { ...attrs, hidden: true };
            }
            const [src, tgt] = graph.extremities(edgeId);
            const cats = activeCatsRef.current;
            const q = searchRef.current;
            const shouldHide = (id: string): boolean => {
              const n = nodeLookup.current.get(id);
              if (!n) return false;
              const catActive = cats.has(categoryOf(n));
              const searchMatch =
                !q ||
                n.label.toLowerCase().includes(q) ||
                n.tags.some((tag) => tag.toLowerCase().includes(q));
              return !(catActive && searchMatch);
            };
            if (shouldHide(src) || shouldHide(tgt)) {
              return { ...attrs, hidden: true };
            }
            return attrs;
          },
        });

        // F99 — camera state: restore from a previous visit, or
        // centre-fit on first load. Sigma's default camera is
        // {x:0.5, y:0.5, ratio:1} which IS centred but leaves nodes
        // touching the viewport edge when the FA2 layout spreads to
        // the corners. ratio=1.15 gives a breath of padding so labels
        // don't get clipped at the frame.
        const camera = renderer.getCamera();
        const savedCamera = loadCamera(kbId);
        if (savedCamera) {
          camera.setState(savedCamera);
        } else {
          camera.setState({ x: 0.5, y: 0.5, ratio: 1.15, angle: 0 });
        }

        renderer.on('clickNode', ({ node }) => {
          const n = nodeLookup.current.get(node);
          if (!n) return;
          // Save camera BEFORE the navigation so back-button returns
          // to the same zoom/pan. Reading via getState() is O(1).
          saveCamera(kbId, renderer.getCamera().getState());
          const slug = n.filename.replace(/\.md$/i, '');
          route(`/kb/${kbId}/neurons/${encodeURIComponent(slug)}`);
        });
        renderer.on('enterNode', ({ node, event }) => {
          const n = nodeLookup.current.get(node);
          if (!n) return;
          setHover({ x: event.x, y: event.y, node: n });
        });
        renderer.on('leaveNode', () => setHover(null));
        renderer.on('downStage', () => setHover(null));

        sigmaRef.current = renderer;
        setNodeCount(data.nodes.length);
        setEdgeCount(data.edges.length);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      // Persist camera one last time on unmount — covers the path
      // where the user navigates via nav-tab click or browser back
      // instead of clicking a node. getCamera() may throw after kill
      // so capture it first.
      try {
        const cam = sigmaRef.current?.getCamera().getState();
        if (cam) saveCamera(kbId, cam as CameraState);
      } catch {
        // renderer already torn down
      }
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [kbId, colours.accent, colours.orphan, colours.edge]);

  // Re-run the node reducer whenever search or active-categories
  // change — Sigma exposes `refresh()` which re-evaluates the reducer
  // without re-laying-out. Refs are updated synchronously above so
  // the reducer sees the fresh values when this effect triggers the
  // redraw.
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [searchLower, activeCats, activeEdgeTypes]);

  // IMPORTANT: the container div MUST render on every path (even while
  // loading or in error/empty states) so `containerRef.current` is
  // populated by the time the useEffect runs. Rendering <CenteredLoader/>
  // *instead of* the container on first render leaves the ref null, the
  // effect returns early, and loading never clears. Learned the hard way.
  const showEmpty = !loading && !error && nodeCount < 2;

  return (
    <div class="relative w-full h-[calc(100vh-140px)] -mx-6 -mb-6">
      <div
        ref={containerRef}
        class={`absolute inset-0 ${showEmpty ? 'opacity-0 pointer-events-none' : ''}`}
      />

      {loading ? (
        <div class="absolute inset-0 flex items-center justify-center bg-[color:var(--color-bg)]/60 z-30 pointer-events-none">
          <CenteredLoader />
        </div>
      ) : null}

      {error ? (
        <div class="absolute inset-0 flex items-center justify-center p-8 bg-[color:var(--color-bg)]/90 z-30">
          <div class="text-center text-[color:var(--color-danger)] max-w-md">
            <p class="font-medium mb-2">{t('common.error')}</p>
            <p class="text-sm font-mono break-words">{error}</p>
          </div>
        </div>
      ) : null}

      {showEmpty ? (
        <div class="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
          <h2 class="text-lg font-medium mb-2">{t('graph.emptyTitle')}</h2>
          <p class="text-sm text-[color:var(--color-fg-muted)] max-w-md mb-4">
            {t('graph.emptyBody')}
          </p>
          <a
            href={`/kb/${kbId}/queue`}
            class="text-sm px-4 py-2 rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] transition"
          >
            {t('graph.emptyCta')}
          </a>
        </div>
      ) : null}

      {/* Top-right floating search + meta panel */}
      <div class="absolute top-4 right-4 flex flex-col gap-2 z-10">
        <div class="bg-[color:var(--color-bg-card)]/95 backdrop-blur-sm border border-[color:var(--color-border)] rounded-md p-3 shadow-lg min-w-[240px]">
          <input
            type="text"
            value={search}
            placeholder={t('graph.searchPlaceholder')}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            class="w-full text-sm bg-[color:var(--color-bg)] border border-[color:var(--color-border)] rounded px-2 py-1.5 focus:outline-none focus:border-[color:var(--color-accent)]"
          />
          <div class="mt-2 text-[11px] font-mono text-[color:var(--color-fg-subtle)] flex items-center justify-between">
            <span>
              {nodeCount} {t('graph.nodeCountLabel')} · {edgeCount} {t('graph.edgeCountLabel')}
            </span>
          </div>
          <div class="mt-2 pt-2 border-t border-[color:var(--color-border)] flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] font-mono">
            {(
              [
                { cat: 'neuron', color: colours.accent, label: t('graph.legendNeuron') },
                { cat: 'orphan', color: colours.orphan, label: t('graph.legendOrphan') },
                { cat: 'hub', color: colours.hub, label: t('graph.legendHub') },
              ] as const
            ).map(({ cat, color, label }) => {
              const active = activeCats.has(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCat(cat)}
                  class={
                    'inline-flex items-center gap-1.5 transition ' +
                    (active
                      ? 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
                      : 'text-[color:var(--color-fg-subtle)] line-through opacity-50 hover:opacity-80')
                  }
                  title={t('graph.legendToggleHint')}
                >
                  <span
                    class="inline-block w-2.5 h-2.5 rounded-full transition"
                    style={{ background: color, opacity: active ? 1 : 0.3 }}
                  />
                  {label}
                </button>
              );
            })}
          </div>
          {/* F137 — edge-type legend + filter. Separate row so the
              seven-type vocabulary doesn't crowd the node-category
              chips. Clicking toggles visibility for that type (via
              edgeReducer). */}
          <div class="mt-2 pt-2 border-t border-[color:var(--color-border)] flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] font-mono">
            {EDGE_TYPE_KEYS.map((type) => {
              const active = activeEdgeTypes.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleEdgeType(type)}
                  class={
                    'inline-flex items-center gap-1 transition ' +
                    (active
                      ? 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
                      : 'text-[color:var(--color-fg-subtle)] line-through opacity-50 hover:opacity-80')
                  }
                  title={t('graph.edgeTypeToggleHint')}
                >
                  <span
                    class="inline-block w-3 h-[2px] rounded-full transition"
                    style={{ background: EDGE_TYPE_PALETTE[type], opacity: active ? 1 : 0.3 }}
                  />
                  {t(`graph.edgeType.${type}` as never)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {hover ? (
        <div
          class="absolute pointer-events-none z-20 bg-[color:var(--color-bg-card)]/95 backdrop-blur-sm border border-[color:var(--color-border)] rounded-md px-3 py-2 shadow-lg text-xs max-w-[340px]"
          style={{
            left: `${Math.min(hover.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 360)}px`,
            top: `${hover.y + 12}px`,
          }}
        >
          <div class="font-medium truncate">{hover.node.label}</div>
          <div class="font-mono text-[10px] text-[color:var(--color-fg-subtle)] truncate mt-0.5">
            {hover.node.filename}
          </div>
          {hover.node.excerpt ? (
            <div class="mt-1.5 text-[11px] text-[color:var(--color-fg-muted)] leading-snug line-clamp-4">
              {hover.node.excerpt}
            </div>
          ) : null}
          <div class="font-mono text-[10px] text-[color:var(--color-fg-muted)] mt-1.5">
            {hover.node.backlinks} {t('graph.backlinkLabel')}
            {hover.node.hub
              ? ` · ${t('graph.hubLabel')}`
              : hover.node.orphan
                ? ` · ${t('graph.orphanLabel')}`
                : ''}
          </div>
          {hover.node.tags.length > 0 ? (
            <div class="mt-1.5 flex flex-wrap gap-1">
              {hover.node.tags.slice(0, 6).map((tag) => (
                <span
                  key={tag}
                  class="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
