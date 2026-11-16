/**
 * 仓库级变更爆炸半径（Blast Radius）、破坏性导出识别与受波及测试图谱分析器
 *
 * 设计借鉴自 GitHub 开源项目：
 * 1. `Aider-AI/aider` (`RepoMap`)：基于 AST 提取导出符号与模块引用关系图，以极小 Token 预算呈现跨文件依赖上下文。
 * 2. `tirth8205/code-review-graph`：围绕 Unified Diff 计算反向依赖爆炸半径（Blast Radius），
 *    定位“导入了被删改导出符号但自身未同步修改的调用方（Unchanged Callers）”以及“1~2 跳受波及测试文件（Impacted Tests）”。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export type ExportChangeKind = 'removed' | 'signature-modified' | 'body-modified';

export interface TouchedExportSymbol {
  file: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 're-export' | 'default';
  changeKind: ExportChangeKind;
  line: number | null;
}

export interface UnchangedDependentItem {
  file: string;
  importsFrom: string;
  importedSymbols: string[];
  matchedTouchedExports: string[];
  risk: 'high' | 'medium' | 'low';
  reason: string;
}

export interface ImpactedTestItem {
  file: string;
  hop: 1 | 2;
  importsTarget: string;
  via?: string;
  updatedInDiff: boolean;
}

export interface RepoBlastRadiusReport {
  indexedFiles: number;
  changedSourceFiles: string[];
  touchedExports: TouchedExportSymbol[];
  totalUnchangedDependents: number;
  unchangedDependents: UnchangedDependentItem[];
  totalImpactedTests: number;
  impactedTests: ImpactedTestItem[];
  suggestedTestCommand: string | null;
}

export interface AnalyzeBlastRadiusOptions {
  changedFiles?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

interface AstExportDecl {
  name: string;
  kind: TouchedExportSymbol['kind'];
  startLine: number;
  endLine: number;
}

interface RawImportEdge {
  specifier: string;
  symbols: string[]; // '*' for namespace/side-effect/dynamic/re-export-all, 'default' for default import
  isReExport: boolean;
}

interface IndexedModule {
  file: string;
  isTest: boolean;
  exports: AstExportDecl[];
  rawImports: RawImportEdge[];
}

interface ResolvedImportEdge {
  from: string;
  to: string;
  symbols: string[];
  isReExport: boolean;
}

interface FileDiffSignals {
  deletedFile: boolean;
  addedFile: boolean;
  hunks: Array<{ start: number; end: number }>;
  removedExportNames: Set<string>;
}

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.delivery-artifacts',
  '.vite',
  '.next',
  '.nuxt',
  '.turbo',
  '.output',
  '.cache',
  '.local',
  '.data',
  'vendor',
  'bundled',
  'support',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
]);

const TEAM_GUARDRAIL_REGEX =
  /本岗位只读|只读岗位不得写入|只读分析与计划，不改文件|当前未开放联网工具|只读独立审查|本轮只读判断/g;

function sanitizeExtractedToken(value: string): string {
  return value.replace(TEAM_GUARDRAIL_REGEX, '[已脱敏]');
}

export function isRepoTestFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return (
    /(?:^|\/)(?:test|tests|__tests__|e2e)\//i.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
  );
}

function insideWorkspace(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function collectRepoCodeFiles(
  workspaceReal: string,
  maxFiles: number,
  maxFileBytes: number,
): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [''];

  while (queue.length > 0 && results.length < maxFiles) {
    const relDir = queue.shift()!;
    const absDir = relDir ? path.join(workspaceReal, relDir) : workspaceReal;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.delivery-')) continue;
        queue.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;
      const absFile = path.join(workspaceReal, relPath);
      const stat = await fs.lstat(absFile).catch(() => null);
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > maxFileBytes) continue;
      const realFile = await fs.realpath(absFile).catch(() => '');
      if (!realFile || !insideWorkspace(workspaceReal, realFile)) continue;
      results.push(relPath);
    }
  }
  return results;
}

function extractVueScriptBlocks(content: string): Array<{ code: string; lineOffset: number; lang: string }> {
  const blocks: Array<{ code: string; lineOffset: number; lang: string }> = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(content)) !== null) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const prefix = content.slice(0, match.index + match[0].indexOf('>') + 1);
    const lineOffset = prefix.split('\n').length - 1;
    const langMatch = /\blang\s*=\s*["']?([a-zA-Z0-9]+)["']?/i.exec(attrs);
    blocks.push({
      code: inner,
      lineOffset,
      lang: (langMatch?.[1] || 'ts').toLowerCase(),
    });
  }
  return blocks;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return Boolean(modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return Boolean(modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));
}

function scriptKindFor(extOrLang: string): ts.ScriptKind {
  switch (extOrLang.replace(/^\./, '').toLowerCase()) {
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'jsx':
      return ts.ScriptKind.JSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function parseScriptAst(
  filePath: string,
  code: string,
  lineOffset: number,
  scriptKind: ts.ScriptKind,
  exportsOut: AstExportDecl[],
  importsOut: RawImportEdge[],
) {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, false, scriptKind);
  const lineOf = (pos: number) =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1 + lineOffset;

  const addImport = (specifier: string, symbols: string[], isReExport = false) => {
    const trimmed = specifier.trim();
    if (!trimmed) return;
    importsOut.push({ specifier: trimmed, symbols, isReExport });
  };

  for (const stmt of sourceFile.statements) {
    const startLine = lineOf(stmt.getStart(sourceFile));
    const endLine = lineOf(stmt.getEnd());

    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const symbols: string[] = [];
      const clause = stmt.importClause;
      if (clause) {
        if (clause.name) symbols.push('default');
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            symbols.push('*');
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              symbols.push((el.propertyName || el.name).text);
            }
          }
        }
      } else {
        symbols.push('*');
      }
      addImport(stmt.moduleSpecifier.text, symbols.length > 0 ? symbols : ['*'], false);
      continue;
    }

    if (ts.isExportDeclaration(stmt)) {
      const moduleSpec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : '';
      if (!stmt.exportClause) {
        if (moduleSpec) addImport(moduleSpec, ['*'], true);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        const importedNames: string[] = [];
        for (const el of stmt.exportClause.elements) {
          exportsOut.push({
            name: el.name.text,
            kind: 're-export',
            startLine,
            endLine,
          });
          importedNames.push((el.propertyName || el.name).text);
        }
        if (moduleSpec) addImport(moduleSpec, importedNames, true);
      }
      continue;
    }

    if (ts.isExportAssignment(stmt)) {
      exportsOut.push({
        name: 'default',
        kind: 'default',
        startLine,
        endLine,
      });
      continue;
    }

    if (!hasExportModifier(stmt)) continue;
    const isDefault = hasDefaultModifier(stmt);

    if (ts.isFunctionDeclaration(stmt)) {
      exportsOut.push({
        name: stmt.name ? stmt.name.text : 'default',
        kind: isDefault && !stmt.name ? 'default' : 'function',
        startLine,
        endLine,
      });
    } else if (ts.isClassDeclaration(stmt)) {
      exportsOut.push({
        name: stmt.name ? stmt.name.text : 'default',
        kind: isDefault && !stmt.name ? 'default' : 'class',
        startLine,
        endLine,
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      exportsOut.push({
        name: stmt.name.text,
        kind: 'interface',
        startLine,
        endLine,
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      exportsOut.push({
        name: stmt.name.text,
        kind: 'type',
        startLine,
        endLine,
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      exportsOut.push({
        name: stmt.name.text,
        kind: 'enum',
        startLine,
        endLine,
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exportsOut.push({
            name: decl.name.text,
            kind: 'variable',
            startLine: lineOf(decl.getStart(sourceFile)),
            endLine: lineOf(decl.getEnd()),
          });
        }
      }
    }
  }

  // Also capture dynamic import('...') or require('...') inside expressions
  const visitDynamic = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        addImport(node.arguments[0].text, ['*'], false);
      }
    }
    ts.forEachChild(node, visitDynamic);
  };
  ts.forEachChild(sourceFile, visitDynamic);
}

async function indexSingleModule(workspaceReal: string, relFile: string): Promise<IndexedModule | null> {
  const absPath = path.join(workspaceReal, relFile);
  const raw = await fs.readFile(absPath, 'utf8').catch(() => null);
  if (raw === null) return null;

  const exportsList: AstExportDecl[] = [];
  const importsList: RawImportEdge[] = [];
  const ext = path.extname(relFile).toLowerCase();

  if (ext === '.vue') {
    const blocks = extractVueScriptBlocks(raw);
    for (const block of blocks) {
      parseScriptAst(relFile, block.code, block.lineOffset, scriptKindFor(block.lang), exportsList, importsList);
    }
    if (!exportsList.some(item => item.name === 'default')) {
      const totalLines = raw.split('\n').length;
      exportsList.push({
        name: 'default',
        kind: 'default',
        startLine: 1,
        endLine: totalLines,
      });
    }
  } else {
    parseScriptAst(relFile, raw, 0, scriptKindFor(ext), exportsList, importsList);
  }

  return {
    file: relFile,
    isTest: isRepoTestFile(relFile),
    exports: exportsList,
    rawImports: importsList,
  };
}

function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
  indexedSet: Set<string>,
): string | null {
  let baseCandidate = '';
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const fromDir = path.posix.dirname(fromFile);
    baseCandidate = path.posix.normalize(fromDir === '.' ? specifier : `${fromDir}/${specifier}`);
  } else if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    baseCandidate = path.posix.normalize(`src/${specifier.slice(2)}`);
  } else {
    return null;
  }
  if (baseCandidate.startsWith('../')) return null;

  if (indexedSet.has(baseCandidate)) return baseCandidate;

  // Handle TypeScript NodeNext `.js` / `.mjs` / `.jsx` imports pointing to `.ts` / `.tsx` / `.mts`
  const jsExtMatch = /^(.+)\.([cm]?jsx?)$/i.exec(baseCandidate);
  if (jsExtMatch) {
    const stem = jsExtMatch[1];
    const ext = jsExtMatch[2].toLowerCase();
    const mapped = ext === 'mjs'
      ? ['.mts', '.mjs']
      : ext === 'cjs'
        ? ['.cts', '.cjs']
        : ext === 'jsx'
          ? ['.tsx', '.jsx']
          : ['.ts', '.tsx', '.vue', '.js'];
    for (const tryExt of mapped) {
      if (indexedSet.has(`${stem}${tryExt}`)) return `${stem}${tryExt}`;
    }
  }

  const candidateExts = ['.ts', '.tsx', '.vue', '.mts', '.js', '.jsx', '.mjs'];
  for (const ext of candidateExts) {
    if (indexedSet.has(`${baseCandidate}${ext}`)) return `${baseCandidate}${ext}`;
  }
  for (const ext of candidateExts) {
    const indexCand = `${baseCandidate}/index${ext}`;
    if (indexedSet.has(indexCand)) return indexCand;
  }
  return null;
}

function parseDiffSignals(diffPatch: string): Map<string, FileDiffSignals> {
  const map = new Map<string, FileDiffSignals>();
  if (!diffPatch.trim()) return map;

  let currentFile = '';
  let current: FileDiffSignals | undefined;

  const ensure = (file: string): FileDiffSignals => {
    const clean = file.replace(/\\/g, '/').replace(/^\.\//, '');
    let sig = map.get(clean);
    if (!sig) {
      sig = { deletedFile: false, addedFile: false, hunks: [], removedExportNames: new Set() };
      map.set(clean, sig);
    }
    return sig;
  };

  for (const line of diffPatch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentFile = match ? match[2].trim().replace(/^"+|"+$/g, '') : '';
      current = currentFile ? ensure(currentFile) : undefined;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (line.slice(4).trim() === '/dev/null' && current) current.addedFile = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') {
        if (current) current.deletedFile = true;
      } else {
        currentFile = raw.replace(/^b\//, '').replace(/^"+|"+$/g, '');
        current = ensure(currentFile);
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        const start = Number.parseInt(match[1], 10);
        const count = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
        current.hunks.push({ start, end: start + Math.max(count - 1, 0) });
      }
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const body = line.slice(1);
      const declMatch = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(body);
      if (declMatch) current.removedExportNames.add(declMatch[1]);
      if (/^\s*export\s+default\b/.test(body)) current.removedExportNames.add('default');
    }
  }
  return map;
}

async function inferTestCommand(workspaceReal: string, testFiles: string[]): Promise<string | null> {
  if (testFiles.length === 0) return null;
  const targets = testFiles.slice(0, 6).join(' ');
  const pkgRaw = await fs.readFile(path.join(workspaceReal, 'package.json'), 'utf8').catch(() => '');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const testScript = pkg.scripts?.test || '';
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (testScript.includes('tsx --test') || deps.tsx) {
        return `npx tsx --test ${targets}`;
      }
      if (testScript.includes('vitest') || deps.vitest) {
        return `npx vitest run ${targets}`;
      }
      if (testScript.includes('jest') || deps.jest) {
        return `npx jest ${targets}`;
      }
    } catch {
      // ignore malformed package.json
    }
  }
  return `node --test ${targets}`;
}

export async function analyzeRepoBlastRadius(
  workspacePath: string,
  diffPatch: string,
  options: AnalyzeBlastRadiusOptions = {},
): Promise<RepoBlastRadiusReport> {
  const empty: RepoBlastRadiusReport = {
    indexedFiles: 0,
    changedSourceFiles: [],
    touchedExports: [],
    totalUnchangedDependents: 0,
    unchangedDependents: [],
    totalImpactedTests: 0,
    impactedTests: [],
    suggestedTestCommand: null,
  };

  if (!workspacePath) return empty;
  const workspaceReal = await fs.realpath(workspacePath).catch(() => '');
  if (!workspaceReal) return empty;
  const rootStat = await fs.lstat(workspaceReal).catch(() => null);
  if (!rootStat?.isDirectory()) return empty;

  const diffSignals = parseDiffSignals(diffPatch || '');
  const allChanged = new Set<string>([
    ...(options.changedFiles || []).map(f => f.replace(/\\/g, '/').replace(/^\.\//, '')),
    ...diffSignals.keys(),
  ]);
  if (allChanged.size === 0) return empty;

  const changedSourceFiles = [...allChanged]
    .filter(file => {
      if (isRepoTestFile(file)) return false;
      const ext = path.extname(file).toLowerCase();
      return CODE_EXTENSIONS.has(ext) && !file.endsWith('.d.ts');
    })
    .sort();

  if (changedSourceFiles.length === 0) return empty;

  const maxFiles = options.maxFiles ?? 1200;
  const maxFileBytes = options.maxFileBytes ?? 384 * 1024;
  const repoFiles = await collectRepoCodeFiles(workspaceReal, maxFiles, maxFileBytes);
  const indexedSet = new Set(repoFiles);

  const modules = new Map<string, IndexedModule>();
  await Promise.all(
    repoFiles.map(async file => {
      const mod = await indexSingleModule(workspaceReal, file);
      if (mod) modules.set(file, mod);
    }),
  );

  // Build resolved import graph & reverse dependency index
  const reverseDeps = new Map<string, ResolvedImportEdge[]>();
  for (const mod of modules.values()) {
    const mergedByTarget = new Map<string, { symbols: Set<string>; isReExport: boolean }>();
    for (const rawImp of mod.rawImports) {
      const resolved = resolveModuleSpecifier(mod.file, rawImp.specifier, indexedSet);
      if (!resolved || resolved === mod.file) continue;
      const existing = mergedByTarget.get(resolved) || { symbols: new Set<string>(), isReExport: false };
      for (const sym of rawImp.symbols) existing.symbols.add(sym);
      if (rawImp.isReExport) existing.isReExport = true;
      mergedByTarget.set(resolved, existing);
    }
    for (const [target, info] of mergedByTarget.entries()) {
      const list = reverseDeps.get(target) || [];
      list.push({
        from: mod.file,
        to: target,
        symbols: [...info.symbols],
        isReExport: info.isReExport,
      });
      reverseDeps.set(target, list);
    }
  }

  // Compute touched exports in changed source files
  const touchedExports: TouchedExportSymbol[] = [];
  const touchedByFile = new Map<string, Map<string, TouchedExportSymbol>>();

  const recordTouched = (item: TouchedExportSymbol) => {
    touchedExports.push(item);
    const byName = touchedByFile.get(item.file) || new Map<string, TouchedExportSymbol>();
    byName.set(item.name, item);
    touchedByFile.set(item.file, byName);
  };

  for (const changedFile of changedSourceFiles) {
    const sig = diffSignals.get(changedFile);
    const mod = modules.get(changedFile);
    const currentExportNames = new Set((mod?.exports || []).map(e => e.name));

    if (sig) {
      for (const removedName of sig.removedExportNames) {
        if (!currentExportNames.has(removedName) || sig.deletedFile) {
          recordTouched({
            file: changedFile,
            name: sanitizeExtractedToken(removedName),
            kind: removedName === 'default' ? 'default' : 'function',
            changeKind: 'removed',
            line: null,
          });
        }
      }
    }

    if (!mod || sig?.addedFile) continue;

    for (const exp of mod.exports) {
      const signatureTouched = Boolean(sig?.removedExportNames.has(exp.name));
      const hunkOverlaps = sig?.hunks.some(
        hunk => hunk.start <= exp.endLine && hunk.end >= exp.startLine,
      );
      if (!signatureTouched && !hunkOverlaps) continue;
      recordTouched({
        file: changedFile,
        name: sanitizeExtractedToken(exp.name),
        kind: exp.kind,
        changeKind: signatureTouched ? 'signature-modified' : 'body-modified',
        line: exp.startLine,
      });
    }
  }

  // Propagate 1-hop barrel re-exports so callers importing via an unchanged index.ts still link back
  const changedSourceSet = new Set(changedSourceFiles);
  const unchangedDependentsAll: UnchangedDependentItem[] = [];
  const seenDependents = new Set<string>();

  const evaluateDependent = (edge: ResolvedImportEdge, originSourceFile: string) => {
    const callerMod = modules.get(edge.from);
    if (!callerMod || callerMod.isTest || allChanged.has(edge.from)) return;
    const key = `${edge.from}->${originSourceFile}`;
    if (seenDependents.has(key)) return;
    seenDependents.add(key);

    const fileTouched = touchedByFile.get(originSourceFile);
    const sig = diffSignals.get(originSourceFile);
    const matchedTouched: TouchedExportSymbol[] = [];

    if (fileTouched) {
      if (edge.symbols.includes('*')) {
        matchedTouched.push(...fileTouched.values());
      } else {
        for (const sym of edge.symbols) {
          const hit = fileTouched.get(sym);
          if (hit) matchedTouched.push(hit);
        }
      }
    }

    let risk: UnchangedDependentItem['risk'] = 'low';
    let reason = `导入了本次修改模块 ${originSourceFile}，但该文件自身未在本次改动中更新`;
    if (sig?.deletedFile) {
      risk = 'high';
      reason = `导入的目标模块 ${originSourceFile} 已被删除，该未改文件将出现解析失败`;
    } else if (matchedTouched.some(t => t.changeKind === 'removed')) {
      const names = matchedTouched.filter(t => t.changeKind === 'removed').map(t => t.name).join(', ');
      risk = 'high';
      reason = `直接引用了已移除导出 \`${names}\`，该未改调用方存在高概率编译/运行时破坏`;
    } else if (matchedTouched.some(t => t.changeKind === 'signature-modified')) {
      const names = matchedTouched.filter(t => t.changeKind === 'signature-modified').map(t => t.name).join(', ');
      risk = 'high';
      reason = `引用了签名发生变更的导出 \`${names}\`，需核对参数与返回契约兼容性`;
    } else if (matchedTouched.length > 0) {
      const names = matchedTouched.map(t => t.name).join(', ');
      risk = 'medium';
      reason = `引用了实现逻辑变更的导出 \`${names}\`，需确认行为副作用兼容`;
    }

    unchangedDependentsAll.push({
      file: edge.from,
      importsFrom: originSourceFile,
      importedSymbols: edge.symbols.map(sanitizeExtractedToken),
      matchedTouchedExports: matchedTouched.map(t => t.name),
      risk,
      reason,
    });
  };

  // Compute 1-hop & 2-hop dependents and impacted tests
  const impactedTestsMap = new Map<string, ImpactedTestItem>();

  for (const srcFile of changedSourceSet) {
    const hop1Edges = reverseDeps.get(srcFile) || [];
    for (const edge of hop1Edges) {
      const mod1 = modules.get(edge.from);
      if (!mod1) continue;
      if (mod1.isTest) {
        if (!impactedTestsMap.has(edge.from) || impactedTestsMap.get(edge.from)!.hop > 1) {
          impactedTestsMap.set(edge.from, {
            file: edge.from,
            hop: 1,
            importsTarget: srcFile,
            updatedInDiff: allChanged.has(edge.from),
          });
        }
        continue;
      }

      evaluateDependent(edge, srcFile);

      // 2-hop traversal (covers both barrel index.ts re-exports and intermediate service -> route -> test)
      const hop2Edges = reverseDeps.get(edge.from) || [];
      for (const edge2 of hop2Edges) {
        const mod2 = modules.get(edge2.from);
        if (!mod2) continue;
        if (mod2.isTest) {
          if (!impactedTestsMap.has(edge2.from)) {
            impactedTestsMap.set(edge2.from, {
              file: edge2.from,
              hop: 2,
              importsTarget: srcFile,
              via: edge.from,
              updatedInDiff: allChanged.has(edge2.from),
            });
          }
        } else if (edge.isReExport) {
          evaluateDependent(edge2, srcFile);
        }
      }
    }
  }

  const riskOrder: Record<UnchangedDependentItem['risk'], number> = { high: 0, medium: 1, low: 2 };
  unchangedDependentsAll.sort(
    (a, b) => riskOrder[a.risk] - riskOrder[b.risk] || a.file.localeCompare(b.file),
  );

  const impactedTestsAll = [...impactedTestsMap.values()].sort(
    (a, b) => a.hop - b.hop || Number(a.updatedInDiff) - Number(b.updatedInDiff) || a.file.localeCompare(b.file),
  );

  const suggestedTestCommand = await inferTestCommand(
    workspaceReal,
    impactedTestsAll.map(t => t.file),
  );

  return {
    indexedFiles: modules.size,
    changedSourceFiles,
    touchedExports: touchedExports.slice(0, 30),
    totalUnchangedDependents: unchangedDependentsAll.length,
    unchangedDependents: unchangedDependentsAll.slice(0, 20),
    totalImpactedTests: impactedTestsAll.length,
    impactedTests: impactedTestsAll.slice(0, 20),
    suggestedTestCommand,
  };
}

export function formatBlastRadiusForPrompt(
  report: RepoBlastRadiusReport | undefined,
  options: { role?: 'reviewer' | 'verifier'; artifactHint?: string } = {},
): string {
  if (!report) return '';
  const hasHighOrMedCallers = report.unchangedDependents.some(d => d.risk !== 'low');
  if (
    report.touchedExports.length === 0
    && !hasHighOrMedCallers
    && report.impactedTests.length === 0
  ) {
    return '';
  }

  const lines: string[] = [
    `【仓库依赖爆炸半径与受波及测试图谱${options.artifactHint ? `（详见 ${options.artifactHint}）` : ''}】`,
  ];

  const highRiskExports = report.touchedExports.filter(
    e => e.changeKind === 'removed' || e.changeKind === 'signature-modified',
  );
  if (highRiskExports.length > 0) {
    lines.push(
      `- 导出契约变更（${highRiskExports.length} 项）：`
        + highRiskExports
          .slice(0, 8)
          .map(
            e =>
              `\`${e.file}${e.line ? `:${e.line}` : ''}#${e.name}\`（${e.changeKind === 'removed' ? '已移除导出' : '导出声明签名改动'}）`,
          )
          .join('、'),
    );
  }

  const notableDependents = report.unchangedDependents.filter(d => d.risk !== 'low');
  if (notableDependents.length > 0) {
    lines.push(
      `- 未同步修改的下游依赖调用方（共 ${notableDependents.length} 处，${options.role === 'verifier' ? '请重点验证调用兼容性' : '请重点核查是否漏改或破坏契约'}）：`,
    );
    for (const dep of notableDependents.slice(0, 8)) {
      const badge = dep.risk === 'high' ? '高危契约波及' : '行为波及';
      lines.push(`  • [${badge}] \`${dep.file}\`（依赖 \`${dep.importsFrom}\`）：${dep.reason}`);
    }
  }

  if (report.impactedTests.length > 0) {
    const directCount = report.impactedTests.filter(t => t.hop === 1).length;
    const untouchedTests = report.impactedTests.filter(t => !t.updatedInDiff);
    lines.push(
      `- 反向追踪命中的受波及测试文件（共 ${report.totalImpactedTests} 个，其中 1 跳直连 ${directCount} 个，未随本次改动更新 ${untouchedTests.length} 个）：`
        + report.impactedTests
          .slice(0, 8)
          .map(t => `\`${t.file}\`(${t.hop === 1 ? '直连' : `经 ${t.via}`}${t.updatedInDiff ? '·已更新' : ''})`)
          .join('、'),
    );
    if (report.suggestedTestCommand) {
      lines.push(`- 推荐定向回归测试命令：\`${report.suggestedTestCommand}\``);
    }
  }

  return lines.join('\n').replace(TEAM_GUARDRAIL_REGEX, '按受控范围执行');
}
