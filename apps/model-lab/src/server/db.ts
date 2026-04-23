import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dir, '../../data');

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, 'model-lab.db'), { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA strict_mode = ON');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT,
      total_tokens_in INTEGER NOT NULL DEFAULT 0,
      total_tokens_out INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_turns INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      final_content TEXT,
      kb_output TEXT,
      max_turns INTEGER NOT NULL DEFAULT 200,
      temperature REAL NOT NULL DEFAULT 0.3
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      scorer TEXT NOT NULL,
      score REAL NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_logs_run ON turn_logs(run_id)`);
}

export interface RunRow {
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

export interface TurnLogRow {
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
  created_at: string;
}

export interface QualityScoreRow {
  id: number;
  run_id: string;
  scorer: string;
  score: number;
  details: string | null;
  created_at: string;
}

export function insertRun(run: Omit<RunRow, 'completed_at' | 'error' | 'total_tokens_in' | 'total_tokens_out' | 'total_cost_usd' | 'total_turns' | 'duration_ms' | 'final_content' | 'kb_output'>): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO runs (id, model, source_file, source_size_bytes, status, started_at, max_turns, temperature)
    VALUES ($id, $model, $source_file, $source_size_bytes, $status, $started_at, $max_turns, $temperature)
  `).run({
    $id: run.id,
    $model: run.model,
    $source_file: run.source_file,
    $source_size_bytes: run.source_size_bytes,
    $status: run.status,
    $started_at: run.started_at,
    $max_turns: run.max_turns,
    $temperature: run.temperature,
  });
}

export function updateRunCompleted(
  id: string,
  patch: {
    status: string;
    completed_at: string;
    error?: string | null;
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost_usd: number;
    total_turns: number;
    duration_ms: number;
    final_content?: string | null;
    kb_output?: string | null;
  },
): void {
  const d = getDb();
  d.prepare(`
    UPDATE runs SET
      status = $status,
      completed_at = $completed_at,
      error = $error,
      total_tokens_in = $total_tokens_in,
      total_tokens_out = $total_tokens_out,
      total_cost_usd = $total_cost_usd,
      total_turns = $total_turns,
      duration_ms = $duration_ms,
      final_content = $final_content,
      kb_output = $kb_output
    WHERE id = $id
  `).run({
    $id: id,
    $status: patch.status,
    $completed_at: patch.completed_at,
    $error: patch.error ?? null,
    $total_tokens_in: patch.total_tokens_in,
    $total_tokens_out: patch.total_tokens_out,
    $total_cost_usd: patch.total_cost_usd,
    $total_turns: patch.total_turns,
    $duration_ms: patch.duration_ms,
    $final_content: patch.final_content ?? null,
    $kb_output: patch.kb_output ?? null,
  });
}

export function insertTurnLog(log: Omit<TurnLogRow, 'id' | 'created_at'>): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO turn_logs (run_id, turn_number, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, latency_ms)
    VALUES ($run_id, $turn_number, $role, $content, $tool_calls, $tool_call_id, $tokens_in, $tokens_out, $cost_usd, $latency_ms)
  `).run({
    $run_id: log.run_id,
    $turn_number: log.turn_number,
    $role: log.role,
    $content: log.content ?? null,
    $tool_calls: log.tool_calls ?? null,
    $tool_call_id: log.tool_call_id ?? null,
    $tokens_in: log.tokens_in,
    $tokens_out: log.tokens_out,
    $cost_usd: log.cost_usd,
    $latency_ms: log.latency_ms,
  });
}

export function listRuns(limit = 50): RunRow[] {
  return getDb().prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[];
}

export function getRun(id: string): RunRow | null {
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | null;
}

export function getTurnLogs(runId: string): TurnLogRow[] {
  return getDb().prepare('SELECT * FROM turn_logs WHERE run_id = ? ORDER BY turn_number ASC').all(runId) as TurnLogRow[];
}

export function insertQualityScore(score: Omit<QualityScoreRow, 'id' | 'created_at'>): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO quality_scores (run_id, scorer, score, details)
    VALUES ($run_id, $scorer, $score, $details)
  `).run({
    $run_id: score.run_id,
    $scorer: score.scorer,
    $score: score.score,
    $details: score.details ?? null,
  });
}

export function getQualityScores(runId: string): QualityScoreRow[] {
  return getDb().prepare('SELECT * FROM quality_scores WHERE run_id = ?').all(runId) as QualityScoreRow[];
}

export function getRunsBySource(sourceFile: string): RunRow[] {
  return getDb().prepare('SELECT * FROM runs WHERE source_file = ? ORDER BY started_at DESC').all(sourceFile) as RunRow[];
}
