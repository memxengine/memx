import { runMigrations, initFTS } from '@memx/db';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3031);

runMigrations();
initFTS();

const app = createApp();

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`memx server running on http://localhost:${server.port}`);
