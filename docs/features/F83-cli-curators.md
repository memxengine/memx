# F83 — CLI for Curators (`trail queue approve …`)

> `trail queue list|approve|reject`, `trail source add <path>`, `trail wiki search <query>`. Thin wrapper over MCP tools. Keyboard-driven curation for power users.

## Problem

Admin UI'en er god til visuel curation, men power users vil gerne arbejde fra terminalen: approve 20 candidates med ét command, søge wiki'en uden at åbne browseren, eller tilføje sources fra scripts. MCP tools (F11) eksisterer allerede — CLI'en er et thin wrapper der gør dem tilgængelige fra command line.

## Solution

Et `@trail/cli` package der eksporterer kommandoer:
- `trail queue list [--kb=<id>] [--status=pending]` — list candidates
- `trail queue approve <id>` — approve a candidate
- `trail queue reject <id> --reason="..."` — reject with reason
- `trail source add <path> --kb=<id>` — upload source file
- `trail wiki search <query> [--kb=<id>]` — FTS5 search
- `trail wiki read <slug>` — read a neuron
- `trail config set <key> <value>` — configure server URL, API key

CLI'en bruger Trail's MCP server som backend — ingen direkte API calls.

## Technical Design

### 1. CLI Framework

```typescript
// packages/cli/src/index.ts

import { Command } from 'commander';
import { queueCommands } from './commands/queue.js';
import { sourceCommands } from './commands/source.js';
import { wikiCommands } from './commands/wiki.js';
import { configCommands } from './commands/config.js';

const program = new Command();

program.name('trail').description('Trail CLI for curators').version('0.1.0');

program.addCommand(queueCommands);
program.addCommand(sourceCommands);
program.addCommand(wikiCommands);
program.addCommand(configCommands);

program.parse();
```

### 2. Queue Commands

```typescript
// packages/cli/src/commands/queue.ts

import { Command } from 'commander';
import { connectMCP } from '../lib/mcp-client.js';

export const queueCommands = new Command('queue').description('Manage curation queue');

queueCommands
  .command('list')
  .description('List queue candidates')
  .option('--kb <id>', 'Filter by KB')
  .option('--status <status>', 'Filter by status', 'pending')
  .option('--limit <n>', 'Max results', '20')
  .action(async (options) => {
    const mcp = await connectMCP();
    const candidates = await mcp.call('queue_list', {
      knowledgeBaseId: options.kb,
      status: options.status,
      limit: parseInt(options.limit),
    });

    for (const c of candidates) {
      console.log(`${c.id.slice(0, 8)}  ${c.kind.padEnd(20)}  ${c.title?.slice(0, 50)}`);
    }
  });

queueCommands
  .command('approve <id>')
  .description('Approve a queue candidate')
  .action(async (id) => {
    const mcp = await connectMCP();
    await mcp.call('queue_resolve', { candidateId: id, action: 'approve' });
    console.log(`✓ Candidate ${id.slice(0, 8)} approved`);
  });

queueCommands
  .command('reject <id>')
  .description('Reject a queue candidate')
  .option('--reason <text>', 'Rejection reason')
  .action(async (id, options) => {
    const mcp = await connectMCP();
    await mcp.call('queue_resolve', {
      candidateId: id,
      action: 'reject',
      reason: options.reason,
    });
    console.log(`✗ Candidate ${id.slice(0, 8)} rejected`);
  });
```

### 3. MCP Client

```typescript
// packages/cli/src/lib/mcp-client.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function connectMCP(): Promise<MCPClient> {
  const config = await loadConfig();
  const transport = new StdioClientTransport({
    command: 'node',
    args: [config.mcpServerPath],
    env: {
      TRAIL_SERVER_URL: config.serverUrl,
      TRAIL_API_KEY: config.apiKey,
    },
  });

  const client = new Client({ name: 'trail-cli', version: '0.1.0' });
  await client.connect(transport);
  return client;
}
```

### 4. Config Management

```typescript
// packages/cli/src/commands/config.ts

export const configCommands = new Command('config').description('Manage CLI config');

configCommands
  .command('set <key> <value>')
  .description('Set a config value')
  .action(async (key, value) => {
    const config = await loadConfig();
    config[key] = value;
    await saveConfig(config);
    console.log(`✓ ${key} = ${value}`);
  });

configCommands
  .command('show')
  .description('Show current config')
  .action(async () => {
    const config = await loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });
```

## Impact Analysis

### Files created (new)
- `packages/cli/src/index.ts` — CLI entry point
- `packages/cli/src/commands/queue.ts` — queue commands
- `packages/cli/src/commands/source.ts` — source commands
- `packages/cli/src/commands/wiki.ts` — wiki commands
- `packages/cli/src/commands/config.ts` — config commands
- `packages/cli/src/lib/mcp-client.ts` — MCP client
- `packages/cli/package.json` — CLI package config

### Files modified
- `pnpm-workspace.yaml` — include CLI package
- `packages/mcp/src/tools.ts` — ensure all tools are CLI-accessible

### Downstream dependents for modified files

**`pnpm-workspace.yaml`** — adding CLI package is additive. No existing packages depend on it.

**`packages/mcp/src/tools.ts`** — MCP tools are called by CLI via MCP protocol. No direct imports — CLI uses MCP client to call tools. Existing tools unchanged.

### Blast radius
- CLI is a new package — no impact on existing code
- MCP tools must be stable for CLI compatibility
- Config stored in `~/.trail/config.json` — standard location

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: CLI commands parse arguments correctly
- [ ] Unit: MCP client connects and calls tools
- [ ] Integration: `trail queue list` returns candidates
- [ ] Integration: `trail queue approve <id>` approves candidate
- [ ] Integration: `trail wiki search <query>` returns results
- [ ] Integration: `trail config set` persists config
- [ ] Regression: MCP server unchanged

## Implementation Steps

1. Create CLI package with Commander.js
2. Implement queue commands (list, approve, reject)
3. Implement source commands (add)
4. Implement wiki commands (search, read)
5. Implement config commands (set, show)
6. Create MCP client wrapper
7. Integration test: full CLI workflow
8. Publish as `@trail/cli`

## Dependencies

- F11 (MCP Stdio Server) — CLI uses MCP tools as backend
- F17 (Curation Queue API) — queue commands

## Effort Estimate

**Small** — 1-2 days

- Day 1: CLI framework + queue commands + MCP client
- Day 2: Source/wiki/config commands + integration testing
