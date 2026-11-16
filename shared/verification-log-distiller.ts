/**
 * 验证与编译器输出蒸馏器 & 跨轮次死循环检测（零 Node 专属依赖，前后端/Shared 通用）
 *
 * 设计借鉴自 GitHub 开源项目：
 * 1. `reviewdog/reviewdog`：将冗长编译器 / Linter / 测试原始输出解析为结构化 `file:line:col` 诊断，
 *    并与当前 Unified Diff 行号区间比对，分类为 `in-diff-hunk` / `in-changed-file` / `outside-diff`，
 *    优先聚焦本次改动引入的回归，避免历史基线噪音淹没关键错误。
 * 2. `SWE-agent/SWE-agent`：清洗 ANSI 控制符与重复堆栈帧，并在多轮返工中识别连续命中同一失败指纹的
 *    “原地打转（Stuck Loop）”现象，向执行岗位发出策略切换提示。
 */

export type VerificationDiffScope = 'in-diff-hunk' | 'in-changed-file' | 'outside-diff' | 'global';

export interface DistilledDiagnostic {
  tool: 'tsc' | 'eslint' | 'vite' | 'test' | 'python' | 'go' | 'rust' | 'generic';
  severity: 'error' | 'warning';
  file: string;
  line: number | null;
  column: number | null;
  code?: string;
  message: string;
  diffScope: VerificationDiffScope;
  fingerprint: string;
}

export interface VerificationDistillOptions {
  diffPatch?: string;
  changedFiles?: string[];
  workspacePrefix?: string;
  command?: string;
  exitCode?: number | null;
  maxDiagnostics?: number;
}

export interface VerificationDistillResult {
  command?: string;
  exitCode?: number | null;
  passed: boolean;
  diagnostics: DistilledDiagnostic[];
  failingTests: string[];
  counts: {
    total: number;
    inDiffHunk: number;
    inChangedFile: number;
    outsideDiff: number;
    global: number;
  };
  fingerprints: string[];
  compactSummary: string;
}

export interface VerificationRoundSnapshot {
  round: number;
  stage?: string;
  reason?: string;
  rawLog?: string;
  failedCriteria?: Array<string | { id: string; status?: string; evidence?: string }>;
  findings?: Array<{
    file: string;
    line?: number | null;
    problem: string;
  }>;
}

export interface StuckLoopItem {
  signature: string;
  kind: 'diagnostic' | 'test' | 'finding' | 'criterion';
  summary: string;
  rounds: number[];
}

export interface StuckLoopReport {
  stuck: true;
  consecutiveRounds: number;
  repeatedItems: StuckLoopItem[];
  promptWarning: string;
}

interface DiffHunkSpan {
  start: number;
  end: number;
}

// Strip CSI / OSC ANSI escape codes and carriage returns
const ANSI_REGEX = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

export function stripAnsiCodes(input: string): string {
  if (!input) return '';
  return input.replace(ANSI_REGEX, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseDiffNewLineRanges(diffPatch: string): Map<string, DiffHunkSpan[]> {
  const map = new Map<string, DiffHunkSpan[]>();
  if (!diffPatch.trim()) return map;
  let currentFile = '';
  for (const line of diffPatch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const bMatch = /\sb\/(.+)$/.exec(line);
      if (bMatch) currentFile = bMatch[1].trim().replace(/^"+|"+$/g, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw !== '/dev/null') {
        currentFile = raw.replace(/^b\//, '').replace(/^"+|"+$/g, '');
      }
      continue;
    }
    if (line.startsWith('@@ ') && currentFile) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const start = Number.parseInt(match[1], 10);
      const count = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      const end = start + Math.max(count - 1, 0);
      const list = map.get(currentFile) || [];
      list.push({ start, end });
      map.set(currentFile, list);
    }
  }
  return map;
}

function normalizeCandidatePath(
  rawPath: string,
  knownFiles: Set<string>,
  workspacePrefix?: string,
): string {
  let cleaned = rawPath.trim().replace(/^['"(]+|[)'":,]+$/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('file://')) {
    cleaned = cleaned.slice('file://'.length);
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // keep raw
    }
  }
  cleaned = cleaned.replace(/\\/g, '/');
  if (
    cleaned.startsWith('node:')
    || cleaned.includes('/node_modules/')
    || cleaned.startsWith('node_modules/')
    || cleaned === '<anonymous>'
  ) {
    return '';
  }
  if (workspacePrefix) {
    const prefix = workspacePrefix.replace(/\\/g, '/').replace(/\/+$/, '');
    if (prefix && cleaned.startsWith(`${prefix}/`)) {
      cleaned = cleaned.slice(prefix.length + 1);
    }
  }
  cleaned = cleaned.replace(/^\.\//, '').replace(/^\/+/, '');
  if (knownFiles.has(cleaned)) return cleaned;
  for (const known of knownFiles) {
    if (cleaned.endsWith(`/${known}`)) return known;
  }
  const repoAnchor = /(?:^|\/)((?:src|server|shared|test|tests|__tests__|packages|apps|lib|scripts|tools|components)\/.+)$/.exec(
    `/${cleaned}`,
  );
  if (repoAnchor) return repoAnchor[1];
  return cleaned;
}

function normalizeFingerprintText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '')
    .replace(/0x[0-9a-f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function buildDiagnosticFingerprint(
  tool: DistilledDiagnostic['tool'],
  file: string,
  code: string | undefined,
  message: string,
): string {
  return `${tool}:${file || 'global'}:${code || '-'}:${normalizeFingerprintText(message)}`;
}

function classifyDiffScope(
  file: string,
  line: number | null,
  diffRanges: Map<string, DiffHunkSpan[]>,
  changedSet: Set<string>,
): VerificationDiffScope {
  if (!file) return 'global';
  const spans = diffRanges.get(file);
  const inChanged = changedSet.has(file) || Boolean(spans);
  if (!inChanged) return 'outside-diff';
  if (line !== null && spans && spans.length > 0) {
    // Allow 3 lines of context margin around hunk boundaries
    const hit = spans.some(span => line >= span.start - 3 && line <= span.end + 3);
    if (hit) return 'in-diff-hunk';
  }
  return 'in-changed-file';
}

const SCOPE_PRIORITY: Record<VerificationDiffScope, number> = {
  'in-diff-hunk': 0,
  'in-changed-file': 1,
  'outside-diff': 2,
  global: 3,
};

const SCOPE_LABELS: Record<VerificationDiffScope, string> = {
  'in-diff-hunk': '本次改动行内',
  'in-changed-file': '本次改动文件',
  'outside-diff': '未改动文件/基线或下游波及',
  global: '全局检查',
};

/**
 * 将原始测试 / 类型检查 / 构建日志蒸馏为按 Diff 相关性排序的结构化诊断列表
 */
export function distillVerificationOutput(
  rawOutput: string,
  options: VerificationDistillOptions = {},
): VerificationDistillResult {
  const maxDiagnostics = options.maxDiagnostics ?? 25;
  const cleaned = stripAnsiCodes(rawOutput || '');
  const lines = cleaned.split('\n');
  const diffRanges = parseDiffNewLineRanges(options.diffPatch || '');
  const changedSet = new Set<string>([
    ...(options.changedFiles || []).map(f => f.replace(/\\/g, '/').replace(/^\.\//, '')),
    ...diffRanges.keys(),
  ]);

  const diagnostics: DistilledDiagnostic[] = [];
  const seenKeys = new Set<string>();
  const failingTests: string[] = [];
  const seenTests = new Set<string>();

  const pushDiagnostic = (item: Omit<DistilledDiagnostic, 'diffScope' | 'fingerprint'>) => {
    const file = item.file ? normalizeCandidatePath(item.file, changedSet, options.workspacePrefix) : '';
    if (item.file && !file) return; // Filtered internal/node_modules path
    const msg = item.message.trim().replace(/\s+/g, ' ').slice(0, 260);
    if (!msg) return;
    const dedupeKey = `${file}:${item.line ?? 0}:${item.code || ''}:${normalizeFingerprintText(msg)}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    const diffScope = classifyDiffScope(file, item.line, diffRanges, changedSet);
    const fingerprint = buildDiagnosticFingerprint(item.tool, file, item.code, msg);
    diagnostics.push({
      ...item,
      file,
      message: msg,
      diffScope,
      fingerprint,
    });
  };

  const recordFailingTest = (rawName: string) => {
    const name = rawName
      .replace(/\s*\(\d+(?:\.\d+)?\s*(?:ms|s)\)\s*$/i, '')
      .trim()
      .slice(0, 180);
    if (!name || seenTests.has(name)) return;
    // Ignore summary counters such as "tests 4" or "fail 1"
    if (/^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d+$/i.test(name)) return;
    seenTests.add(name);
    failingTests.push(name);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // 1. Failing test runners: node:test (`✖ name`), TAP (`not ok N - name`), Vitest/Jest (`FAIL file > name`, `✕ name`)
    const nodeTestFail = /^(?:✖|✕|×)\s+(.+)$/.exec(trimmed);
    if (nodeTestFail) {
      recordFailingTest(nodeTestFail[1]);
    }
    const tapFail = /^not ok\s+\d+\s+-\s+(.+)$/.exec(trimmed);
    if (tapFail && !trimmed.includes('# SKIP') && !trimmed.includes('# TODO')) {
      recordFailingTest(tapFail[1]);
    }
    const vitestFail = /^FAIL\s+(\S+)(?:\s+>\s+(.+))?$/.exec(trimmed);
    if (vitestFail) {
      recordFailingTest(vitestFail[2] ? `${vitestFail[1]} > ${vitestFail[2]}` : vitestFail[1]);
    }

    // 2. TypeScript / vue-tsc format A: `path/file.ts(12,5): error TS2345: Argument of type ...`
    const tscParen = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/.exec(trimmed);
    if (tscParen) {
      pushDiagnostic({
        tool: 'tsc',
        severity: tscParen[4] === 'warning' ? 'warning' : 'error',
        file: tscParen[1],
        line: Number.parseInt(tscParen[2], 10),
        column: Number.parseInt(tscParen[3], 10),
        code: tscParen[5],
        message: tscParen[6],
      });
      continue;
    }

    // 3. TypeScript / vue-tsc format B: `path/file.ts:12:5 - error TS2345: Argument of type ...`
    const tscColon = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)$/.exec(trimmed);
    if (tscColon) {
      pushDiagnostic({
        tool: 'tsc',
        severity: tscColon[4] === 'warning' ? 'warning' : 'error',
        file: tscColon[1],
        line: Number.parseInt(tscColon[2], 10),
        column: Number.parseInt(tscColon[3], 10),
        code: tscColon[5],
        message: tscColon[6],
      });
      continue;
    }

    // 4. Vite / esbuild / ESLint / Go / Rust colon format: `file.ts:12:5: error: ...`
    const colonDiag = /^([^\s:()]+\.[a-zA-Z0-9]{1,6}):(\d+)(?::(\d+))?:\s*(?:(error|warning|ERROR|WARN)\b[:\s-]*)?(.+)$/.exec(trimmed);
    if (colonDiag && !trimmed.startsWith('at ')) {
      const ext = colonDiag[1].split('.').pop()?.toLowerCase() || '';
      const rawSev = (colonDiag[4] || '').toLowerCase();
      const rest = colonDiag[5].trim();
      if (rawSev || /(?:error|failed|assert|exception|cannot|unexpected|undefined)/i.test(rest)) {
        const tool: DistilledDiagnostic['tool'] = ext === 'py'
          ? 'python'
          : ext === 'go'
            ? 'go'
            : ext === 'rs'
              ? 'rust'
              : /eslint/i.test(rest)
                ? 'eslint'
                : /vite|esbuild|rollup/i.test(cleaned)
                  ? 'vite'
                  : 'generic';
        pushDiagnostic({
          tool,
          severity: rawSev.startsWith('warn') ? 'warning' : 'error',
          file: colonDiag[1],
          line: Number.parseInt(colonDiag[2], 10),
          column: colonDiag[3] ? Number.parseInt(colonDiag[3], 10) : null,
          message: rest,
        });
        continue;
      }
    }

    // 5. Assertion / Runtime Error + Stack Frame lookahead (Node --test, Vitest, Jest)
    const errHeader = /^(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error)(?:\s*\[([A-Z0-9_]+)\])?:\s*(.+)$/.exec(trimmed);
    if (errHeader) {
      const [, errType, errCode, errMsg] = errHeader;
      // Collect up to 2 continuation lines (e.g. `100 !== 90` or `Expected ...`) before stack trace
      const detailParts = [`${errType}: ${errMsg}`];
      let matchedFrame: { file: string; line: number; col: number | null } | null = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 14); j += 1) {
        const sub = lines[j].trim();
        if (!sub) continue;
        const frameMatch = /^at\s+(?:.+?\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(sub);
        if (frameMatch) {
          const normalized = normalizeCandidatePath(frameMatch[1], changedSet, options.workspacePrefix);
          if (normalized) {
            matchedFrame = {
              file: normalized,
              line: Number.parseInt(frameMatch[2], 10),
              col: Number.parseInt(frameMatch[3], 10),
            };
            break;
          }
          continue;
        }
        if (detailParts.length < 3 && !sub.startsWith('code:') && !sub.startsWith('operator:')) {
          detailParts.push(sub);
        }
      }
      pushDiagnostic({
        tool: 'test',
        severity: 'error',
        file: matchedFrame?.file || '',
        line: matchedFrame?.line ?? null,
        column: matchedFrame?.col ?? null,
        code: errCode || errType,
        message: detailParts.join(' | '),
      });
    }
  }

  // Sort: in-diff-hunk -> in-changed-file -> outside-diff -> global, errors before warnings
  diagnostics.sort((a, b) => {
    const scopeDiff = SCOPE_PRIORITY[a.diffScope] - SCOPE_PRIORITY[b.diffScope];
    if (scopeDiff !== 0) return scopeDiff;
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
  });

  const counts = {
    total: diagnostics.length,
    inDiffHunk: diagnostics.filter(d => d.diffScope === 'in-diff-hunk').length,
    inChangedFile: diagnostics.filter(d => d.diffScope === 'in-changed-file').length,
    outsideDiff: diagnostics.filter(d => d.diffScope === 'outside-diff').length,
    global: diagnostics.filter(d => d.diffScope === 'global').length,
  };

  const capped = diagnostics.slice(0, maxDiagnostics);
  const passed = options.exitCode !== undefined && options.exitCode !== null
    ? options.exitCode === 0 && failingTests.length === 0 && !diagnostics.some(d => d.severity === 'error')
    : failingTests.length === 0 && !diagnostics.some(d => d.severity === 'error');

  const summaryLines: string[] = [];
  if (options.command) {
    summaryLines.push(`命令：\`${options.command}\`${options.exitCode !== undefined && options.exitCode !== null ? `（exitCode=${options.exitCode}）` : ''}`);
  }
  if (failingTests.length > 0) {
    summaryLines.push(`失败用例（${failingTests.length}）：${failingTests.slice(0, 6).map(t => `「${t}」`).join('、')}${failingTests.length > 6 ? ' 等' : ''}`);
  }
  if (capped.length > 0) {
    summaryLines.push(
      `诊断分布：共 ${counts.total} 项（本次改动行内 ${counts.inDiffHunk} · 改动文件内 ${counts.inChangedFile} · 未改动文件/下游波及 ${counts.outsideDiff}）`,
    );
    for (const diag of capped.slice(0, 12)) {
      const loc = diag.file
        ? `${diag.file}${diag.line !== null ? `:${diag.line}${diag.column !== null ? `:${diag.column}` : ''}` : ''}`
        : '全局';
      summaryLines.push(
        `- [${SCOPE_LABELS[diag.diffScope]}] ${loc}${diag.code ? ` (${diag.code})` : ''} — ${diag.message}`,
      );
    }
    if (counts.total > 12) {
      summaryLines.push(`- ……其余 ${counts.total - 12} 项已折叠，详见原始检查日志。`);
    }
  } else if (!passed) {
    const tail = lines.map(l => l.trim()).filter(Boolean).slice(-6);
    if (tail.length > 0) {
      summaryLines.push(`末尾关键输出：${tail.join(' / ').slice(0, 320)}`);
    }
  }

  return {
    command: options.command,
    exitCode: options.exitCode,
    passed,
    diagnostics: capped,
    failingTests,
    counts,
    fingerprints: [...new Set(diagnostics.map(d => d.fingerprint))],
    compactSummary: summaryLines.join('\n'),
  };
}

export function formatDistilledVerificationForPrompt(
  items: VerificationDistillResult | VerificationDistillResult[],
): string {
  const list = (Array.isArray(items) ? items : [items]).filter(item => !item.passed && item.compactSummary);
  if (list.length === 0) return '';
  return [
    '【检查失败精炼定位（已过滤 ANSI 噪音并按 Diff 相关性排序）】',
    ...list.map(item => item.compactSummary),
  ].join('\n\n');
}

function extractRoundSignatures(snapshot: VerificationRoundSnapshot): Map<string, { kind: StuckLoopItem['kind']; summary: string }> {
  const map = new Map<string, { kind: StuckLoopItem['kind']; summary: string }>();

  for (const criterion of snapshot.failedCriteria || []) {
    const id = (typeof criterion === 'string' ? criterion : criterion.id || '').trim();
    if (!id) continue;
    const evidenceNote = typeof criterion === 'object' && criterion.evidence
      ? `（${criterion.evidence.trim().slice(0, 80)}）`
      : '';
    map.set(`criterion:${id.toLowerCase()}`, {
      kind: 'criterion',
      summary: `验收项持续未通过：${id}${evidenceNote}`,
    });
  }

  for (const finding of snapshot.findings || []) {
    const file = (finding.file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim() || 'global';
    const norm = normalizeFingerprintText(finding.problem || '');
    if (!norm) continue;
    const tokenKey = norm.split(' ').slice(0, 8).join(' ');
    map.set(`finding:${file}:${tokenKey}`, {
      kind: 'finding',
      summary: `${file}${finding.line ? `:${finding.line}` : ''} — ${finding.problem.trim().slice(0, 120)}`,
    });
  }

  if (snapshot.rawLog) {
    const distilled = distillVerificationOutput(snapshot.rawLog);
    for (const testName of distilled.failingTests) {
      map.set(`test:${normalizeFingerprintText(testName)}`, {
        kind: 'test',
        summary: `用例持续失败：${testName}`,
      });
    }
    for (const diag of distilled.diagnostics) {
      map.set(`diag:${diag.fingerprint}`, {
        kind: 'diagnostic',
        summary: `${diag.file || '全局'}${diag.line ? `:${diag.line}` : ''} — ${diag.message.slice(0, 120)}`,
      });
    }
  }

  return map;
}

/**
 * 识别多轮验证 / 审查中的重复失败死循环（SWE-agent 风格 Stuck-Loop 检测）
 */
export function detectVerificationStuckLoop(
  rounds: VerificationRoundSnapshot[],
): StuckLoopReport | undefined {
  if (!rounds || rounds.length < 2) return undefined;
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  const latest = sorted.at(-1)!;
  const previous = sorted.at(-2)!;

  const latestSigs = extractRoundSignatures(latest);
  const prevSigs = extractRoundSignatures(previous);
  if (latestSigs.size === 0 || prevSigs.size === 0) return undefined;

  const repeatedItems: StuckLoopItem[] = [];
  for (const [sig, info] of latestSigs.entries()) {
    if (!prevSigs.has(sig)) continue;
    const hitRounds: number[] = [];
    for (const r of sorted) {
      if (extractRoundSignatures(r).has(sig)) hitRounds.push(r.round);
    }
    repeatedItems.push({
      signature: sig,
      kind: info.kind,
      summary: info.summary,
      rounds: hitRounds,
    });
  }

  if (repeatedItems.length === 0) return undefined;

  const maxStreak = Math.max(...repeatedItems.map(item => item.rounds.length));
  const lines = [
    `【反死循环策略告警（连续 ${maxStreak} 轮命中相同失败特征）】`,
    '上一轮修复后，以下相同问题在验证/审查中再次原样复现，说明仅在原位置做表层修补未能触及根因：',
    ...repeatedItems.slice(0, 6).map(
      item => `- [轮次 ${item.rounds.map(r => `#${r}`).join(' -> ')}] ${item.summary}`,
    ),
    '请切换排查策略：1) 核查真实调用链与未改动的上下游依赖文件；2) 复现并打印最小输入输出而非猜测；3) 检查是否存在旧编译产物、Mock/Fixture 数据未同步或异步竞态。',
  ];

  return {
    stuck: true,
    consecutiveRounds: maxStreak,
    repeatedItems,
    promptWarning: lines.join('\n'),
  };
}
