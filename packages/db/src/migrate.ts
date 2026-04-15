import { runMigrations, initFTS } from './index.js';

console.log('Running trail migrations...');
runMigrations();
initFTS();
console.log('Done.');
