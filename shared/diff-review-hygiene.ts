/**
 * 跨前后端共用的提交前 Diff 安全/质量体检、智能中文提交说明生成与审查发现精确 Diff 行锚定纯函数模块。
 * 保持纯 TypeScript 实现（无 Node 专属模块依赖），供服务端 Git/交付网关与前端工作台组件直接复用。
 */
import type { AgentTaskFinding } from './agent-task-result.js';

export type DiffHygieneCategory =
  | 'conflict-markers'
  | 'secret-leak'
  | 'sensitive-file'
  | 'test-focus'
  | 'debug-artifact';

export type DiffHygieneSeverity = 'blocker' | 'warning';

export interface DiffHygieneWarning {
  category: DiffHygieneCategory;
  severity: DiffHygieneSeverity;
  label: string;
  file: string;
  line: number | null;
  reason: string;
  snippet?: string;
}

export interface SmartCommitSuggestion {
  subject: string;
  body: string;
  fullMessage: string;
}

export type FindingDiffAnchorKind =
  | 'diff-line'
  | 'diff-hunk-nearby'
  | 'changed-file'
  | 'repo-file';

export interface AnchoredReviewFinding {
  finding: AgentTaskFinding;
  normalizedFile: string;
  anchorKind: FindingDiffAnchorKind;
  matchedNewLine: number | null;
  matchedOldLine: number | null;
  hunkHeader?: string;
  codeExcerpt?: string;
  suggestedCode?: string;
}

interface LightweightHunkLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

interface LightweightDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: LightweightHunkLine[];
}

interface LightweightDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: LightweightDiffHunk[];
}

function normalizePosixPath(raw: string): string {
  const trimmed = (raw || '').trim().replace(/^"(.*)"$/, '$1');
  if (!trimmed || trimmed === '/dev/null') return '';
  return trimmed
    .replace(/^[ab]\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function posixBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function posixExtname(filePath: string): string {
  const base = posixBasename(filePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizePosixPath(filePath);
  if (/^(?:test|tests|__tests__|e2e|spec)\//i.test(normalized) || /\/(?:test|tests|__tests__|e2e)\//i.test(normalized)) {
    return true;
  }
  return /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go|^test_.*\.py|.*_test\.py)$/i.test(posixBasename(normalized));
}

function isExampleOrTemplateFile(filePath: string): boolean {
  const lower = normalizePosixPath(filePath).toLowerCase();
  return /\.(?:example|sample|template|schema)(?:\.[a-z0-9]+)?$/.test(lower);
}

export function isSensitiveCommitPath(filePath: string): boolean {
  const normalized = normalizePosixPath(filePath);
  if (!normalized) return false;
  const base = posixBasename(normalized);
  const lowerBase = base.toLowerCase();
  if (/^\.env(?:\.|$)/i.test(base) && !isExampleOrTemplateFile(base)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|service-account.*\.json)$/i.test(lowerBase)) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(lowerBase) && !isExampleOrTemplateFile(base)) return true;
  return false;
}

function redactSecretSnippet(line: string): string {
  return line
    .trim()
    .replace(
      /\b(gh[pousr]_|github_pat_|glpat-|sk-(?:proj-)?|AKIA|xox[baprs]-)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g,
      '$1$2...[redacted]',
    )
    .replace(
      /((?:api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|auth[_-]?token|_authToken)\s*[:=]\s*['"`]?)([^\s'"`]{4})[^\s'"`]{6,}/gi,
      '$1$2...[redacted]',
    )
    .slice(0, 140);
}

function parseLightweightDiff(patch: string): LightweightDiffFile[] {
  if (!patch || !patch.trim()) return [];
  const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: LightweightDiffFile[] = [];
  let index = 0;

  while (index < rawLines.length) {
    const line = rawLines[index]!;
    if (!line.startsWith('diff --git ')) {
      index += 1;
      continue;
    }

    const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    let oldPath = headerMatch ? normalizePosixPath(headerMatch[1]!) : '';
    let newPath = headerMatch ? normalizePosixPath(headerMatch[2]!) : '';
    let status: LightweightDiffFile['status'] = 'modified';
    let additions = 0;
    let deletions = 0;
    const hunks: LightweightDiffHunk[] = [];
    index += 1;

    while (index < rawLines.length && !rawLines[index]!.startsWith('diff --git ')) {
      const current = rawLines[index]!;
      if (current.startsWith('new file mode ')) {
        status = 'added';
      } else if (current.startsWith('deleted file mode ')) {
        status = 'deleted';
      } else if (current.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = normalizePosixPath(current.slice('rename from '.length));
      } else if (current.startsWith('rename to ')) {
        status = 'renamed';
        newPath = normalizePosixPath(current.slice('rename to '.length));
      } else if (current.startsWith('--- ')) {
        const parsed = normalizePosixPath(current.slice(4));
        if (parsed) oldPath = parsed;
      } else if (current.startsWith('+++ ')) {
        const parsed = normalizePosixPath(current.slice(4));
        if (parsed) newPath = parsed;
      } else if (current.startsWith('@@ ')) {
        const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(current);
        const oldStart = hunkMatch ? Number(hunkMatch[1]) : 1;
        const oldLines = hunkMatch ? Number(hunkMatch[2] ?? '1') : 0;
        const newStart = hunkMatch ? Number(hunkMatch[3]) : 1;
        const newLines = hunkMatch ? Number(hunkMatch[4] ?? '1') : 0;
        let oldCursor = oldStart;
        let newCursor = newStart;
        const hunkLines: LightweightHunkLine[] = [];
        index += 1;

        while (index < rawLines.length) {
          const hLine = rawLines[index]!;
          if (hLine.startsWith('diff --git ') || hLine.startsWith('@@ ')) break;
          if (hLine.startsWith('\\ No newline at end of file')) {
            index += 1;
            continue;
          }
          if (hLine.startsWith('+')) {
            additions += 1;
            hunkLines.push({ kind: 'add', oldLine: null, newLine: newCursor, content: hLine.slice(1) });
            newCursor += 1;
          } else if (hLine.startsWith('-')) {
            deletions += 1;
            hunkLines.push({ kind: 'del', oldLine: oldCursor, newLine: null, content: hLine.slice(1) });
            oldCursor += 1;
          } else if (hLine.startsWith(' ') || hLine === '') {
            hunkLines.push({
              kind: 'context',
              oldLine: oldCursor,
              newLine: newCursor,
              content: hLine.startsWith(' ') ? hLine.slice(1) : '',
            });
            oldCursor += 1;
            newCursor += 1;
          }
          index += 1;
        }

        hunks.push({
          header: current,
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: hunkLines,
        });
        continue;
      }
      index += 1;
    }

    const effectivePath = newPath || oldPath;
    if (effectivePath) {
      files.push({
        path: effectivePath,
        ...(oldPath && oldPath !== effectivePath ? { oldPath } : {}),
        status,
        additions,
        deletions,
        hunks,
      });
    }
  }

  return files;
}

const privateKeyHeaderPattern = /-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----/;
const knownTokenPrefixPattern = /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|glpat-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const npmAuthTokenPattern = /(?:^|\s)_authToken\s*=\s*(?!\$\{)[A-Za-z0-9._+/=-]{12,}/;
const conflictMarkerPattern = /^(?:<<<<<<<(?: .*)?|=======|>>>>>>>(?: .*)?)$/;
const testOnlyPattern = /\b(?:describe|it|test)\.only\s*\(/;
const standaloneDebuggerPattern = /^\s*debugger\s*;?\s*(?:\/\/.*|\/\*.*\*\/)?$/;

/**
 * 确定性提交前/推送前体检：识别未解决冲突标记、私钥/高置信度 Token 泄露、敏感配置文件、残留 `.only` 与 `debugger`。
 */
export function scanDiffHygieneIssues(patch: string, filePaths: string[] = []): DiffHygieneWarning[] {
  const parsedFiles = parseLightweightDiff(patch);
  const warnings: DiffHygieneWarning[] = [];
  const seenKey = new Set<string>();

  const pushWarning = (warning: DiffHygieneWarning) => {
    const key = `${warning.category}:${warning.file}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    warnings.push(warning);
  };

  const allPaths = new Set<string>([
    ...filePaths.map(normalizePosixPath).filter(Boolean),
    ...parsedFiles.map(file => file.path),
  ]);

  for (const filePath of allPaths) {
    if (isSensitiveCommitPath(filePath)) {
      pushWarning({
        category: 'sensitive-file',
        severity: 'blocker',
        label: '敏感环境/密钥文件',
        file: filePath,
        line: null,
        reason: '文件命名命中本地环境变量或私钥证书特征，默认不应提交或推送到远端仓库',
      });
    }
  }

  for (const file of parsedFiles) {
    if (file.status === 'deleted') continue;
    const testFile = isTestPath(file.path);
    const templateFile = isExampleOrTemplateFile(file.path);

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== 'add') continue;
        const text = line.content;
        const trimmed = text.trim();
        if (!trimmed) continue;

        if (conflictMarkerPattern.test(text)) {
          pushWarning({
            category: 'conflict-markers',
            severity: 'blocker',
            label: '未解决的合并冲突标记',
            file: file.path,
            line: line.newLine,
            reason: '新增行包含 Git 冲突分隔符，直接提交会导致构建或运行损坏',
            snippet: trimmed.slice(0, 80),
          });
          continue;
        }

        const hasPlaceholder = /\[redacted\]|your[_-]?api[_-]?key|<token>|<secret>|example|placeholder/i.test(text);
        if (
          privateKeyHeaderPattern.test(text)
          || (!templateFile && !hasPlaceholder && (knownTokenPrefixPattern.test(text) || npmAuthTokenPattern.test(text)))
        ) {
          pushWarning({
            category: 'secret-leak',
            severity: 'blocker',
            label: '疑似私钥或访问令牌泄露',
            file: file.path,
            line: line.newLine,
            reason: '新增行检测到私钥头或高置信度平台访问令牌前缀，提交前请核对并改用环境变量注入',
            snippet: redactSecretSnippet(text),
          });
          continue;
        }

        if (testFile && testOnlyPattern.test(text) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          pushWarning({
            category: 'test-focus',
            severity: 'warning',
            label: '测试文件残留 .only 聚焦调用',
            file: file.path,
            line: line.newLine,
            reason: '保留 test.only / describe.only 会导致 CI 跳过同文件其余回归用例',
            snippet: trimmed.slice(0, 120),
          });
        }

        if (!testFile && standaloneDebuggerPattern.test(text)) {
          pushWarning({
            category: 'debug-artifact',
            severity: 'warning',
            label: '源码残留 debugger 断点语句',
            file: file.path,
            line: line.newLine,
            reason: '生产源码新增了 debugger 语句，建议在提交前清理',
            snippet: trimmed.slice(0, 80),
          });
        }
      }
    }
  }

  const severityRank: Record<DiffHygieneSeverity, number> = { blocker: 0, warning: 1 };
  return warnings
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.file.localeCompare(right.file))
    .slice(0, 20);
}

const ignoredIssueKeyPrefixes = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'HTTPS', 'CVE', 'AES', 'RSA', 'TLS', 'SSL', 'NODE', 'CSS', 'HTML', 'JSON']);

export function extractBranchIssueKey(branch?: string): string {
  if (!branch) return '';
  const matches = branch.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g);
  for (const match of matches) {
    const prefix = match[1]!;
    if (!ignoredIssueKeyPrefixes.has(prefix)) {
      return `${prefix}-${match[2]}`;
    }
  }
  return '';
}

function classifyFileDomain(filePath: string): 'frontend' | 'backend' | 'shared' | 'test' | 'docs' | 'config' | 'other' {
  const normalized = normalizePosixPath(filePath);
  const base = posixBasename(normalized).toLowerCase();
  const ext = posixExtname(normalized);
  if (isTestPath(normalized)) return 'test';
  if (ext === '.md' || ext === '.mdx' || normalized.startsWith('docs/')) return 'docs';
  if (
    base === 'package.json'
    || base.startsWith('tsconfig')
    || base.startsWith('vite.config')
    || base === 'dockerfile'
    || normalized.startsWith('.github/')
  ) {
    return 'config';
  }
  if (normalized.startsWith('src/') || ['.vue', '.tsx', '.jsx', '.css', '.scss', '.less'].includes(ext)) return 'frontend';
  if (normalized.startsWith('server/') || ['.go', '.py', '.java', '.rs', '.sql'].includes(ext)) return 'backend';
  if (normalized.startsWith('shared/')) return 'shared';
  return 'other';
}

function cleanModuleLabel(filePath: string): string {
  const base = posixBasename(filePath);
  if (base.startsWith('.')) return base;
  const stripped = base.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/i, '').replace(/\.[a-z0-9]+$/i, '');
  return stripped || base;
}

/**
 * 基于实际改动文件与 Diff 统计生成符合中文工程规范的提交说明（兼顾本地 Git 抽屉与群聊远端交付）。
 */
export function buildSmartCommitMessage(input: {
  patch?: string;
  files?: { path: string; status?: string }[];
  branch?: string;
  issueKey?: string;
  issueTitle?: string;
}): SmartCommitSuggestion {
  const parsedDiff = input.patch ? parseLightweightDiff(input.patch) : [];
  const diffByPath = new Map(parsedDiff.map(item => [item.path, item]));

  const rawFiles = (input.files && input.files.length > 0)
    ? input.files.map(item => ({
      path: normalizePosixPath(item.path),
      status: (item.status || '').trim(),
    })).filter(item => item.path && !item.path.startsWith('.delivery-artifacts/'))
    : parsedDiff
      .filter(item => !item.path.startsWith('.delivery-artifacts/'))
      .map(item => ({
        path: item.path,
        status: item.status === 'added' ? 'A' : item.status === 'deleted' ? 'D' : item.status === 'renamed' ? 'R' : 'M',
      }));

  const resolvedIssueKey = (input.issueKey || '').trim() || extractBranchIssueKey(input.branch);
  const cleanTitle = (input.issueTitle || '').replace(/\s+/g, ' ').trim();

  if (!rawFiles.length) {
    const fallbackSubject = resolvedIssueKey
      ? `${resolvedIssueKey}：${cleanTitle ? `同步${cleanTitle}分支改动` : '同步当前分支代码改动'}`
      : (cleanTitle ? `更新${cleanTitle}相关实现` : '更新项目代码改动');
    return { subject: fallbackSubject, body: '', fullMessage: fallbackSubject };
  }

  const domains = new Set(rawFiles.map(file => classifyFileDomain(file.path)));
  const hasFrontend = domains.has('frontend');
  const hasBackend = domains.has('backend') || domains.has('shared');
  const hasTest = domains.has('test');
  const hasDocs = domains.has('docs');
  const hasConfig = domains.has('config');

  let domainPhrase = '相关实现';
  if (hasFrontend && hasBackend) {
    domainPhrase = hasTest ? '前后端实现与测试' : '前后端实现';
  } else if (hasFrontend) {
    domainPhrase = hasTest ? '前端实现与测试' : '前端实现';
  } else if (hasBackend) {
    domainPhrase = hasTest ? '服务端逻辑与测试' : '服务端实现';
  } else if (hasTest && domains.size === 1) {
    domainPhrase = '回归测试用例';
  } else if (hasDocs && domains.size === 1) {
    domainPhrase = '工程文档说明';
  } else if (hasConfig && domains.size === 1) {
    domainPhrase = '工程配置与依赖';
  } else if (hasTest) {
    domainPhrase = '功能实现与测试';
  }

  const statuses = rawFiles.map(item => item.status.toUpperCase());
  const allAdded = statuses.length > 0 && statuses.every(code => code === 'A' || code === '??');
  const allDeleted = statuses.length > 0 && statuses.every(code => code === 'D');
  const verb = allAdded
    ? (hasTest && domains.size === 1 ? '补充' : '新增')
    : allDeleted
      ? '清理'
      : (hasTest && domains.size === 1 ? '补充' : '更新');

  const moduleLabels = [...new Set(rawFiles.map(item => cleanModuleLabel(item.path)).filter(Boolean))];
  const scopeSuffix = moduleLabels.length <= 2
    ? `（${moduleLabels.join('、')}）`
    : `（${moduleLabels.slice(0, 2).join('、')} 等 ${rawFiles.length} 个文件）`;

  let subject: string;
  if (cleanTitle) {
    const baseCore = `${verb}${cleanTitle}${domainPhrase}`;
    const withPrefix = resolvedIssueKey ? `${resolvedIssueKey}：${baseCore}` : baseCore;
    subject = withPrefix.length + scopeSuffix.length <= 88 ? `${withPrefix}${scopeSuffix}` : withPrefix.slice(0, 96);
  } else {
    const baseCore = `${verb}${domainPhrase}${scopeSuffix}`;
    subject = resolvedIssueKey ? `${resolvedIssueKey}：${baseCore}` : baseCore;
  }

  const detailLines = rawFiles.slice(0, 6).map(file => {
    const diffEntry = diffByPath.get(file.path);
    const stat = diffEntry ? ` (+${diffEntry.additions}/-${diffEntry.deletions})` : '';
    const code = file.status || 'M';
    return `- [${code}] ${file.path}${stat}`;
  });
  if (rawFiles.length > 6) {
    detailLines.push(`- ... 其余 ${rawFiles.length - 6} 个文件`);
  }
  const body = detailLines.join('\n');
  const fullMessage = body ? `${subject}\n\n${body}` : subject;

  return { subject, body, fullMessage };
}

function extractSuggestedCodeBlock(expectation?: string): string | undefined {
  if (!expectation) return undefined;
  const fenced = /```(?:suggestion|[a-zA-Z0-9_-]*)\n([\s\S]+?)```/.exec(expectation);
  if (fenced?.[1]?.trim()) return fenced[1].replace(/\r\n/g, '\n').trimEnd();
  return undefined;
}

function matchDiffFile(files: LightweightDiffFile[], rawTarget: string): LightweightDiffFile | undefined {
  const normalized = normalizePosixPath(rawTarget);
  if (!normalized) return undefined;
  const exact = files.find(file => file.path === normalized || file.oldPath === normalized);
  if (exact) return exact;
  const suffixMatches = files.filter(file => file.path.endsWith(`/${normalized}`) || normalized.endsWith(`/${file.path}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

function formatHunkExcerpt(hunk: LightweightDiffHunk, centerIndex: number): string {
  const start = Math.max(0, centerIndex - 2);
  const end = Math.min(hunk.lines.length - 1, centerIndex + 2);
  return hunk.lines.slice(start, end + 1).map(line => {
    const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const lineNo = line.newLine ?? line.oldLine ?? '';
    return `${String(lineNo).padStart(4, ' ')} ${prefix} ${redactSecretSnippet(line.content) === line.content.trim().slice(0, 140) ? line.content.slice(0, 160) : redactSecretSnippet(line.content)}`;
  }).join('\n');
}

/**
 * 将审查结构化 `findings` 锚定到统一 Diff 的精确 Hunk 与行号（借鉴 PR-Agent 行级评论与 `/improve` 代码上下文定位）。
 */
export function anchorFindingsToDiff(findings: AgentTaskFinding[], patch = ''): AnchoredReviewFinding[] {
  if (!findings.length) return [];
  const diffFiles = parseLightweightDiff(patch);

  return findings.map(finding => {
    const normalizedFile = normalizePosixPath(finding.file || '');
    const suggestedCode = extractSuggestedCodeBlock(finding.expectation);
    if (!normalizedFile) {
      return {
        finding,
        normalizedFile: '',
        anchorKind: 'repo-file',
        matchedNewLine: null,
        matchedOldLine: null,
        ...(suggestedCode ? { suggestedCode } : {}),
      };
    }

    const diffFile = matchDiffFile(diffFiles, normalizedFile);
    if (!diffFile) {
      return {
        finding,
        normalizedFile,
        anchorKind: 'repo-file',
        matchedNewLine: finding.line && finding.line > 0 ? finding.line : null,
        matchedOldLine: null,
        ...(suggestedCode ? { suggestedCode } : {}),
      };
    }

    const targetLine = finding.line && finding.line > 0 ? finding.line : 0;
    if (targetLine > 0) {
      for (const hunk of diffFile.hunks) {
        const exactIdx = hunk.lines.findIndex(line => line.newLine === targetLine);
        if (exactIdx >= 0) {
          const hit = hunk.lines[exactIdx]!;
          return {
            finding,
            normalizedFile: diffFile.path,
            anchorKind: 'diff-line',
            matchedNewLine: hit.newLine,
            matchedOldLine: hit.oldLine,
            hunkHeader: hunk.header,
            codeExcerpt: formatHunkExcerpt(hunk, exactIdx),
            ...(suggestedCode ? { suggestedCode } : {}),
          };
        }
      }

      for (const hunk of diffFile.hunks) {
        const oldIdx = hunk.lines.findIndex(line => line.oldLine === targetLine);
        if (oldIdx >= 0) {
          const hit = hunk.lines[oldIdx]!;
          return {
            finding,
            normalizedFile: diffFile.path,
            anchorKind: 'diff-line',
            matchedNewLine: hit.newLine,
            matchedOldLine: hit.oldLine,
            hunkHeader: hunk.header,
            codeExcerpt: formatHunkExcerpt(hunk, oldIdx),
            ...(suggestedCode ? { suggestedCode } : {}),
          };
        }
      }

      for (const hunk of diffFile.hunks) {
        const hunkEnd = hunk.newStart + Math.max(hunk.newLines, 1);
        if (targetLine >= hunk.newStart - 5 && targetLine <= hunkEnd + 5 && hunk.lines.length > 0) {
          const nearestIdx = targetLine < hunk.newStart ? 0 : hunk.lines.length - 1;
          return {
            finding,
            normalizedFile: diffFile.path,
            anchorKind: 'diff-hunk-nearby',
            matchedNewLine: targetLine,
            matchedOldLine: null,
            hunkHeader: hunk.header,
            codeExcerpt: formatHunkExcerpt(hunk, nearestIdx),
            ...(suggestedCode ? { suggestedCode } : {}),
          };
        }
      }
    }

    return {
      finding,
      normalizedFile: diffFile.path,
      anchorKind: 'changed-file',
      matchedNewLine: targetLine > 0 ? targetLine : null,
      matchedOldLine: null,
      ...(suggestedCode ? { suggestedCode } : {}),
    };
  });
}

const anchorLabels: Record<FindingDiffAnchorKind, string> = {
  'diff-line': 'Diff 变更行锚定',
  'diff-hunk-nearby': 'Diff 邻近上下文',
  'changed-file': '改动文件级意见',
  'repo-file': '仓库级/跨文件意见',
};

/**
 * 生成可直接粘贴至 Codeup / GitLab / GitHub MR 评论或开发返工单的行级修复建议清单 Markdown。
 */
export function formatInlineReviewChecklistMarkdown(input: {
  findings: AgentTaskFinding[];
  patch?: string;
  objective?: string;
  round?: number;
  snapshotValue?: string;
}): string {
  const anchored = anchorFindingsToDiff(input.findings, input.patch);
  const headerLines = [
    `### 行级修复建议清单${typeof input.round === 'number' ? `（第 ${input.round} 轮审查）` : ''}`,
  ];
  const meta: string[] = [];
  if (input.objective?.trim()) meta.push(`目标：${input.objective.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  if (input.snapshotValue) meta.push(`快照：\`${input.snapshotValue.slice(0, 12)}\``);
  if (meta.length) headerLines.push(`> ${meta.join(' ｜ ')}`);

  if (!anchored.length) {
    headerLines.push('', '- 当前轮次无待修复代码审查问题。');
    return `${headerLines.join('\n')}\n`;
  }

  const byFile = new Map<string, AnchoredReviewFinding[]>();
  for (const item of anchored) {
    const groupKey = item.normalizedFile || '（全局 / 未指定文件）';
    const list = byFile.get(groupKey) || [];
    list.push(item);
    byFile.set(groupKey, list);
  }

  const sections: string[] = [headerLines.join('\n')];
  for (const [fileKey, items] of byFile.entries()) {
    const fileLines: string[] = [`#### \`${fileKey}\``];
    for (const item of items) {
      const { finding } = item;
      const lineTag = item.matchedNewLine
        ? `L${item.matchedNewLine}`
        : item.matchedOldLine
          ? `旧版 L${item.matchedOldLine}`
          : '文件级';
      fileLines.push(
        `- [ ] **[${finding.severity.toUpperCase()} · ${finding.id}]**（${lineTag} · ${anchorLabels[item.anchorKind]}）：${finding.problem.trim()}`,
      );
      if (item.codeExcerpt) {
        fileLines.push('  ```diff', ...item.codeExcerpt.split('\n').map(line => `  ${line}`), '  ```');
      }
      const proseExpectation = item.suggestedCode
        ? (finding.expectation || '').replace(/```(?:suggestion|[a-zA-Z0-9_-]*)\n[\s\S]+?```/g, '').trim().replace(/[：:]$/, '').trim()
        : (finding.expectation || '').trim();
      if (proseExpectation) {
        fileLines.push(`  - **修改建议**：${proseExpectation}`);
      }
      if (item.suggestedCode) {
        fileLines.push('  ```suggestion', ...item.suggestedCode.split('\n').map(line => `  ${line}`), '  ```');
      }
    }
    sections.push(fileLines.join('\n'));
  }

  return `${sections.join('\n\n')}\n`;
}

/**
 * 为返工阶段的 Implementer 生成高信噪比的 Diff 行锚定代码定位提示，减少模型翻找行号的轮次并降低漏改率。
 */
export function formatAnchoredFindingsForReworkPrompt(
  findings: AgentTaskFinding[],
  patch = '',
  maxChars = 2400,
): string {
  if (!findings.length) return '';
  const anchored = anchorFindingsToDiff(findings, patch);
  const withExcerpts = anchored.filter(item => item.codeExcerpt || item.normalizedFile);
  if (!withExcerpts.length) return '';

  const lines: string[] = [
    `返工精确行锚定参考（共 ${anchored.length} 项待处理发现，已结合上轮 Diff 自动提取对应代码片段）：`,
  ];
  let used = lines[0]!.length;

  for (const item of withExcerpts) {
    const loc = item.normalizedFile
      ? `${item.normalizedFile}${item.matchedNewLine ? `:${item.matchedNewLine}` : item.matchedOldLine ? ` (旧行:${item.matchedOldLine})` : ''}`
      : '全局';
    const blockParts = [
      `- [${item.finding.id} · ${item.finding.severity}] ${loc}（${anchorLabels[item.anchorKind]}）`,
      item.finding.expectation?.trim() ? `  期望修改：${item.finding.expectation.trim().slice(0, 260)}` : '',
      item.codeExcerpt ? `  相关 Diff 片段：\n${item.codeExcerpt.split('\n').map(l => `    ${l}`).join('\n')}` : '',
    ].filter(Boolean);
    const block = blockParts.join('\n');
    if (used + block.length + 2 > maxChars) {
      lines.push('- ...(其余问题请按上方 findings JSON 定位工作区文件逐条核对)');
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }

  return lines.join('\n');
}
