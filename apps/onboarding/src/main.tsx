import { render } from 'preact';
import { App } from './app';
import './styles.css';

// Vite's HMR chain can re-run this module when any transitive import changes
// (CSS included). Preact's render() diffs, but on repeated module re-execution
// Vite's cache can hand us a fresh Preact instance whose vnode tree doesn't
// share identity with the one already mounted — the result is a second tree
// appended under the first instead of an in-place update. Clearing any
// leftover children before rendering makes the mount idempotent regardless
// of how many times this module is evaluated.
const root = document.getElementById('app');
if (root) {
  while (root.firstChild) root.removeChild(root.firstChild);
  render(<App />, root);
}

// Mark this module as HMR-accepting so Vite performs an in-place module swap
// instead of a full-chain re-run; combined with the clear above, stale trees
// never stack up in dev.
if (import.meta.hot) {
  import.meta.hot.accept();
}
