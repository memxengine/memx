/**
 * F159 Phase 2b — Claude API direct backend.
 *
 * Direct HTTPS to Anthropic's Messages API instead of going through
 * OpenRouter. The latency win matters when we're paying for Claude
 * anyway — Christian's resolved open question #3: "når vi endelig
 * betaler for claude API skal vi også høste maksimalt og det er på
 * hastighed."
 *
 * Tool-use loop uses Anthropic's `tool_use` / `tool_result` content
 * blocks (similar to OpenRouter's tool_calls but slightly different
 * shape — see `convertToAnthropicTools` for the spec mapping). Same
 * in-process MCP router as the OpenRouter backend, no MCP subprocess.
 *
 * Verification status (2026-04-25): TYPE-CHECKED only. No end-to-end
 * probe yet because Christian's .env has no ANTHROPIC_API_KEY (he
 * runs Claude via Max-Plan CLI). When the key arrives — either for
 * production deploy (F33) or for a tenant's premium chat tier — the
 * verify-f159-phase2c.ts script (TODO) lifts the OpenRouter probe to
 * also exercise this backend.
 *
 * Phase 2b limitations to flag:
 *   - No streaming. Final-answer-only response shape.
 *   - No fallback chain (Phase 4).
 *   - Cost stamping is conservative — Anthropic's API doesn't return
 *     a usage.cost field like OpenRouter; we compute from input/output
 *     tokens × the model's published price (table at top of file).
 *     If the price changes, this code needs updating. Phase 3 may
 *     move this into the F156 chat-pricing.yaml canonical.
 */

import {
  invokeTrailMcpTool,
  type ToolContext,
  _internal as routerInternal,
} from './mcp-router.js';
import { tenants } from '@trail/db';
import { eq } from 'drizzle-orm';
import type { ChatBackend, ChatBackendInput, ChatBackendResult } from './backend.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Per-1M-token prices in cents. From Anthropic's pricing page (2026-04).
 * If a model isn't here we return null cost and log — better to track
 * unknown than to make up numbers.
 */
const PRICING_CENTS_PER_M: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001': { in: 80, out: 400 },     // $0.80 / $4.00 per M
  'claude-sonnet-4-6': { in: 300, out: 1500 },           // $3.00 / $15.00 per M
  'claude-sonnet-4-6-20251001': { in: 300, out: 1500 },
  'claude-opus-4-7': { in: 1500, out: 7500 },            // $15.00 / $75.00 per M
};

// Anthropic content blocks
type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface AnthropicResponse {
  stop_reason: string;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

export class ClaudeAPIBackend implements ChatBackend {
  readonly id = 'claude-api' as const;

  async run(input: ChatBackendInput): Promise<ChatBackendResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ClaudeAPIBackend: ANTHROPIC_API_KEY env var is required',
      );
    }

    const t0 = Date.now();
    const ctx = await this.buildToolContext(input);
    const tools = convertToAnthropicTools();

    // Anthropic wants history as alternating user/assistant messages.
    const messages: AnthropicMessage[] = [
      ...input.history.map(
        (h): AnthropicMessage => ({ role: h.role, content: h.content }),
      ),
      { role: 'user', content: input.userMessage },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let turn = 0; turn < input.maxTurns; turn++) {
      const response = await this.callAnthropic(apiKey, input, messages, tools);
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Tool-use branch: response contains one or more tool_use blocks.
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use',
        );

        // Append the assistant's full content (text + tool_use blocks)
        // to the conversation as a structured message.
        messages.push({ role: 'assistant', content: response.content });

        // Dispatch each tool call against the in-process MCP router.
        const toolResults: ToolResultBlock[] = [];
        for (const tu of toolUseBlocks) {
          const result = await invokeTrailMcpTool(tu.name, tu.input, ctx);
          const text = result.content.map((c) => c.text).join('\n');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: text,
          });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Final answer branch
      const answer = response.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      return {
        answer,
        costCents: computeCost(input.model, totalInputTokens, totalOutputTokens),
        backendUsed: 'claude-api',
        modelUsed: input.model,
        stepsAttempted: 1,
        elapsedMs: Date.now() - t0,
      };
    }

    throw new Error(
      `ClaudeAPIBackend exceeded maxTurns=${input.maxTurns} without final answer (model=${input.model})`,
    );
  }

  private async callAnthropic(
    apiKey: string,
    input: ChatBackendInput,
    messages: AnthropicMessage[],
    tools: ReturnType<typeof convertToAnthropicTools>,
  ): Promise<AnthropicResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const res = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: input.model,
          system: input.systemPrompt,
          messages,
          tools,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
      }
      return (await res.json()) as AnthropicResponse;
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

/**
 * Convert the in-process MCP router's tool definitions to Anthropic's
 * `tools[]` shape. Differs from OpenAI's: top-level `name` +
 * `description` + `input_schema` (no `type: function` wrapper).
 */
function convertToAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  // We re-use the router's TOOLS array (exported via _internal) and the
  // same zodToJsonSchema. Anthropic accepts the same JSON-Schema shape
  // OpenAI uses for `parameters`.
  return routerInternal.TOOLS.map((t) => ({
    name: `mcp__trail__${t.name}`,
    description: t.description,
    input_schema: zodToJsonSchemaInline(t.inputSchema),
  }));
}

// Mini zod→JSON-Schema replicator. Same logic as mcp-router.ts; kept
// inline to avoid exporting a private helper. If a third backend
// arrives we'll lift this to a shared module.
import { z } from 'zod';
function zodToJsonSchemaInline(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, zodField] of Object.entries(shape)) {
    const def = zodFieldToProp(zodField as z.ZodTypeAny);
    properties[key] = def.property;
    if (def.required) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function zodFieldToProp(field: z.ZodTypeAny): {
  property: Record<string, unknown>;
  required: boolean;
} {
  let inner = field;
  let optional = false;
  let defaultValue: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desc = (field as any)._def?.description;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (inner as any)._def;
    if (def?.typeName === 'ZodOptional') {
      optional = true;
      inner = def.innerType;
      continue;
    }
    if (def?.typeName === 'ZodDefault') {
      optional = true;
      defaultValue = def.defaultValue();
      inner = def.innerType;
      continue;
    }
    break;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const innerDef = (inner as any)._def;
  const typeName: string = innerDef?.typeName ?? 'ZodAny';
  let property: Record<string, unknown>;
  if (typeName === 'ZodString') property = { type: 'string' };
  else if (typeName === 'ZodNumber') property = { type: 'number' };
  else if (typeName === 'ZodBoolean') property = { type: 'boolean' };
  else if (typeName === 'ZodEnum') property = { type: 'string', enum: innerDef.values as string[] };
  else property = { type: 'string' };
  if (typeof desc === 'string') property.description = desc;
  if (defaultValue !== undefined) property.default = defaultValue;
  return { property, required: !optional };
}

/**
 * Compute cost in cents from Anthropic input/output tokens. Returns
 * null when the model isn't in our pricing table — we'd rather track
 * "unknown" than fabricate a number.
 */
function computeCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = PRICING_CENTS_PER_M[model];
  if (!pricing) {
    console.warn(`[claude-api-backend] unknown model "${model}" — cost untracked`);
    return null;
  }
  // cents-per-M × tokens / 1M = cents. Round to whole cents for storage.
  const cost = (pricing.in * inputTokens + pricing.out * outputTokens) / 1_000_000;
  return Math.round(cost * 100) / 100; // 2 decimal places
}
