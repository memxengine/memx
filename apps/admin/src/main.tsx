import { render } from 'preact';
import { LocationProvider, Router, Route } from 'preact-iso';
import { App } from './app';
import { QueuePanel } from './panels/queue';
import { KnowledgeBasesPanel } from './panels/kbs';
import { NotFound } from './panels/not-found';
import { initTheme } from './theme';
import './index.css';

// Apply persisted theme before first paint so we never flash the wrong palette.
initTheme();

function Main() {
  return (
    <LocationProvider>
      <App>
        <Router>
          <Route path="/" component={KnowledgeBasesPanel} />
          <Route path="/kb/:kbId/queue" component={QueuePanel} />
          <Route default component={NotFound} />
        </Router>
      </App>
    </LocationProvider>
  );
}

render(<Main />, document.getElementById('app')!);
