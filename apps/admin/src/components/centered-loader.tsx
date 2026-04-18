/**
 * CenteredLoader — full-area centered NeuronLoader + label.
 *
 * For whole-panel or whole-app loading states where the old tiny
 * "Henter…" text looked like the app had stalled. Uses the same
 * 400ms fade-in delay as `.loading-delayed` so fast loads don't
 * flash it. Neurons pulse, synapses draw in — same language as the
 * auto-link button animation, scaled up.
 */
import { NeuronLoader } from './neuron-loader';
import { t } from '../lib/i18n';

interface Props {
  /** Optional override for the label below the animation. Defaults to common.loading. */
  label?: string;
  /** Pixel size of the loader. Defaults to 320px — hero size, commands the screen. */
  size?: number;
}

export function CenteredLoader({ label, size = 320 }: Props) {
  // gap-16 (64px) clears the pulse ring at peak scale 1.1 which
  // extends ~47px below the SVG's layout box at size=320. Without
  // this the label overlaps the ring stroke.
  return (
    <div class="loading-delayed flex flex-col items-center justify-center gap-16 min-h-[60vh] text-[color:var(--color-fg-muted)]">
      <NeuronLoader size={size} />
      <span class="text-sm tracking-wide">{label ?? t('common.loading')}</span>
    </div>
  );
}
