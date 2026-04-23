export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body.error) message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    } catch {}
    throw new Error(message);
  }
  return response.json() as T;
}

export interface ModelInfo {
  id: string;
  input: number;
  output: number;
  label: string;
}

export interface Run {
  id: string;
  model: string;
  source_file: string;
  source_size_bytes: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  total_turns: number;
  duration_ms: number;
  final_content: string | null;
  kb_output: string | null;
  max_turns: number;
  temperature: number;
}

export interface TurnLog {
  id: number;
  run_id: string;
  turn_number: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
}

export interface QualityScore {
  id: number;
  run_id: string;
  scorer: string;
  score: number;
  details: string | null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function modelLabel(id: string): string {
  const labels: Record<string, string> = {
    'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
    'qwen/qwen3-8b': 'Qwen3 8B',
    'qwen/qwen3.6-plus': 'Qwen3.6 Plus',
    'z-ai/glm-5.1': 'GLM-5.1',
    'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'anthropic/claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  };
  return labels[id] ?? id;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'done': return 'color:var(--color-success)';
    case 'running': return 'color:var(--color-warning)';
    case 'failed': return 'color:var(--color-error)';
    default: return 'color:var(--color-fg-muted)';
  }
}

export function scoreColor(score: number): string {
  if (score >= 0.8) return 'var(--color-success)';
  if (score >= 0.5) return 'var(--color-warning)';
  return 'var(--color-error)';
}
