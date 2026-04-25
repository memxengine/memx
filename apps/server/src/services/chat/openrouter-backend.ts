/**
 * F159 Phase 2 — OpenRouter chat backend.
 *
 * HTTPS to OpenRouter's OpenAI-compatible chat completions endpoint
 * with function-calling for the trail MCP tools (via in-process
 * router — no claude binary, no MCP subprocess required).
 *
 * Tool-use loop:
 *   1. POST messages + tools[] to OpenRouter
 *   2. If response has tool_calls → invoke each via invokeTrailMcpTool
 *   3. Append tool results to messages, loop
 *   4. If response has plain content → return as final answer
 *
 * Cost is tracked per-call from the `usage.cost` field OpenRouter
 * returns — the canonical truth-source for F156 credit-burn (1 credit
 * = $0.01). No streaming yet (Phase 2b adds SSE).
 *
 * Phase 2 limitations to flag:
 *   - No streaming. Final-answer-only response shape.
 *   - No fallback chain on backend failure (Phase 3).
 *   - In-process router has parallel handlers vs. apps/mcp (Phase 2b
 *     lifts to packages/core/src/mcp-tools/).
 */

import {
  invokeTrailMcpTool,
  mcpToolsToFunctionSpecs,
  type ToolContext,
} from './mcp-router.js';
import { tenants } from '@trail/db';
import { eq } from 'drizzle-orm';
import type { ChatBackend, ChatBackendInput, ChatBackendResult } from './backend.js';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

// OpenAI-compatible message shapes.
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenRouterResponse {
  choices: Array<{
    finish_reason: string;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number; // dollars
  };
}

export class OpenRouterChatBackend implements ChatBackend {
  readonly id = 'openrouter' as const;

  async run(input: ChatBackendInput): Promise<ChatBackendResult> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenRouterChatBackend: OPENROUTER_API_KEY env var is required',
      );
    }

    const t0 = Date.now();
    const ctx = await this.buildToolContext(input);
    const tools = mcpToolsToFunctionSpecs();

    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt },
      ...input.history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: input.userMessage },
    ];

    let totalCostDollars = 0;
    for (let turn = 0; turn < input.maxTurns; turn++) {
      const response = await this.callOpenRouter(apiKey, input.model, messages, tools, input.timeoutMs);
      const usageCost = response.usage?.cost ?? 0;
      totalCostDollars += usageCost;

      const choice = response.choices[0];
      if (!choice) {
        throw new Error(`OpenRouter returned no choices (model=${input.model})`);
      }

      // Tool-call branch
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        // Append the assistant's tool_call message to the conversation.
        messages.push({
          role: 'assistant',
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        });

        // Dispatch each tool call against the in-process MCP router.
        for (const toolCall of choice.message.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            parsedArgs = {};
          }
          const result = await invokeTrailMcpTool(toolCall.function.name, parsedArgs, ctx);
          // OpenAI tool messages take a single string as `content`.
          // The router already returns text-only content blocks; we
          // join them into one string for the API.
          const text = result.content.map((c) => c.text).join('\n');
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: text,
          });
        }
        continue;
      }

      // Final answer branch
      const answer = choice.message.content ?? '';
      return {
        answer,
        // OpenRouter returns dollars; F156 credits = cents (1 credit = $0.01).
        // Round to nearest cent — sub-cent precision lives in the raw
        // usage.cost field on the response if we ever need it.
        costCents: Math.round(totalCostDollars * 100),
        backendUsed: 'openrouter',
        modelUsed: input.model,
        stepsAttempted: 1,
        elapsedMs: Date.now() - t0,
      };
    }

    throw new Error(
      `OpenRouterChatBackend exceeded maxTurns=${input.maxTurns} without final answer (model=${input.model})`,
    );
  }

  private async callOpenRouter(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    tools: ReturnType<typeof mcpToolsToFunctionSpecs>,
    timeoutMs: number,
  ): Promise<OpenRouterResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // Optional but recommended by OpenRouter for analytics.
          'HTTP-Referer': 'https://trailmem.com',
          'X-Title': 'Trail',
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          // OpenRouter respects this; OpenAI calls it `tool_choice`.
          tool_choice: 'auto',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
      }
      return (await res.json()) as OpenRouterResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  private async buildToolContext(input: ChatBackendInput): Promise<ToolContext> {
    const tenant = await input.trail.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .get();
    return {
      trail: input.trail,
      tenantId: input.tenantId,
      defaultKbId: input.knowledgeBaseId,
      tenantName: tenant?.name ?? 'unknown',
    };
  }
}
