/**
 * 设计说明：该适配器只读取 Codex 自己维护的会话索引与历史投影，不复制或改写源数据库。
 * 列表和正文从 Codex 索引读取。旧轮次的上下文水位按需从对应 rollout 读取。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CodexSessionDetail, CodexSessionSummary, CodexSessionTurn } from '../shared/agent-runtime.js';
import { readAgentContextUsage, type AgentContextUsage } from '../shared/agent-usage.js';

const exec = promisify(execFile);
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

interface SqliteSessionRow {
  id: string;
  title: string | null;
  preview: string | null;
  cwd: string | null;
  git_branch: string | null;
  git_sha: string | null;
  model: string | null;
  reasoning_effort: string | null;
  archived: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface SqliteTurnRow {
  turn_id: string;
  started_at: number | null;
  completed_at: number | null;
  user_json: string | null;
  agent_json: string | null;
}

export interface CodexSessionSource {
  listSessions(): Promise<CodexSessionSummary[]>;
  session(id: string): Promise<CodexSessionDetail>;
  contextUsage?(id: string, turnId: string): Promise<AgentContextUsage | undefined>;
}

function isoFromMilliseconds(value: number) {
  return new Date(Number.isFinite(value) ? value : 0).toISOString();
}

function isoFromSeconds(value: number | null, fallback: string) {
  return value ? new Date(value * 1000).toISOString() : fallback;
}

function safeText(value: unknown, limit = 12_000) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit)
    : '';
}

function summary(row: SqliteSessionRow): CodexSessionSummary {
  const reasoningEffort = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(row.reasoning_effort || '')
    ? row.reasoning_effort as CodexSessionSummary['reasoningEffort'] : '';
  return {
    id: row.id,
    title: safeText(row.title, 1000) || safeText(row.preview, 1000) || '未命名 Codex 会话',
    preview: safeText(row.preview, 4000),
    workspacePath: safeText(row.cwd, 1000),
    branch: safeText(row.git_branch, 300),
    headSha: safeText(row.git_sha, 100),
    model: safeText(row.model, 100),
    reasoningEffort,
    archived: row.archived === 1,
    createdAt: isoFromMilliseconds(row.created_at_ms),
    updatedAt: isoFromMilliseconds(row.updated_at_ms),
  };
}

function messageText(json: string | null, agent: boolean) {
  if (!json) return '';
  try {
    const item = JSON.parse(json) as { text?: unknown; content?: { type?: unknown; text?: unknown }[] };
    if (agent) return safeText(item.text);
    return safeText(Array.isArray(item.content)
      ? item.content.filter((part) => part?.type === 'text').map((part) => safeText(part.text)).filter(Boolean).join('\n')
      : '');
  } catch { return ''; }
}

function turn(row: SqliteTurnRow, session: CodexSessionSummary): CodexSessionTurn | undefined {
  const userMessage = messageText(row.user_json, false);
  if (!userMessage) return undefined;
  const createdAt = isoFromSeconds(row.started_at, session.createdAt);
  const completedAt = row.completed_at !== null && Number.isFinite(row.completed_at) && row.completed_at > 0
    ? new Date(row.completed_at * 1000).toISOString() : null;
  return {
    id: row.turn_id,
    userMessage,
    agentMessage: messageText(row.agent_json, true),
    createdAt,
    updatedAt: completedAt || createdAt,
    completedAt,
  };
}

export function createCodexSessionSource(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const stateDatabase = path.join(codexHome, 'state_5.sqlite');
  const historyDatabase = path.join(codexHome, 'thread_history_1.sqlite');
  async function query<T>(database: string, sql: string) {
    const result = await exec('sqlite3', ['-readonly', '-json', database, sql], { timeout: 15_000, maxBuffer: 30_000_000 });
    return JSON.parse(result.stdout || '[]') as T[];
  }
  async function listSessions() {
    const rows = await query<SqliteSessionRow>(stateDatabase, `
      SELECT id, title, preview, cwd, git_branch, git_sha, model, reasoning_effort, archived, created_at_ms, updated_at_ms
      FROM threads
      WHERE COALESCE(preview, '') <> ''
        AND archived = 0
        AND COALESCE(thread_source, '') IN ('', 'user', 'cli')
        AND source NOT LIKE '{"subagent"%'
      ORDER BY updated_at_ms DESC
    `);
    return rows.filter((row) => sessionIdPattern.test(row.id)).map(summary);
  }
  async function session(id: string) {
    if (!sessionIdPattern.test(id)) throw new Error('Codex 会话 ID 格式不正确');
    const rows = await query<SqliteSessionRow>(stateDatabase, `
      SELECT id, title, preview, cwd, git_branch, git_sha, model, reasoning_effort, archived, created_at_ms, updated_at_ms
      FROM threads WHERE id = '${id}' AND COALESCE(preview, '') <> '' LIMIT 1
    `);
    if (!rows[0]) throw new Error('找不到该 Codex 会话');
    const sessionSummary = summary(rows[0]);
    const turnRows = await query<SqliteTurnRow>(historyDatabase, `
      SELECT turns.turn_id, turns.started_at, turns.completed_at,
        user_item.item_json AS user_json, agent_item.item_json AS agent_json
      FROM thread_turns AS turns
      LEFT JOIN thread_items AS user_item
        ON user_item.thread_id = turns.thread_id AND user_item.item_id = turns.first_user_item_id
      LEFT JOIN thread_items AS agent_item
        ON agent_item.thread_id = turns.thread_id AND agent_item.item_id = turns.final_agent_item_id
      WHERE turns.thread_id = '${id}'
      ORDER BY turns.rollout_ordinal
    `);
    return { ...sessionSummary, turns: turnRows.map((row) => turn(row, sessionSummary)).filter((item): item is CodexSessionTurn => !!item) };
  }
  async function contextUsage(id: string, turnId: string) {
    if (!sessionIdPattern.test(id) || !sessionIdPattern.test(turnId)) return;
    try {
      const [row] = await query<{ rollout_path: string }>(stateDatabase, `SELECT rollout_path FROM threads WHERE id = '${id}' LIMIT 1`);
      if (!row?.rollout_path) return;
      const [home, rollout] = await Promise.all([fs.realpath(codexHome), fs.realpath(row.rollout_path)]);
      const relative = path.relative(home, rollout);
      if (path.extname(rollout) !== '.jsonl' || !['sessions', 'archived_sessions'].some(dir => relative.startsWith(dir + path.sep))) return;
      const file = await fs.open(rollout, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return;
        const start = Math.max(0, stat.size - 8 * 1024 * 1024);
        const buffer = Buffer.alloc(stat.size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
        if (start) lines.shift();
        let activeTurn: string | undefined;
        let usage: AgentContextUsage | undefined;
        for (const line of lines) {
          if (!/"(?:task_started|turn_context|token_count)"/.test(line)) continue;
          try {
            const { type, payload } = JSON.parse(line);
            if (type === 'turn_context' || type === 'event_msg' && payload?.type === 'task_started') {
              if (typeof payload?.turn_id === 'string') activeTurn = payload.turn_id;
            }
            if (activeTurn === turnId && type === 'event_msg' && payload?.type === 'token_count') {
              const info = payload.info;
              const last = info?.last_token_usage;
              const measured = readAgentContextUsage(last?.total_tokens, info?.model_context_window);
              if (measured) usage = measured;
            }
          } catch { /* Skip an incomplete rollout line. */ }
        }
        return usage;
      } finally { await file.close(); }
    } catch { return undefined; }
  }
  return { listSessions, session, contextUsage };
}
