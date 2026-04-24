import { render } from 'preact';
import { LocationProvider, Router, Route } from 'preact-iso';
import { App } from './app';
import { QueuePanel } from './panels/queue';
import { KnowledgeBasesPanel } from './panels/kbs';
import { WikiTreePanel } from './panels/wiki-tree';
import { WikiReaderPanel } from './panels/wiki-reader';
import { SourcesPanel } from './panels/sources';
import { SearchPanel } from './panels/search';
import { ChatPanel } from './panels/chat';
import { GlossaryPanel } from './panels/glossary';
import { GraphPanel } from './panels/graph';
import { WorkPanel } from './panels/work';
import { PlayPanel } from './panels/play';
import { SettingsTrailPanel } from './panels/settings-trail';
import { SettingsAccountPanel } from './panels/settings-account';
import { CostPanel } from './panels/cost';
import { QualityComparePanel } from './panels/quality-compare';
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
          <Route path="/kb/:kbId/neurons" component={WikiTreePanel} />
          <Route path="/kb/:kbId/neurons/:slug" component={WikiReaderPanel} />
          <Route path="/kb/:kbId/graph" component={GraphPanel} />
          <Route path="/kb/:kbId/work" component={WorkPanel} />
          <Route path="/kb/:kbId/sources" component={SourcesPanel} />
          <Route path="/kb/:kbId/sources/:sourceId/compare" component={QualityComparePanel} />
          <Route path="/kb/:kbId/search" component={SearchPanel} />
          <Route path="/kb/:kbId/chat" component={ChatPanel} />
          <Route path="/kb/:kbId/cost" component={CostPanel} />
          <Route path="/kb/:kbId/settings" component={SettingsTrailPanel} />
          <Route path="/settings" component={SettingsAccountPanel} />
          <Route path="/glossary" component={GlossaryPanel} />
          <Route path="/play" component={PlayPanel} />
          <Route default component={NotFound} />
        </Router>
      </App>
    </LocationProvider>
  );
}

render(<Main />, document.getElementById('app')!);
