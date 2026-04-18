/**
 * /play — internal component sandbox.
 *
 * One panel, many showcases. Drop new components in as separate
 * <Section> blocks when we want to preview them in isolation without
 * wiring them into a real data path. Not linked from the nav on
 * purpose — type the URL directly (`/play`) when you need it.
 */
import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { NeuronLoader } from '../components/neuron-loader';
import { CenteredLoader } from '../components/centered-loader';
import { ChatThinkingAnimation } from '../components/chat-thinking-animation';

type Section = { id: string; title: string; blurb: string; render: () => VNode };

const SECTIONS: Section[] = [
  {
    id: 'neuron-loader-sizes',
    title: 'NeuronLoader — sizes',
    blurb: 'The same animation rendered at every size we use in the app.',
    render: () => (
      <div class="flex items-end flex-wrap gap-10">
        {[16, 24, 32, 48, 80, 120, 200, 320].map((size) => (
          <div key={size} class="flex flex-col items-center gap-3">
            <NeuronLoader size={size} />
            <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
              {size}px
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    id: 'neuron-loader-with-label',
    title: 'NeuronLoader — with label',
    blurb:
      'How it appears in a button (left: inside a primary button; right: inside a bordered secondary button). Button text colour inherits via currentColor.',
    render: () => (
      <div class="flex items-center gap-4">
        <button class="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-fg)] text-[color:var(--color-bg)] font-medium">
          <NeuronLoader size={32} label="Auto-link kilder…" />
        </button>
        <button class="px-3 py-1.5 text-sm rounded-md border border-[color:var(--color-border-strong)] text-[color:var(--color-fg)]">
          <NeuronLoader size={32} label="Auto-link kilder…" />
        </button>
      </div>
    ),
  },
  {
    id: 'neuron-loader-chrome',
    title: 'NeuronLoader — on accent + muted backgrounds',
    blurb:
      'Stress-test contrast. The animation uses currentColor so the surrounding text colour drives it.',
    render: () => (
      <div class="flex flex-wrap gap-4">
        <div class="px-6 py-8 rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-border)] flex items-center gap-3 text-[color:var(--color-fg)]">
          <NeuronLoader size={64} />
          <span>on page bg</span>
        </div>
        <div class="px-6 py-8 rounded-md bg-[color:var(--color-accent)]/20 border border-[color:var(--color-accent)]/40 flex items-center gap-3 text-[color:var(--color-accent)]">
          <NeuronLoader size={64} />
          <span>on accent tint</span>
        </div>
        <div class="px-6 py-8 rounded-md bg-[color:var(--color-fg)] flex items-center gap-3 text-[color:var(--color-bg)]">
          <NeuronLoader size={64} />
          <span>on inverted bg</span>
        </div>
        <div class="px-6 py-8 rounded-md bg-[color:var(--color-success)]/25 border border-[color:var(--color-success)]/60 flex items-center gap-3 text-[color:var(--color-success)]">
          <NeuronLoader size={64} />
          <span>on success tint</span>
        </div>
      </div>
    ),
  },
  {
    id: 'centered-loader',
    title: 'CenteredLoader — full-panel loading state',
    blurb:
      'What KbsPanel (/) renders while listKnowledgeBases() is pending. 400ms fade-in so fast loads don\'t flash.',
    render: () => (
      <div class="rounded-md border border-[color:var(--color-border)] overflow-hidden">
        <CenteredLoader />
      </div>
    ),
  },
  {
    id: 'neuron-loader-hero',
    title: 'NeuronLoader — hero size (320px)',
    blurb: 'Centered, standalone, accent-coloured. Useful as a splash while a long LLM call is in flight.',
    render: () => (
      <div class="flex items-center justify-center py-8 text-[color:var(--color-accent)]">
        <NeuronLoader size={320} />
      </div>
    ),
  },
  {
    id: 'cms-vs-neuron',
    title: 'CMS ChatThinkingAnimation vs NeuronLoader',
    blurb:
      'Side-by-side at matching sizes. Left: cms-core\'s orbiting-dots-in-pulse-ring, ported to use trail accent colour. Right: our Neuron graph with asynchronous firings. Compare visual language, cadence, and screen presence.',
    render: () => (
      <div class="flex flex-col gap-12">
        <div>
          <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-3">
            Original reference size — 28px (cms) · 32px (trail button)
          </div>
          <div class="flex items-center gap-12 flex-wrap">
            <div class="flex flex-col items-center gap-3">
              <ChatThinkingAnimation size={28} />
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">cms · 28px</span>
            </div>
            <div class="flex flex-col items-center gap-3">
              <NeuronLoader size={32} />
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">trail · 32px</span>
            </div>
          </div>
        </div>

        <div>
          <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-3">
            Matched at 128px
          </div>
          <div class="flex items-center gap-16 flex-wrap">
            <div class="flex flex-col items-center gap-3">
              <ChatThinkingAnimation size={128} />
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">cms</span>
            </div>
            <div class="flex flex-col items-center gap-3">
              <NeuronLoader size={128} />
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">trail</span>
            </div>
          </div>
        </div>

        <div>
          <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-3">
            Hero size — 320px
          </div>
          <div class="flex items-center gap-16 flex-wrap justify-center">
            <div class="flex flex-col items-center gap-4">
              <ChatThinkingAnimation size={320} />
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">cms</span>
            </div>
            <div class="flex flex-col items-center gap-4">
              <NeuronLoader size={320} />
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">trail</span>
            </div>
          </div>
        </div>

        <div>
          <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-3">
            CMS version with label + elapsed counter (cms-style usage)
          </div>
          <div class="flex items-center">
            <ChatThinkingAnimation size={28} label="Compiling Neurons…" startTime={Date.now()} />
          </div>
        </div>
      </div>
    ),
  },
];

export function PlayPanel() {
  const [active, setActive] = useState<string>(SECTIONS[0]!.id);
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]!;

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Play</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          Component sandbox — iterate on visual components without wiring them into live data.
          Not linked from the nav; type <code class="px-1 py-0.5 rounded bg-[color:var(--color-bg)] font-mono text-xs">/play</code> to reach it.
        </p>
      </header>

      <nav class="flex flex-wrap gap-1 mb-6 border-b border-[color:var(--color-border)]">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            class={
              'px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
              (active === s.id
                ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
            }
          >
            {s.title.split(' — ')[0]}
          </button>
        ))}
      </nav>

      <section class="space-y-4">
        <div>
          <h2 class="text-lg font-semibold">{section.title}</h2>
          <p class="text-sm text-[color:var(--color-fg-muted)] max-w-2xl">{section.blurb}</p>
        </div>
        <div class="pt-4">{section.render()}</div>
      </section>
    </div>
  );
}
