/**
 * F159 Phase 1 — Claude CLI chat backend.
 *
 * Verbatim lift of the pre-F159 chat.ts subprocess flow. Spawns
 * `claude -p <prompt> --mcp-config … --max-turns N --output-format json
 *  --allowedTools …`, parses the assistant text out of the JSON envelope,
 * returns a ChatBackendResult.
 *
 * Identical behaviour to the pre-refactor route: same args, same env,
 * same error mapping. Phase 1 verifies "no behaviour change" by running
 * 5 prepared chat questions against this backend and asserting the
 * answers + citations match the pre-F159 code path.
 *
 * Cost is always NULL because Claude-CLI rides Christian's Max Plan
 * flat fee — there's no per-call price to track. Phase 3 adds
 * cost-stamping on the OpenRouter and Claude-API backends only.
 */

import { spawnClaude, extractAssistantText } from '../claude.js';
import { buildCliPrompt } from './build-prompt.js';
import type { ChatBackend, ChatBackendInput, ChatBackendResult } from './backend.js';

export class ClaudeCLIChatBackend implements ChatBackend {
  readonly id = 'claude-cli' as const;

  async run(input: ChatBackendInput): Promise<ChatBackendResult> {
    const t0 = Date.now();
    const prompt = buildCliPrompt(input.systemPrompt, input.history, input.userMessage);

    const mcpConfig = {
      mcpServers: {
        trail: {
          command: 'bun',
          args: ['run', input.mcpServerPath],
        },
      },
    };

    const args = [
      '-p',
      prompt,
      '--dangerously-skip-permissions',
      '--max-turns',
      String(input.maxTurns),
      '--output-format',
      'json',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--allowedTools',
      input.toolNames.join(','),
      ...(input.model ? ['--model', input.model] : []),
    ];

    // The MCP subprocess reads tenant/KB/user from env to scope every
    // query to the right rows. Without these it refuses to run (see
    // requireContext in apps/mcp).
    const spawnEnv = {
      TRAIL_TENANT_ID: input.tenantId,
      TRAIL_KNOWLEDGE_BASE_ID: input.knowledgeBaseId,
      TRAIL_USER_ID: input.userId,
    };

    const raw = await spawnClaude(args, { timeoutMs: input.timeoutMs, env: spawnEnv });
    const answer = extractAssistantText(raw);
    return {
      answer,
      costCents: null,
      backendUsed: 'claude-cli',
      modelUsed: input.model,
      stepsAttempted: 1,
      elapsedMs: Date.now() - t0,
    };
  }
}
