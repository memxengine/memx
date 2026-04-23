import { render } from 'preact';
import { LocationProvider, Router, Route } from 'preact-iso';
import { App } from './app';
import { DashboardPanel } from './panels/dashboard';
import { RunDetailPanel } from './panels/run-detail';
import { ComparePanel } from './panels/compare';
import { NewRunPanel } from './panels/new-run';
import './index.css';

function Main() {
  return (
    <LocationProvider>
      <App>
        <Router>
          <Route path="/" component={DashboardPanel} />
          <Route path="/runs/new" component={NewRunPanel} />
          <Route path="/runs/:id" component={RunDetailPanel} />
          <Route path="/compare" component={ComparePanel} />
        </Router>
      </App>
    </LocationProvider>
  );
}

render(<Main />, document.getElementById('app')!);
