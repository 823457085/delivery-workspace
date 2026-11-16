/**
 * 借鉴 PR-Agent 核心工程机制的确定性 Diff 预压缩、风险扫描、跨轮次审查追踪、仓库规范发现与 MR 描述构建器。
 * 零外部网络或额外模型调用依赖，供本地团队流程、治理盲审及远端 MR 交付共用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentTaskFinding } from '../shared/agent-task-result.js';
export {
  anchorFindingsToDiff,
  buildSmartCommitMessage,
  extractBranchIssueKey,
  formatAnchoredFindingsForReworkPrompt,
  formatInlineReviewChecklistMarkdown,
  isSensitiveCommitPath,
  scanDiffHygieneIssues,
  type AnchoredReviewFinding,
  type DiffHygieneCategory,
  type DiffHygieneSeverity,
  type DiffHygieneWarning,
  type FindingDiffAnchorKind,
  type SmartCommitSuggestion,
} from '../shared/diff-review-hygiene.js';

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type RiskCategory =
  | 'auth-permission'
  | 'route-exposure'
  | 'concurrency-state'
  | 'command-fs'
  | 'schema-config'
  | 'secret-hygiene';

export interface DeterministicRiskHit {
  category: RiskCategory;
  label: string;
  severity: 'high' | 'medium';
  file: string;
  line: number | null;
  reason: string;
  snippet: string;
}

export interface ParsedDiffHunkLine {
  kind: 'context' | 'add' | 'del' | 'meta';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ParsedDiffHunkLine[];
}

export interface AnalyzedDiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  generated: boolean;
  isTest: boolean;
  additions: number;
  deletions: number;
  riskCategories: RiskCategory[];
  shapeSignature: string;
  hunks: ParsedDiffHunk[];
}

export interface MechanicalCluster {
  id: string;
  description: string;
  count: number;
  representative: string;
  sampledFiles: string[];
  files: string[];
}

export interface LargeDiffSamplingPlan {
  triggered: boolean;
  totalFiles: number;
  mandatoryFiles: string[];
  sampledMechanicalFiles: string[];
  clusters: MechanicalCluster[];
}

export interface DiffTriageAnalysis {
  totals: {
    files: number;
    sourceFiles: number;
    testFiles: number;
    generatedFiles: number;
    binaryFiles: number;
    additions: number;
    deletions: number;
  };
  files: Omit<AnalyzedDiffFile, 'hunks' | 'shapeSignature'>[];
  risks: DeterministicRiskHit[];
  generatedPaths: string[];
  samplingPlan: LargeDiffSamplingPlan;
  focusedPatch: string;
  focusedPatchTruncated: boolean;
}

export interface PriorReviewSnapshot {
  round: number;
  step?: number;
  author?: string;
  verdict?: string;
  reason: string;
  findings: AgentTaskFinding[];
  failedCriteria?: { id: string; status: string; evidence: string }[];
  blockers?: string[];
}

export interface TrackedReviewFinding {
  fingerprint: string;
  latestId: string;
  severity: AgentTaskFinding['severity'];
  file: string;
  line: number | null;
  problem: string;
  expectation: string;
  firstSeenRound: number;
  lastSeenRound: number;
  occurrences: number;
  fileState: 'modified_since_last_review' | 'unchanged_since_last_review' | 'no_file_target';
}

export interface CrossRoundFindingLedger {
  previousRound: number;
  totalOpenFindings: number;
  blockerCount: number;
  untouchedFileFindings: number;
  repeatedFindings: number;
  failedCriteria: { id: string; status: string; evidence: string }[];
  blockers: string[];
  items: TrackedReviewFinding[];
}

const generatedNames = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
]);

const generatedPrefixes = [
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  'vendor/',
  '__snapshots__/',
];

const generatedSuffixes = [
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.map',
  '.snap',
  '.pb.go',
  '.gen.ts',
  '.generated.ts',
  '-lock.json',
];

function normalizeDiffPath(raw: string) {
  const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
  if (trimmed === '/dev/null') return '';
  return trimmed.replace(/^[ab]\//, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isGeneratedOrNoiseFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const base = path.posix.basename(normalized);
  if (generatedNames.has(base)) return true;
  if (generatedPrefixes.some(prefix => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`))) return true;
  return generatedSuffixes.some(suffix => normalized.endsWith(suffix));
}

export function isTestFilePath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^(?:test|tests|__tests__|e2e|spec)\//i.test(normalized) || /\/(?:test|tests|__tests__|e2e)\//i.test(normalized)) {
    return true;
  }
  return /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go|^test_.*\.py|.*_test\.py)$/i.test(path.posix.basename(normalized));
}

interface RiskRule {
  category: RiskCategory;
  label: string;
  severity: 'high' | 'medium';
  pathPattern?: RegExp;
  linePattern?: RegExp;
  excludeTestForMedium?: boolean;
  reason: string;
}

const riskRules: RiskRule[] = [
  {
    category: 'secret-hygiene',
    label: '疑似硬编码凭据/密钥字面量',
    severity: 'high',
    linePattern: /(?:api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"`][A-Za-z0-9+/=._-]{12,}['"`]/i,
    excludeTestForMedium: false,
    reason: '新增行包含疑似硬编码敏感凭据赋值，须核对是否为真实密钥或测试夹具假值',
  },
  {
    category: 'auth-permission',
    label: '鉴权/权限/会话边界',
    severity: 'high',
    pathPattern: /(?:^|\/)(?:auth|login|oauth|sso|session|permission|rbac|acl|security|token|guard|credential)[^/]*$/i,
    linePattern: /\b(?:authorize|authentication|hasPermission|checkPermission|verifyToken|jwt|bearer|x-yunxiao-token|csrf|cors|set-cookie|sudo|chmod\s+0?777)\b/i,
    reason: '涉及身份认证、令牌处理或权限门禁逻辑变更',
  },
  {
    category: 'command-fs',
    label: '进程执行/文件删除/动态求值',
    severity: 'high',
    linePattern: /\b(?:execFile|execSync|spawnSync|child_process\.exec|rmSync|fs\.rm\s*\(|unlinkSync|new\s+Function\s*\(|eval\s*\()\b/,
    reason: '涉及子进程执行、文件系统删除或动态代码求值，须核查参数注入、超时与目录越界保护',
  },
  {
    category: 'route-exposure',
    label: '接口路由/网关/外部转发',
    severity: 'medium',
    pathPattern: /(?:^|\/)(?:routes?|router|gateway|proxy|webhook|middleware|controller)[^/]*$/i,
    linePattern: /\b(?:app\.(?:get|post|put|delete|patch|use)|router\.(?:get|post|put|delete|patch)|createServer|webhook|proxy)\b/,
    excludeTestForMedium: true,
    reason: '涉及服务端路由暴露、中间件或外部请求代理边界',
  },
  {
    category: 'concurrency-state',
    label: '并发锁/租约/事务状态流转',
    severity: 'medium',
    pathPattern: /(?:^|\/)(?:lock|lease|mutex|queue|scheduler|transaction|reconcil)[^/]*$/i,
    linePattern: /\b(?:acquireLease|releaseLease|withProjectGitLock|fencingToken|mutex|transaction|BEGIN\s+IMMEDIATE|idempoten|race\b)/i,
    excludeTestForMedium: true,
    reason: '涉及并发互斥、租约对账或事务状态一致性逻辑',
  },
  {
    category: 'schema-config',
    label: '数据结构/迁移/环境配置契约',
    severity: 'medium',
    pathPattern: /(?:^|\/)(?:migrations?|schema|\.env\.example|Dockerfile|docker-compose|tsconfig|vite\.config|package\.json)[^/]*$/i,
    linePattern: /\b(?:ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+INDEX|process\.env\.[A-Z0-9_]+)\b/,
    excludeTestForMedium: true,
    reason: '涉及持久化 Schema、构建依赖或运行环境变量契约变更',
  },
];

function skeletonizeCodeLine(line: string) {
  return line
    .slice(0, 240)
    .trim()
    .replace(/['"`][^'"`]*['"`]/g, 'STR')
    .replace(/\b\d+\b/g, 'NUM')
    .replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, token => (
      ['import', 'from', 'export', 'const', 'let', 'var', 'function', 'async', 'await', 'return', 'if', 'else', 'throw', 'new', 'type', 'interface'].includes(token)
        ? token
        : 'ID'
    ))
    .replace(/\s+/g, ' ');
}

function computeShapeSignature(filePath: string, status: DiffFileStatus, hunks: ParsedDiffHunk[]) {
  const ext = path.posix.extname(filePath).toLowerCase() || 'noext';
  const topDir = filePath.includes('/') ? filePath.split('/')[0]! : 'root';
  const changedSkeletons: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === 'add' || line.kind === 'del') && line.content.trim()) {
        changedSkeletons.push(`${line.kind === 'add' ? '+' : '-'}${skeletonizeCodeLine(line.content)}`);
        if (changedSkeletons.length >= 6) break;
      }
    }
    if (changedSkeletons.length >= 6) break;
  }
  return `${topDir}|${ext}|${status}|${changedSkeletons.join(';') || 'empty'}`;
}

function parseUnifiedDiffFiles(patch: string): AnalyzedDiffFile[] {
  if (!patch.trim()) return [];
  const rawLines = patch.split('\n');
  const files: AnalyzedDiffFile[] = [];
  let index = 0;

  while (index < rawLines.length) {
    const line = rawLines[index]!;
    if (!line.startsWith('diff --git ')) {
      index += 1;
      continue;
    }

    const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    let oldPath = headerMatch ? normalizeDiffPath(headerMatch[1]!) : '';
    let newPath = headerMatch ? normalizeDiffPath(headerMatch[2]!) : '';
    let status: DiffFileStatus = 'modified';
    let binary = false;
    const hunks: ParsedDiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    index += 1;

    while (index < rawLines.length && !rawLines[index]!.startsWith('diff --git ')) {
      const current = rawLines[index]!;
      if (current.startsWith('new file mode ')) {
        status = 'added';
      } else if (current.startsWith('deleted file mode ')) {
        status = 'deleted';
      } else if (current.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = normalizeDiffPath(current.slice('rename from '.length));
      } else if (current.startsWith('rename to ')) {
        status = 'renamed';
        newPath = normalizeDiffPath(current.slice('rename to '.length));
      } else if (current.startsWith('--- ')) {
        const parsed = normalizeDiffPath(current.slice(4));
        if (parsed) oldPath = parsed;
      } else if (current.startsWith('+++ ')) {
        const parsed = normalizeDiffPath(current.slice(4));
        if (parsed) newPath = parsed;
      } else if (current.startsWith('Binary files ') || current.startsWith('GIT binary patch')) {
        binary = true;
      } else if (current.startsWith('@@ ')) {
        const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(current);
        if (hunkMatch) {
          let oldLine = Number(hunkMatch[1]);
          const oldLines = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
          let newLine = Number(hunkMatch[3]);
          const newLines = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
          const hunk: ParsedDiffHunk = {
            header: current,
            oldStart: oldLine,
            oldLines,
            newStart: newLine,
            newLines,
            lines: [],
          };
          index += 1;
          while (index < rawLines.length) {
            const hunkLine = rawLines[index]!;
            if (hunkLine.startsWith('diff --git ') || hunkLine.startsWith('@@ ')) break;
            if (hunkLine.startsWith('+')) {
              additions += 1;
              hunk.lines.push({ kind: 'add', oldLine: null, newLine, content: hunkLine.slice(1) });
              newLine += 1;
            } else if (hunkLine.startsWith('-')) {
              deletions += 1;
              hunk.lines.push({ kind: 'del', oldLine, newLine: null, content: hunkLine.slice(1) });
              oldLine += 1;
            } else if (hunkLine.startsWith('\\')) {
              hunk.lines.push({ kind: 'meta', oldLine: null, newLine: null, content: hunkLine });
            } else {
              const content = hunkLine.startsWith(' ') ? hunkLine.slice(1) : hunkLine;
              hunk.lines.push({ kind: 'context', oldLine, newLine, content });
              oldLine += 1;
              newLine += 1;
            }
            index += 1;
          }
          hunks.push(hunk);
          continue;
        }
      }
      index += 1;
    }

    const effectivePath = newPath || oldPath;
    if (!effectivePath) continue;
    const generated = isGeneratedOrNoiseFile(effectivePath);
    const isTest = !generated && isTestFilePath(effectivePath);
    files.push({
      path: effectivePath,
      ...(status === 'renamed' && oldPath && oldPath !== effectivePath ? { oldPath } : {}),
      status,
      binary,
      generated,
      isTest,
      additions,
      deletions,
      riskCategories: [],
      shapeSignature: generated ? 'generated' : computeShapeSignature(effectivePath, status, hunks),
      hunks,
    });
  }

  return files;
}

function detectRisksForFiles(files: AnalyzedDiffFile[], maxRisks = 25): DeterministicRiskHit[] {
  const hits: DeterministicRiskHit[] = [];
  for (const file of files) {
    if (file.generated || file.binary) continue;
    const categories = new Set<RiskCategory>();

    for (const rule of riskRules) {
      if (rule.excludeTestForMedium && file.isTest) continue;
      let matchedForRule = false;

      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind !== 'add') continue;
          const bounded = line.content.slice(0, 500);
          if (rule.linePattern?.test(bounded)) {
            categories.add(rule.category);
            matchedForRule = true;
            if (hits.length < maxRisks) {
              hits.push({
                category: rule.category,
                label: rule.label,
                severity: rule.severity,
                file: file.path,
                line: line.newLine,
                reason: rule.reason,
                snippet: bounded.trim().slice(0, 160),
              });
            }
            break;
          }
        }
        if (matchedForRule) break;
      }

      if (!matchedForRule && rule.pathPattern?.test(file.path)) {
        categories.add(rule.category);
        if (hits.length < maxRisks) {
          const firstChangedLine = file.hunks[0]?.lines.find(item => item.kind === 'add')?.newLine
            ?? file.hunks[0]?.newStart
            ?? null;
          hits.push({
            category: rule.category,
            label: rule.label,
            severity: rule.severity,
            file: file.path,
            line: firstChangedLine,
            reason: rule.reason,
            snippet: `${file.status} (${file.additions}+ / ${file.deletions}-)`,
          });
        }
      }
    }

    file.riskCategories = [...categories];
  }

  return hits.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'high' ? -1 : 1;
    return left.file.localeCompare(right.file);
  });
}

function buildSamplingPlan(files: AnalyzedDiffFile[], threshold = 30): LargeDiffSamplingPlan {
  const reviewable = files.filter(file => !file.generated);
  if (reviewable.length <= threshold) {
    return {
      triggered: false,
      totalFiles: files.length,
      mandatoryFiles: reviewable.filter(file => file.riskCategories.length > 0).map(file => file.path),
      sampledMechanicalFiles: [],
      clusters: [],
    };
  }

  const bySignature = new Map<string, AnalyzedDiffFile[]>();
  for (const file of reviewable) {
    const bucket = bySignature.get(file.shapeSignature) || [];
    bucket.push(file);
    bySignature.set(file.shapeSignature, bucket);
  }

  const mandatory = new Set<string>();
  const sampled = new Set<string>();
  const clusters: MechanicalCluster[] = [];
  let clusterIndex = 0;

  for (const [signature, group] of [...bySignature.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sortedPaths = group.map(item => item.path).sort();
    const riskyInGroup = group.filter(item => item.riskCategories.length > 0).map(item => item.path);
    for (const riskyPath of riskyInGroup) mandatory.add(riskyPath);

    // 少于 3 个相似改动视为独立/非机械例外改动，必须全审。
    if (group.length < 3) {
      for (const item of sortedPaths) mandatory.add(item);
      continue;
    }

    clusterIndex += 1;
    const sampleCount = Math.max(1, Math.ceil(sortedPaths.length * 0.1));
    const step = Math.max(1, Math.floor(sortedPaths.length / sampleCount));
    const clusterSamples: string[] = [];
    for (let i = 0; i < sortedPaths.length && clusterSamples.length < sampleCount; i += step) {
      clusterSamples.push(sortedPaths[i]!);
      sampled.add(sortedPaths[i]!);
    }
    const [topDir, ext, status] = signature.split('|');
    clusters.push({
      id: `M-${clusterIndex}`,
      description: `${topDir}/ 下 ${ext} 文件同类 ${status} 变换`,
      count: sortedPaths.length,
      representative: sortedPaths[0]!,
      sampledFiles: clusterSamples,
      files: sortedPaths,
    });
  }

  return {
    triggered: true,
    totalFiles: files.length,
    mandatoryFiles: [...mandatory].sort(),
    sampledMechanicalFiles: [...sampled].filter(item => !mandatory.has(item)).sort(),
    clusters,
  };
}

function renderAnnotatedFilePatch(file: AnalyzedDiffFile, maxLinesPerFile = 180): string {
  const headerParts = [
    `## ${file.path}`,
    file.oldPath ? `(renamed from ${file.oldPath})` : '',
    `[${file.status} +${file.additions}/-${file.deletions}]`,
    file.riskCategories.length ? `[risk: ${file.riskCategories.join(',')}]` : '',
  ].filter(Boolean);

  if (file.generated) {
    return `${headerParts.join(' ')}\n  (生成物/锁文件已折叠，净改动 +${file.additions}/-${file.deletions})\n`;
  }
  if (file.binary) {
    return `${headerParts.join(' ')}\n  (二进制文件变更)\n`;
  }

  const out: string[] = [headerParts.join(' ')];
  let renderedLines = 0;
  let omittedLines = 0;

  for (const hunk of file.hunks) {
    if (renderedLines >= maxLinesPerFile) {
      omittedLines += hunk.lines.length;
      continue;
    }
    out.push(hunk.header);
    for (const line of hunk.lines) {
      if (renderedLines >= maxLinesPerFile) {
        omittedLines += 1;
        continue;
      }
      renderedLines += 1;
      if (line.kind === 'add') {
        out.push(`${String(line.newLine ?? '').padStart(5, ' ')} + ${line.content}`);
      } else if (line.kind === 'del') {
        out.push(`      - ${line.content}`);
      } else if (line.kind === 'context') {
        out.push(`${String(line.newLine ?? '').padStart(5, ' ')}   ${line.content}`);
      } else {
        out.push(`        ${line.content}`);
      }
    }
  }

  if (omittedLines > 0) {
    out.push(`  ... [当前文件其余 ${omittedLines} 行 diff 已折叠，需要时请直接读取工作区源文件 ${file.path}]`);
  }
  return `${out.join('\n')}\n`;
}

function buildFocusedPatch(
  files: AnalyzedDiffFile[],
  samplingPlan: LargeDiffSamplingPlan,
  maxFocusedBytes: number,
): { focusedPatch: string; truncated: boolean } {
  if (!files.length) return { focusedPatch: '', truncated: false };
  const mandatorySet = new Set(samplingPlan.mandatoryFiles);
  const sampledSet = new Set(samplingPlan.sampledMechanicalFiles);

  const priority = (file: AnalyzedDiffFile) => {
    if (file.generated) return 5;
    if (file.riskCategories.length > 0) return 0;
    if (mandatorySet.has(file.path)) return 1;
    if (!file.isTest && (!samplingPlan.triggered || sampledSet.has(file.path))) return 2;
    if (file.isTest) return 3;
    return 4;
  };

  const ordered = [...files].sort((left, right) => {
    const diff = priority(left) - priority(right);
    return diff !== 0 ? diff : left.path.localeCompare(right.path);
  });

  const chunks: string[] = [
    '# 聚焦审查补丁（左侧数字为新文件精确行号，供定位 findings[].line 使用）\n',
  ];
  let usedBytes = Buffer.byteLength(chunks[0]!, 'utf8');
  let truncated = false;
  const skippedFiles: string[] = [];

  for (const file of ordered) {
    if (samplingPlan.triggered && priority(file) === 4) {
      skippedFiles.push(`${file.path} (+${file.additions}/-${file.deletions})`);
      continue;
    }
    const block = renderAnnotatedFilePatch(file);
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (usedBytes + blockBytes > maxFocusedBytes) {
      truncated = true;
      skippedFiles.push(`${file.path} (+${file.additions}/-${file.deletions})`);
      continue;
    }
    chunks.push(block);
    usedBytes += blockBytes;
  }

  if (skippedFiles.length > 0) {
    truncated = true;
    chunks.push(
      `\n# 其余 ${skippedFiles.length} 个文件未展开进聚焦补丁（完整原始补丁见 diff.patch 或工作区文件）：\n`
        + skippedFiles.slice(0, 40).map(item => `- ${item}`).join('\n')
        + (skippedFiles.length > 40 ? `\n- ... 等共 ${skippedFiles.length} 个文件` : '')
        + '\n',
    );
  }

  return { focusedPatch: chunks.join('\n'), truncated };
}

export function analyzeUnifiedDiff(
  patch: string,
  options: { focusFiles?: string[]; maxFocusedBytes?: number; samplingThreshold?: number } = {},
): DiffTriageAnalysis {
  const allParsed = parseUnifiedDiffFiles(patch);
  const focusSet = options.focusFiles?.length
    ? new Set(options.focusFiles.map(item => item.replace(/\\/g, '/').replace(/^\.\//, '')))
    : undefined;
  const scoped = focusSet ? allParsed.filter(file => focusSet.has(file.path) || (file.oldPath && focusSet.has(file.oldPath))) : allParsed;
  const risks = detectRisksForFiles(scoped);
  const samplingPlan = buildSamplingPlan(scoped, options.samplingThreshold ?? 30);
  const { focusedPatch, truncated } = buildFocusedPatch(scoped, samplingPlan, options.maxFocusedBytes ?? 48_000);

  return {
    totals: {
      files: scoped.length,
      sourceFiles: scoped.filter(file => !file.generated && !file.isTest).length,
      testFiles: scoped.filter(file => file.isTest).length,
      generatedFiles: scoped.filter(file => file.generated).length,
      binaryFiles: scoped.filter(file => file.binary).length,
      additions: scoped.reduce((sum, file) => sum + file.additions, 0),
      deletions: scoped.reduce((sum, file) => sum + file.deletions, 0),
    },
    files: scoped.map(({ hunks: _hunks, shapeSignature: _sig, ...rest }) => rest),
    risks,
    generatedPaths: scoped.filter(file => file.generated).map(file => file.path),
    samplingPlan,
    focusedPatch,
    focusedPatchTruncated: truncated,
  };
}

export function formatDiffTriageForPrompt(triage: DiffTriageAnalysis): string {
  if (!triage.totals.files) return '';
  const lines: string[] = [
    `Diff 预筛摘要：共改动 ${triage.totals.files} 个文件（源码 ${triage.totals.sourceFiles}、测试 ${triage.totals.testFiles}、生成物/锁文件 ${triage.totals.generatedFiles}），净增删 +${triage.totals.additions} / -${triage.totals.deletions} 行。`,
  ];

  if (triage.totals.sourceFiles > 0 && triage.totals.testFiles === 0) {
    lines.push('⚠️ 测试覆盖提示：本次源码有变更但未检测到测试文件修改，请重点核对现有测试是否已覆盖新分支与边界，或是否存在验证缺口。');
  }

  if (triage.generatedPaths.length > 0) {
    lines.push(`已识别生成物/锁文件（${triage.generatedPaths.length} 个，无需逐行纠结格式，仅核对依赖/构建合理性）：${triage.generatedPaths.slice(0, 8).join('、')}${triage.generatedPaths.length > 8 ? ' 等' : ''}。`);
  }

  if (triage.risks.length > 0) {
    lines.push('确定性高危扫描命中点（预筛线索，请结合真实代码上下文独立核实，不盲目误报）：');
    for (const risk of triage.risks.slice(0, 10)) {
      const loc = risk.line ? `${risk.file}:${risk.line}` : risk.file;
      lines.push(`- [${risk.severity.toUpperCase()} · ${risk.label}] ${loc} — ${risk.reason}`);
    }
    if (triage.risks.length > 10) lines.push(`- ... 另有 ${triage.risks.length - 10} 处风险线索见 diff-triage.json`);
  }

  if (triage.samplingPlan.triggered) {
    lines.push(
      `大规模改动分层指引（共 ${triage.samplingPlan.totalFiles} 个文件 > 30）：`
      + `全审非机械/高危例外文件（${triage.samplingPlan.mandatoryFiles.length} 个）：${triage.samplingPlan.mandatoryFiles.slice(0, 15).join('、')}${triage.samplingPlan.mandatoryFiles.length > 15 ? ' 等' : ''}；`
      + `机械同类聚类 ${triage.samplingPlan.clusters.length} 组，建议代表性抽样（${triage.samplingPlan.sampledMechanicalFiles.length} 个）：${triage.samplingPlan.sampledMechanicalFiles.slice(0, 12).join('、')}${triage.samplingPlan.sampledMechanicalFiles.length > 12 ? ' 等' : ''}。`,
    );
  }

  return lines.join('\n');
}

function normalizeFindingKey(finding: Pick<AgentTaskFinding, 'file' | 'severity' | 'problem'>) {
  const file = (finding.file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const problem = (finding.problem || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\bline\s+\d+\b|第\s*\d+\s*行/g, '')
    .slice(0, 120);
  return `${file}::${finding.severity}::${problem}`;
}

const severityWeight: Record<AgentTaskFinding['severity'], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

export function buildCrossRoundFindingLedger(
  priorReviews: PriorReviewSnapshot[],
  options: { modifiedSinceLastReview?: string[] } = {},
): CrossRoundFindingLedger | undefined {
  const rejected = priorReviews
    .filter(item => item.findings.length > 0 || (item.failedCriteria?.length ?? 0) > 0 || (item.blockers?.length ?? 0) > 0)
    .sort((left, right) => left.round - right.round);
  if (!rejected.length) return undefined;

  const latestRejected = rejected.at(-1)!;
  const modifiedSet = new Set(
    (options.modifiedSinceLastReview || []).map(item => item.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean),
  );

  // 统计所有历史轮次中各问题的首次轮次与重复出现次数，重点追踪最新一轮退回仍未决的问题。
  const historyStats = new Map<string, { firstRound: number; count: number }>();
  for (const review of rejected) {
    const seenInRound = new Set<string>();
    for (const finding of review.findings) {
      const key = normalizeFindingKey(finding);
      if (seenInRound.has(key)) continue;
      seenInRound.add(key);
      const current = historyStats.get(key);
      if (!current) historyStats.set(key, { firstRound: review.round, count: 1 });
      else current.count += 1;
    }
  }

  const tracked: TrackedReviewFinding[] = [];
  const seenLatest = new Set<string>();
  for (const finding of latestRejected.findings) {
    const key = normalizeFindingKey(finding);
    if (seenLatest.has(key)) continue;
    seenLatest.add(key);
    const stats = historyStats.get(key) || { firstRound: latestRejected.round, count: 1 };
    const normalizedFile = (finding.file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const fileState: TrackedReviewFinding['fileState'] = !normalizedFile
      ? 'no_file_target'
      : modifiedSet.has(normalizedFile)
        ? 'modified_since_last_review'
        : 'unchanged_since_last_review';

    tracked.push({
      fingerprint: key,
      latestId: finding.id,
      severity: finding.severity,
      file: normalizedFile,
      line: finding.line ?? null,
      problem: finding.problem,
      expectation: finding.expectation,
      firstSeenRound: stats.firstRound,
      lastSeenRound: latestRejected.round,
      occurrences: stats.count,
      fileState,
    });
  }

  tracked.sort((left, right) => {
    const sev = severityWeight[left.severity] - severityWeight[right.severity];
    if (sev !== 0) return sev;
    if (left.fileState !== right.fileState) {
      return left.fileState === 'unchanged_since_last_review' ? -1 : 1;
    }
    return left.file.localeCompare(right.file);
  });

  return {
    previousRound: latestRejected.round,
    totalOpenFindings: tracked.length,
    blockerCount: tracked.filter(item => item.severity === 'blocker').length,
    untouchedFileFindings: tracked.filter(item => item.fileState === 'unchanged_since_last_review').length,
    repeatedFindings: tracked.filter(item => item.occurrences > 1).length,
    failedCriteria: latestRejected.failedCriteria || [],
    blockers: (latestRejected.blockers || []).filter(Boolean),
    items: tracked,
  };
}

export function formatFindingLedgerForPrompt(ledger: CrossRoundFindingLedger | undefined): string {
  if (!ledger) return '';
  const header = [
    `跨轮次审查状态追踪（前序第 ${ledger.previousRound} 轮退回共 ${ledger.totalOpenFindings} 个问题`
      + `${ledger.blockerCount ? `，含 ${ledger.blockerCount} 个 blocker` : ''}`
      + `${ledger.untouchedFileFindings ? `，其中 ${ledger.untouchedFileFindings} 个问题所在文件在本轮未发生改动` : ''}）：`,
    '请逐项独立复核前序问题：在 taskResult.summary 中简明交代前序问题复核结论（已修复 / 仍未解决 / 修复引入新问题）；凡未真正解决的问题必须继续保留在 taskResult.findings 中，不能因轮次推进而遗漏。',
  ];

  for (const item of ledger.items.slice(0, 20)) {
    const loc = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '全局/未指定文件';
    const stateTag = item.fileState === 'unchanged_since_last_review'
      ? '⚠️该文件本轮未改动，重点核查是否漏修'
      : item.fileState === 'modified_since_last_review'
        ? '该文件本轮已修改，核验修复完整性与回归'
        : '核验整体处理结果';
    const repeatTag = item.occurrences > 1 ? `（连续 ${item.occurrences} 轮未过）` : '';
    header.push(`- [${item.latestId} · ${item.severity}] ${loc}${repeatTag}（${stateTag}）：${item.problem} ｜ 期望：${item.expectation}`);
  }
  if (ledger.items.length > 20) {
    header.push(`- ... 其余 ${ledger.items.length - 20} 条前序问题详见审查材料 finding-ledger.json`);
  }
  if (ledger.failedCriteria.length > 0) {
    header.push(`- 前序未通过的审查验收项：${ledger.failedCriteria.map(item => `${item.id}(${item.status})`).join('、')}`);
  }
  return header.join('\n');
}

function inferChangeCategory(
  sourceBranch: string,
  commits: { sha: string; subject: string }[],
  triage: DiffTriageAnalysis,
): string {
  const combined = `${sourceBranch} ${commits.map(item => item.subject).join(' ')}`;
  const categories: string[] = [];
  if (/(?:^|\/|\b)(?:fix|bugfix|hotfix)\b|修复|缺陷|问题/i.test(combined)) categories.push('缺陷修复');
  if (/(?:^|\/|\b)(?:feat|feature)\b|新增|支持|实现|功能/i.test(combined)) categories.push('功能开发');
  if (/(?:^|\/|\b)(?:refactor|perf|clean)\b|重构|优化|收敛/i.test(combined)) categories.push('重构与优化');
  if (triage.totals.testFiles > 0 && triage.totals.sourceFiles === 0) categories.push('测试补充');
  if (!categories.length) categories.push(triage.totals.sourceFiles > 0 ? '代码变更' : '工程与文档更新');
  return categories.join(' / ');
}

const statusLabels: Record<DiffFileStatus, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
};

const riskCategoryShortLabels: Record<RiskCategory, string> = {
  'auth-permission': '鉴权/权限',
  'route-exposure': '路由/接口',
  'concurrency-state': '并发/锁',
  'command-fs': '命令/文件',
  'schema-config': '配置/Schema',
  'secret-hygiene': '凭据检查',
};

export interface BuildMergeRequestDescriptionInput {
  sourceBranch: string;
  targetBranch: string;
  commits?: { sha: string; subject: string }[];
  patch?: string;
  triage?: DiffTriageAnalysis;
  issue?: { key: string; summary?: string };
  verifiedHead?: string;
  mode?: 'full' | 'compact';
}

export function buildStructuredMergeRequestDescription(input: BuildMergeRequestDescriptionInput): string {
  const mode = input.mode || 'full';
  const maxChars = mode === 'compact' ? 1100 : 8000;
  const commits = input.commits || [];
  const triage = input.triage || analyzeUnifiedDiff(input.patch || '');
  const sections: string[] = [];

  if (input.issue?.key || input.verifiedHead) {
    const meta: string[] = [];
    if (input.issue?.key) {
      meta.push(`关联 Jira：${input.issue.key}${input.issue.summary ? `（${input.issue.summary.replace(/[\r\n]+/g, ' ').trim()}）` : ''}`);
    }
    if (input.verifiedHead) {
      meta.push(`已验证并回读的源提交：${input.verifiedHead}`);
    }
    sections.push(meta.join('\n\n'));
  }

  if (!triage.totals.files && !commits.length) {
    return sections.join('\n\n').slice(0, maxChars);
  }

  const category = inferChangeCategory(input.sourceBranch, commits, triage);
  const overviewLines = [
    '### 变更概览',
    `- **变更性质**：${category}（\`${input.sourceBranch}\` → \`${input.targetBranch}\`）`,
  ];
  if (triage.totals.files > 0) {
    overviewLines.push(
      `- **改动规模**：净改动 ${triage.totals.files} 个文件（+${triage.totals.additions} / -${triage.totals.deletions} 行`
      + `${triage.totals.testFiles ? `，含 ${triage.totals.testFiles} 个测试文件` : ''}）`,
    );
  }
  if (commits.length > 0) {
    overviewLines.push(`- **包含提交**：${commits.length} 个提交`);
  }
  sections.push(overviewLines.join('\n'));

  const nonGenerated = triage.files.filter(file => !file.generated);
  if (nonGenerated.length > 0) {
    const orderedFiles = [...nonGenerated].sort((left, right) => {
      if (left.riskCategories.length !== right.riskCategories.length) {
        return right.riskCategories.length - left.riskCategories.length;
      }
      if (left.isTest !== right.isTest) return left.isTest ? 1 : -1;
      return (right.additions + right.deletions) - (left.additions + left.deletions);
    });

    if (mode === 'compact') {
      const limit = 6;
      const items = orderedFiles.slice(0, limit).map(file => {
        const delta = file.binary ? '二进制' : `+${file.additions}/-${file.deletions}`;
        return `- \`${file.path}\`（${statusLabels[file.status]}，${delta}）`;
      });
      if (orderedFiles.length > limit) items.push(`- 其余 ${orderedFiles.length - limit} 个文件详见平台 Diff`);
      sections.push(['### 主要改动文件', ...items].join('\n'));
    } else {
      const limit = 15;
      const table = [
        '### 改动文件 Walkthrough',
        '| 文件 | 变更 | 行数变化 | 关注标签 |',
        '| :--- | :--- | :--- | :--- |',
      ];
      for (const file of orderedFiles.slice(0, limit)) {
        const safePath = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
        const delta = file.binary ? '二进制' : `+${file.additions} / -${file.deletions}`;
        const tags = [
          ...file.riskCategories.map(cat => riskCategoryShortLabels[cat]),
          ...(file.isTest ? ['测试'] : []),
        ];
        table.push(`| \`${safePath.replace(/\|/g, '\\|')}\` | ${statusLabels[file.status]} | ${delta} | ${tags.join('、') || '常规'} |`);
      }
      if (orderedFiles.length > limit) {
        table.push(`\n> 其余 ${orderedFiles.length - limit} 个源码/测试文件已省略，请在合并请求 Diff 视图查看完整列表。`);
      }
      if (triage.generatedPaths.length > 0) {
        table.push(`\n> 另含 ${triage.generatedPaths.length} 个生成物/锁文件变更：${triage.generatedPaths.slice(0, 5).map(p => `\`${p}\``).join('、')}${triage.generatedPaths.length > 5 ? ' 等' : ''}。`);
      }
      sections.push(table.join('\n'));
    }
  }

  if (mode === 'full' && commits.length > 0) {
    const commitLines = ['### 提交脉络'];
    for (const commit of commits.slice(0, 8)) {
      const cleanSubject = commit.subject.replace(/[\r\n]+/g, ' ').trim();
      commitLines.push(`- \`${commit.sha.slice(0, 8)}\` ${cleanSubject}`);
    }
    if (commits.length > 8) commitLines.push(`- ... 共 ${commits.length} 条提交`);
    sections.push(commitLines.join('\n'));
  }

  const focusPoints: string[] = [];
  for (const risk of triage.risks.slice(0, mode === 'compact' ? 2 : 5)) {
    const loc = risk.line ? `\`${risk.file}:${risk.line}\`` : `\`${risk.file}\``;
    focusPoints.push(`- **${risk.label}**（${loc}）：${risk.reason}`);
  }
  if (triage.totals.sourceFiles > 0 && triage.totals.testFiles === 0) {
    focusPoints.push('- **测试核对**：本次包含源码改动但无测试文件变更，建议审核人确认边界用例覆盖。');
  }
  if (focusPoints.length > 0) {
    sections.push(['### 审查关注点', ...focusPoints].join('\n'));
  }

  const result = sections.join('\n\n');
  return result.length <= maxChars ? result : `${result.slice(0, maxChars - 24).trimEnd()}\n\n...(内容已按长度上限截断)`;
}

export interface MergeDiffTriageSummary {
  sourceFiles: number;
  testFiles: number;
  generatedFiles: number;
  missingTestsWarning: boolean;
  largeDiffTriggered: boolean;
  risks: {
    category: RiskCategory;
    label: string;
    severity: 'high' | 'medium';
    file: string;
    line: number | null;
    reason: string;
  }[];
}

export function summarizeDiffTriage(triage: DiffTriageAnalysis): MergeDiffTriageSummary {
  return {
    sourceFiles: triage.totals.sourceFiles,
    testFiles: triage.totals.testFiles,
    generatedFiles: triage.totals.generatedFiles,
    missingTestsWarning: triage.totals.sourceFiles > 0 && triage.totals.testFiles === 0,
    largeDiffTriggered: triage.samplingPlan.triggered,
    risks: triage.risks.slice(0, 12).map(risk => ({
      category: risk.category,
      label: risk.label,
      severity: risk.severity,
      file: risk.file,
      line: risk.line,
      reason: risk.reason,
    })),
  };
}

export interface DiscoveredGuidelineFile {
  path: string;
  scope: string;
  bytes: number;
  truncated: boolean;
  excerpt: string;
}

export interface RepositoryGuidelinesBundle {
  files: DiscoveredGuidelineFile[];
  totalBytes: number;
  markdown: string;
}

const rootGuidelineCandidates = [
  'AGENTS.md',
  'CLAUDE.md',
  'best_practices.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
] as const;

const directoryGuidelineNames = ['AGENTS.md', 'CLAUDE.md', 'best_practices.md'] as const;
const excludedGuidelineDirSegments = new Set([
  '.git',
  'node_modules',
  '.delivery-artifacts',
  '.local',
  '.data',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
]);

function redactGuidelineText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|glpat-[\w-]+|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/g, '[redacted]')
    .replace(/本岗位只读|只读岗位不得写入|只读分析与计划，不改文件|当前未开放联网工具|只读独立审查|本轮只读判断/g, '按受控范围执行');
}

async function readSafeWorkspaceGuideline(realRoot: string, relativePosixPath: string): Promise<{ bytes: number; text: string } | null> {
  const segments = relativePosixPath.split('/').filter(Boolean);
  if (!segments.length || segments.some(seg => seg === '.' || seg === '..')) return null;

  let current = realRoot;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]!);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return null;
    if (i < segments.length - 1 && !stat.isDirectory()) return null;
    if (i === segments.length - 1) {
      if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024) return null;
      const resolved = await fs.realpath(current).catch(() => '');
      if (!resolved || !resolved.startsWith(`${realRoot}${path.sep}`)) return null;
      const buffer = await fs.readFile(resolved).catch(() => null);
      if (!buffer || buffer.subarray(0, 4096).includes(0)) return null;
      const cleaned = redactGuidelineText(buffer.toString('utf8')).replace(/\r\n/g, '\n').trim();
      if (!cleaned) return null;
      return { bytes: stat.size, text: cleaned };
    }
  }
  return null;
}

/**
 * 自动发现仓库根目录及本次改动文件祖先目录上的工程规范（借鉴 PR-Agent repo_context / best_practices 机制）。
 * 严格校验真实路径并拒绝符号链接穿越与超大/二进制文件。
 */
export async function discoverRepositoryGuidelines(
  workspacePath: string,
  changedFiles: string[] = [],
): Promise<RepositoryGuidelinesBundle> {
  const empty: RepositoryGuidelinesBundle = { files: [], totalBytes: 0, markdown: '' };
  if (!workspacePath || typeof workspacePath !== 'string') return empty;
  const realRoot = await fs.realpath(workspacePath).catch(() => '');
  if (!realRoot) return empty;
  const rootStat = await fs.stat(realRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return empty;

  const ancestorDirs = new Set<string>();
  for (const rawFile of changedFiles) {
    const normalized = (rawFile || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!normalized) continue;
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1 || parts.some(part => part === '..' || excludedGuidelineDirSegments.has(part))) continue;
    for (let depth = 1; depth < parts.length && depth <= 5; depth += 1) {
      ancestorDirs.add(parts.slice(0, depth).join('/'));
    }
  }

  const orderedDirs = [...ancestorDirs]
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
    .slice(0, 12);

  const candidates: { relPath: string; scope: string }[] = [
    ...rootGuidelineCandidates.map(relPath => ({ relPath, scope: '仓库全局' })),
    ...orderedDirs.flatMap(dir => directoryGuidelineNames.map(name => ({
      relPath: `${dir}/${name}`,
      scope: `目录 ${dir}/**`,
    }))),
  ];

  const maxFiles = 6;
  const maxPerFileChars = 4000;
  const maxTotalChars = 12_000;
  const discovered: DiscoveredGuidelineFile[] = [];
  const seenPaths = new Set<string>();
  let usedChars = 0;
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (discovered.length >= maxFiles || usedChars >= maxTotalChars) break;
    if (seenPaths.has(candidate.relPath)) continue;
    seenPaths.add(candidate.relPath);
    const loaded = await readSafeWorkspaceGuideline(realRoot, candidate.relPath);
    if (!loaded) continue;
    const budget = Math.min(maxPerFileChars, maxTotalChars - usedChars);
    if (budget < 120) break;
    const truncated = loaded.text.length > budget;
    const excerpt = truncated ? `${loaded.text.slice(0, budget).trimEnd()}\n...(规范内容已按上限截断)` : loaded.text;
    discovered.push({
      path: candidate.relPath,
      scope: candidate.scope,
      bytes: loaded.bytes,
      truncated,
      excerpt,
    });
    usedChars += excerpt.length;
    totalBytes += loaded.bytes;
  }

  if (!discovered.length) return empty;

  const sections = [
    '# 仓库与目录工程规范摘要',
    '',
    '> 由工作台自动发现并提取自当前工作区，供独立审查对照遵守仓库既有架构边界、安全与测试约定。',
    '',
    ...discovered.map(file => [
      `## \`${file.path}\`（作用域：${file.scope}${file.truncated ? '，已截断' : ''}）`,
      '',
      file.excerpt,
      '',
    ].join('\n')),
  ];

  return {
    files: discovered,
    totalBytes,
    markdown: sections.join('\n').trimEnd() + '\n',
  };
}

export function formatRepositoryGuidelinesForPrompt(
  bundle: RepositoryGuidelinesBundle | null | undefined,
  options: { inlineMaxChars?: number; artifactHint?: string } = {},
): string {
  if (!bundle || !bundle.files.length) return '';
  const inlineMaxChars = options.inlineMaxChars ?? 2200;
  const hint = options.artifactHint ? `，完整摘录见 ${options.artifactHint}` : '';
  const header = [
    `仓库工程规范自动提示（已发现 ${bundle.files.length} 份规范文件：${bundle.files.map(item => `${item.path}[${item.scope}]`).join('、')}${hint}）：`,
    '审查时请结合以下仓库约定核对架构边界、权限与测试要求；符合仓库明确约定的实现不要误报为缺陷，违反约定的改动须指出具体条款。',
  ];

  let remaining = inlineMaxChars;
  for (const file of bundle.files) {
    if (remaining < 120) break;
    const compact = file.excerpt
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('```'))
      .slice(0, 14)
      .join(' / ');
    if (!compact) continue;
    const budget = Math.min(600, remaining);
    const snippet = compact.length > budget ? `${compact.slice(0, budget)}...` : compact;
    header.push(`- [${file.path} · ${file.scope}] ${snippet}`);
    remaining -= snippet.length;
  }
  return header.join('\n');
}
