/**
 * 工作区语义级 `@` 引用检索（`@目录` 模块锚定 + `@符号` 代码定义行号定位）。
 *
 * 设计借鉴自 GitHub 开源项目：
 * - `continuedev/continue`：`@Folder` 目录树锚定与 `@Code` 导出函数/类/接口精确引用
 * - `RooCodeInc/Roo-Code` & `Aider`：用轻量级代码符号定位（`path/to/file.ts:line`）替代全文件盲目塞入上下文，显著降低 Token 消耗与幻觉
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type MentionGroundingScope = 'all' | 'folder' | 'symbol';

export type WorkspaceSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'component';

export interface WorkspaceFolderMention {
  /** 以 `/` 结尾的相对目录路径，如 `src/features/agent-workbench/` */
  path: string;
  fileCount: number;
}

export interface WorkspaceSymbolMention {
  name: string;
  kind: WorkspaceSymbolKind;
  path: string;
  line: number;
  exported: boolean;
  signature: string;
}

export interface WorkspaceMentionGroundingResult {
  scope: MentionGroundingScope;
  normalizedQuery: string;
  folders: WorkspaceFolderMention[];
  symbols: WorkspaceSymbolMention[];
}

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.local',
  '.cache',
  '.turbo',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.py',
  '.go',
  '.rs',
]);

const MAX_WALK_FILES = 1500;
const MAX_SYMBOL_SCAN_FILES = 180;
const MAX_SYMBOL_FILE_BYTES = 220_000;

export function parseMentionGroundingQuery(rawQuery: string): {
  scope: MentionGroundingScope;
  term: string;
} {
  const trimmed = (rawQuery || '').trim();
  const folderMatch = trimmed.match(/^(?:folder|dir|目录)[:：]\s*(.*)$/i);
  if (folderMatch) {
    return { scope: 'folder', term: (folderMatch[1] || '').trim() };
  }
  const symbolMatch = trimmed.match(/^(?:symbol|sym|fn|符号|函数)[:：]\s*(.*)$/i);
  if (symbolMatch) {
    return { scope: 'symbol', term: (symbolMatch[1] || '').trim() };
  }
  return { scope: 'all', term: trimmed };
}

function isSensitiveRelativePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(seg => IGNORED_DIRS.has(seg))) return true;
  const base = segments.at(-1) || '';
  if (/^\.env(?:\..+)?$/i.test(base) && !/\.example$/i.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  return false;
}

async function listSafeWorkspaceFiles(workspaceRoot: string, providedFiles?: readonly string[]): Promise<string[]> {
  if (providedFiles && providedFiles.length > 0) {
    return providedFiles
      .map(item => item.replace(/\\/g, '/').replace(/^\/+/, ''))
      .filter(item => item && !isSensitiveRelativePath(item));
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspaceRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { timeout: 3500, maxBuffer: 2_000_000 },
    );
    const gitFiles = stdout
      .split('\0')
      .map(item => item.trim().replace(/\\/g, '/'))
      .filter(item => item && !isSensitiveRelativePath(item));
    if (gitFiles.length > 0) return gitFiles;
  } catch {
    // 非 Git 仓库时回退到受限目录遍历
  }

  const collected: string[] = [];
  const realRoot = await fs.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));

  async function walk(currentDir: string, relativePrefix: string, depth: number): Promise<void> {
    if (depth > 6 || collected.length >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= MAX_WALK_FILES) break;
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (isSensitiveRelativePath(rel)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        const targetReal = await fs.realpath(fullPath).catch(() => '');
        if (!targetReal || (!targetReal.startsWith(`${realRoot}${path.sep}`) && targetReal !== realRoot)) {
          continue;
        }
      }
      if (entry.isDirectory()) {
        await walk(fullPath, rel, depth + 1);
      } else if (entry.isFile()) {
        collected.push(rel);
      }
    }
  }

  await walk(realRoot, '', 0);
  return collected;
}

export function rankWorkspaceFolders(files: readonly string[], term: string, limit = 10): WorkspaceFolderMention[] {
  const folderCounts = new Map<string, number>();
  for (const rawFile of files) {
    const normalized = rawFile.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) continue;
    let acc = '';
    for (let index = 0; index < parts.length - 1 && index < 4; index += 1) {
      acc = acc ? `${acc}/${parts[index]}` : parts[index]!;
      const folderPath = `${acc}/`;
      folderCounts.set(folderPath, (folderCounts.get(folderPath) || 0) + 1);
    }
  }

  const lowerTerm = term.toLowerCase().replace(/^\/+|\/+$/g, '');
  return [...folderCounts.entries()]
    .filter(([folderPath]) => {
      if (!lowerTerm) return true;
      return folderPath.toLowerCase().includes(lowerTerm);
    })
    .sort(([leftPath, leftCount], [rightPath, rightCount]) => {
      if (lowerTerm) {
        const leftSegments = leftPath.slice(0, -1).toLowerCase().split('/');
        const rightSegments = rightPath.slice(0, -1).toLowerCase().split('/');
        const leftLeaf = leftSegments.at(-1) || '';
        const rightLeaf = rightSegments.at(-1) || '';
        const leftScore = leftLeaf === lowerTerm ? 0 : leftLeaf.startsWith(lowerTerm) ? 1 : leftPath.toLowerCase().startsWith(lowerTerm) ? 2 : 3;
        const rightScore = rightLeaf === lowerTerm ? 0 : rightLeaf.startsWith(lowerTerm) ? 1 : rightPath.toLowerCase().startsWith(lowerTerm) ? 2 : 3;
        if (leftScore !== rightScore) return leftScore - rightScore;
      }
      const leftDepth = leftPath.split('/').filter(Boolean).length;
      const rightDepth = rightPath.split('/').filter(Boolean).length;
      return leftDepth - rightDepth || rightCount - leftCount || leftPath.localeCompare(rightPath);
    })
    .slice(0, limit)
    .map(([folderPath, fileCount]) => ({ path: folderPath, fileCount }));
}

const TS_JS_SYMBOL_PATTERNS: ReadonlyArray<{ regex: RegExp; kind: WorkspaceSymbolKind; exported: boolean }> = [
  { regex: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, kind: 'function', exported: true },
  { regex: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/, kind: 'class', exported: true },
  { regex: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)\b/, kind: 'interface', exported: true },
  { regex: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)\b/, kind: 'type', exported: true },
  { regex: /^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\b/, kind: 'const', exported: true },
  { regex: /^\s*export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/, kind: 'enum', exported: true },
  { regex: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, kind: 'function', exported: false },
  { regex: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/, kind: 'class', exported: false },
];

const PY_GO_RS_PATTERNS: ReadonlyArray<{ ext: string; regex: RegExp; kind: WorkspaceSymbolKind }> = [
  { ext: '.py', regex: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { ext: '.py', regex: /^class\s+([A-Za-z_]\w*)\b/, kind: 'class' },
  { ext: '.go', regex: /^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { ext: '.go', regex: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, kind: 'class' },
  { ext: '.rs', regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\b/, kind: 'function' },
  { ext: '.rs', regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\b/, kind: 'class' },
];

function extractFileSymbols(relPath: string, content: string): WorkspaceSymbolMention[] {
  const ext = path.extname(relPath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const found: WorkspaceSymbolMention[] = [];

  if (ext === '.vue') {
    const componentName = path.basename(relPath, '.vue');
    if (componentName) {
      found.push({
        name: componentName,
        kind: 'component',
        path: relPath,
        line: 1,
        exported: true,
        signature: `<${componentName} /> (Vue SFC)`,
      });
    }
  }

  const isJsFamily = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'].includes(ext);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx]!;
    if (!rawLine || rawLine.length > 260) continue;

    if (isJsFamily) {
      for (const rule of TS_JS_SYMBOL_PATTERNS) {
        const match = rawLine.match(rule.regex);
        if (match && match[1]) {
          found.push({
            name: match[1],
            kind: rule.kind,
            path: relPath,
            line: idx + 1,
            exported: rule.exported,
            signature: rawLine.trim().replace(/\s*\{?\s*$/, '').slice(0, 110),
          });
          break;
        }
      }
      continue;
    }

    for (const rule of PY_GO_RS_PATTERNS) {
      if (rule.ext !== ext) continue;
      const match = rawLine.match(rule.regex);
      if (match && match[1]) {
        found.push({
          name: match[1],
          kind: rule.kind,
          path: relPath,
          line: idx + 1,
          exported: !match[1].startsWith('_'),
          signature: rawLine.trim().replace(/\s*\{?\s*$/, '').slice(0, 110),
        });
        break;
      }
    }
  }

  return found;
}

export async function searchWorkspaceMentionGrounding(
  workspacePath: string,
  rawQuery: string,
  options: { files?: readonly string[]; maxFolders?: number; maxSymbols?: number } = {},
): Promise<WorkspaceMentionGroundingResult> {
  const { scope, term } = parseMentionGroundingQuery(rawQuery);
  const maxFolders = options.maxFolders ?? 8;
  const maxSymbols = options.maxSymbols ?? 12;

  // 普通 `@` 空查询不触发全仓目录/符号扫描，保持零开销与原有候选顺序
  if (scope === 'all' && term.length < 2) {
    return { scope, normalizedQuery: term, folders: [], symbols: [] };
  }

  const realRoot = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
  const files = await listSafeWorkspaceFiles(realRoot, options.files);

  const folders = scope === 'symbol'
    ? []
    : rankWorkspaceFolders(files, term, maxFolders);

  if (scope === 'folder') {
    return { scope, normalizedQuery: term, folders, symbols: [] };
  }

  const lowerTerm = term.toLowerCase();
  const codeFiles = files
    .filter(file => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()) && !/\.d\.ts$/i.test(file))
    .sort((left, right) => {
      // 优先扫描路径或文件名包含查询词的源码文件，再扫描 shared/server/src 核心目录
      const leftHit = lowerTerm && left.toLowerCase().includes(lowerTerm) ? 0 : /^(?:shared|server|src)\//.test(left) ? 1 : 2;
      const rightHit = lowerTerm && right.toLowerCase().includes(lowerTerm) ? 0 : /^(?:shared|server|src)\//.test(right) ? 1 : 2;
      return leftHit - rightHit || left.length - right.length || left.localeCompare(right);
    })
    .slice(0, MAX_SYMBOL_SCAN_FILES);

  const matchedSymbols: WorkspaceSymbolMention[] = [];
  await Promise.all(
    codeFiles.map(async relPath => {
      const fullPath = path.resolve(realRoot, relPath);
      if (!fullPath.startsWith(`${realRoot}${path.sep}`)) return;
      let stat;
      try {
        stat = await fs.lstat(fullPath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SYMBOL_FILE_BYTES) return;
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch {
        return;
      }
      // 快速子串预筛（当有查询词时）以跳过完全无关的大文件
      if (lowerTerm && !content.toLowerCase().includes(lowerTerm) && !path.basename(relPath).toLowerCase().includes(lowerTerm)) {
        return;
      }
      const symbols = extractFileSymbols(relPath, content);
      for (const sym of symbols) {
        if (!lowerTerm || sym.name.toLowerCase().includes(lowerTerm)) {
          matchedSymbols.push(sym);
        }
      }
    }),
  );

  matchedSymbols.sort((left, right) => {
    if (lowerTerm) {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      const leftRank = leftName === lowerTerm ? 0 : leftName.startsWith(lowerTerm) ? 1 : 2;
      const rightRank = rightName === lowerTerm ? 0 : rightName.startsWith(lowerTerm) ? 1 : 2;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    if (left.exported !== right.exported) return left.exported ? -1 : 1;
    return left.name.length - right.name.length || left.path.localeCompare(right.path) || left.line - right.line;
  });

  return {
    scope,
    normalizedQuery: term,
    folders,
    symbols: matchedSymbols.slice(0, maxSymbols),
  };
}
