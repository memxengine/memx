/**
 * Reference-counted body-scroll lock.
 *
 * Why: when two modals' lifecycles overlap (e.g. visionConfirm closes
 * AS jobProgressModal opens), the naive "capture prev overflow at lock,
 * restore at unlock" pattern leaks. Modal A opens → captures "" → sets
 * "hidden". Modal B opens AFTER A → captures "hidden" → sets "hidden".
 * Now A closes → restores prev = "" → body unlocked even though B is
 * still open. Same bug fires the other way: B opens during A → B
 * captures "hidden" → A closes → "" → B closes → restores "hidden",
 * leaving body locked with no modals on screen.
 *
 * Fix: shared counter. First lock stamps body=hidden, last unlock
 * restores. Any number of overlapping modals do the right thing
 * without per-component prev capture.
 */

let lockCount = 0;
let originalOverflow: string | null = null;

export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (lockCount === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = originalOverflow ?? '';
      originalOverflow = null;
    }
  };
}
