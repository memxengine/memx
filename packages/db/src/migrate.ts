import { runMigrations, initFTS } from './index.js';

console.log('Running memx migrations...');
runMigrations();
initFTS();
console.log('Done.');
