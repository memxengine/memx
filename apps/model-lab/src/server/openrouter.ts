const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

function getApiKey(): string {
  return process.env.OPENROUTER_API_KEY ?? '';
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface TurnResult {
  role: 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface RunConfig {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;
  maxTokens?: number;
  temperature?: number;
}

export interface RunResult {
  turns: TurnResult[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  totalTurns: number;
  durationMs: number;
  finalContent: string | null;
  error: string | null;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export async function runAgenticLoop(
  config: RunConfig,
  executeTool: ToolExecutor,
  onTurn?: (turn: TurnResult, turnNumber: number) => void,
): Promise<RunResult> {
  const start = Date.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: config.userPrompt },
  ];
  const turns: TurnResult[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let error: string | null = null;
  let finalContent: string | null = null;

  for (let i = 0; i < config.maxTurns; i++) {
    const turnStart = Date.now();

    let response: Response;
    try {
      response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://trail.broberg.dk',
          'X-Title': 'trail-model-lab',
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: config.tools.length > 0 ? config.tools : undefined,
          max_tokens: config.maxTokens ?? 4096,
          temperature: config.temperature ?? 0.3,
        }),
      });
    } catch (err) {
      error = `Network error: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      error = `OpenRouter ${response.status}: ${body.slice(0, 500)}`;
      break;
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: ToolCall[];
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
      };
    };

    const choice = data.choices[0];
    if (!choice) {
      error = 'No response from model';
      break;
    }

    const latencyMs = Date.now() - turnStart;
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;

    const costUsd = estimateCost(config.model, tokensIn, tokensOut);
    totalTokensIn += tokensIn;
    totalTokensOut += tokensOut;
    totalCostUsd += costUsd;

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    };
    messages.push(assistantMessage);

    const assistantTurn: TurnResult = {
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
    };
    turns.push(assistantTurn);
    onTurn?.(assistantTurn, i);

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      finalContent = choice.message.content;
      break;
    }

    for (const tc of choice.message.tool_calls) {
      const toolStart = Date.now();
      let toolResult: string;
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
        toolResult = `Error: Could not parse tool arguments: ${tc.function.arguments}`;
        const toolMsg: ChatMessage = { role: 'tool', content: toolResult, tool_call_id: tc.id };
        messages.push(toolMsg);
        const toolTurn: TurnResult = {
          role: 'tool',
          content: toolResult,
          tool_call_id: tc.id,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: Date.now() - toolStart,
        };
        turns.push(toolTurn);
        onTurn?.(toolTurn, i);
        continue;
      }

      try {
        toolResult = await executeTool(tc.function.name, toolArgs);
        if (toolResult.length > 50000) {
          toolResult = toolResult.slice(0, 50000) + '\n... [truncated at 50K chars]';
        }
      } catch (err) {
        toolResult = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }

      const toolMsg: ChatMessage = { role: 'tool', content: toolResult, tool_call_id: tc.id };
      messages.push(toolMsg);

      const toolTurn: TurnResult = {
        role: 'tool',
        content: toolResult,
        tool_call_id: tc.id,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: Date.now() - toolStart,
      };
      turns.push(toolTurn);
      onTurn?.(toolTurn, i);
    }
  }

  return {
    turns,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    totalTurns: turns.filter((t) => t.role === 'assistant').length,
    durationMs: Date.now() - start,
    finalContent: finalContent ?? turns.filter((t) => t.role === 'assistant').pop()?.content ?? null,
    error,
  };
}

const PRICING: Record<string, { input: number; output: number }> = {
  'google/gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'qwen/qwen3-8b': { input: 0.05, output: 0.40 },
  'qwen/qwen3.6-plus': { input: 0.325, output: 1.95 },
  'z-ai/glm-5.1': { input: 1.05, output: 3.50 },
  'anthropic/claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (tokensIn / 1_000_000) * pricing.input + (tokensOut / 1_000_000) * pricing.output;
}

export const AVAILABLE_MODELS = Object.keys(PRICING);
