/**
 * Hunk-level Unified Diff Parser & Single-Hunk Patch Builder
 *
 * 借鉴 Lazygit (jesseduffield/lazygit) 与 GitButler (gitbutlerapp/gitbutler) 的
 * Hunk Granular Staging 机制：
 * - 将单个文件的 Unified Diff 精确拆分为独立的 `@@ ... @@` 变更块 (Hunk)
 * - 保留原始 Git 头信息（兼容含空格/中文/引号路径及 CRLF 行尾），剥离整文件 blob index 行，
 *   构造可直接交由 `git apply --cached` / `git apply --reverse` 安全执行的单块补丁。
 */

export interface ParsedGitDiffHunk {
  /** 当前文件内的 0-based Hunk 序号 */
  index: number;
  /** 完整 `@@ -oldStart,oldCount +newStart,newCount @@ ...` 原始行 */
  header: string;
  /** 精简范围标签，如 `-12,4 +12,6` */
  rangeLabel: string;
  /** `@@` 尾部的函数/类签名上下文（若有） */
  sectionHeading: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  added: number;
  removed: number;
  /** Hunk 内部原始行（含前缀 `' '` / `'+'` / `'-'` / `'\\ No newline at end of file'`） */
  rawLines: string[];
}

export interface ParsedGitFilePatch {
  /** 文件级元信息头（`diff --git`、`---`、`+++` 等） */
  headerLines: string[];
  oldPath: string;
  newPath: string;
  binary: boolean;
  untracked: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  isRename: boolean;
  isModeOnly: boolean;
  hunks: ParsedGitDiffHunk[];
  /** 是否支持对单个 Hunk 独立执行暂存 / 取消暂存 / 丢弃 */
  canStageIndividualHunks: boolean;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseDiffHeaderPath(rawHeaderLine: string, prefix: '--- ' | '+++ '): string {
  const body = stripTrailingCr(rawHeaderLine).slice(prefix.length).trim();
  if (body === '/dev/null') return '/dev/null';
  const unquoted = body.startsWith('"') && body.endsWith('"') ? body.slice(1, -1) : body;
  if ((prefix === '--- ' && unquoted.startsWith('a/')) || (prefix === '+++ ' && unquoted.startsWith('b/'))) {
    return unquoted.slice(2);
  }
  return unquoted;
}

/**
 * 解析单文件 `git diff` 输出，提取所有可独立寻址的 Hunk。
 * 注意：仅按 `\n` 切分，保留内容行中可能存在的 `\r` 以确保 CRLF 文件也能被 `git apply` 精确匹配。
 */
export function parseUnifiedDiffHunks(patch: string): ParsedGitFilePatch {
  if (!patch) {
    return {
      headerLines: [],
      oldPath: '',
      newPath: '',
      binary: false,
      untracked: false,
      isNewFile: false,
      isDeletedFile: false,
      isRename: false,
      isModeOnly: false,
      hunks: [],
      canStageIndividualHunks: false,
    };
  }

  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const untracked = lines.length > 0 && lines.every(line => line.startsWith('+'));
  if (untracked) {
    return {
      headerLines: [],
      oldPath: '',
      newPath: '',
      binary: false,
      untracked: true,
      isNewFile: true,
      isDeletedFile: false,
      isRename: false,
      isModeOnly: false,
      hunks: [],
      canStageIndividualHunks: false,
    };
  }

  const headerLines: string[] = [];
  const hunks: ParsedGitDiffHunk[] = [];
  let oldPath = '';
  let newPath = '';
  let binary = false;
  let isNewFile = false;
  let isDeletedFile = false;
  let isRename = false;
  let hasModeHeader = false;
  let hasMinusHeader = false;
  let hasPlusHeader = false;
  let currentHunk: ParsedGitDiffHunk | null = null;

  for (const rawLine of lines) {
    const clean = stripTrailingCr(rawLine);

    if (!currentHunk) {
      const hunkMatch = HUNK_HEADER_RE.exec(clean);
      if (hunkMatch) {
        const oldStart = Number.parseInt(hunkMatch[1]!, 10);
        const oldCount = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
        const newStart = Number.parseInt(hunkMatch[3]!, 10);
        const newCount = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
        currentHunk = {
          index: hunks.length,
          header: rawLine,
          rangeLabel: `-${oldStart}${hunkMatch[2] !== undefined ? `,${oldCount}` : ''} +${newStart}${hunkMatch[4] !== undefined ? `,${newCount}` : ''}`,
          sectionHeading: (hunkMatch[5] || '').trim(),
          oldStart,
          oldCount,
          newStart,
          newCount,
          added: 0,
          removed: 0,
          rawLines: [],
        };
        hunks.push(currentHunk);
        continue;
      }

      headerLines.push(rawLine);
      if (clean.startsWith('Binary files ') || clean.startsWith('GIT binary patch')) {
        binary = true;
      } else if (clean.startsWith('new file mode ')) {
        isNewFile = true;
      } else if (clean.startsWith('deleted file mode ')) {
        isDeletedFile = true;
      } else if (clean.startsWith('rename from ') || clean.startsWith('rename to ') || clean.startsWith('similarity index ')) {
        isRename = true;
      } else if (clean.startsWith('old mode ') || clean.startsWith('new mode ')) {
        hasModeHeader = true;
      } else if (clean.startsWith('--- ')) {
        hasMinusHeader = true;
        oldPath = parseDiffHeaderPath(rawLine, '--- ');
        if (oldPath === '/dev/null') isNewFile = true;
      } else if (clean.startsWith('+++ ')) {
        hasPlusHeader = true;
        newPath = parseDiffHeaderPath(rawLine, '+++ ');
        if (newPath === '/dev/null') isDeletedFile = true;
      }
      continue;
    }

    const nextHunkMatch = HUNK_HEADER_RE.exec(clean);
    if (nextHunkMatch) {
      const oldStart = Number.parseInt(nextHunkMatch[1]!, 10);
      const oldCount = nextHunkMatch[2] !== undefined ? Number.parseInt(nextHunkMatch[2], 10) : 1;
      const newStart = Number.parseInt(nextHunkMatch[3]!, 10);
      const newCount = nextHunkMatch[4] !== undefined ? Number.parseInt(nextHunkMatch[4], 10) : 1;
      currentHunk = {
        index: hunks.length,
        header: rawLine,
        rangeLabel: `-${oldStart}${nextHunkMatch[2] !== undefined ? `,${oldCount}` : ''} +${newStart}${nextHunkMatch[4] !== undefined ? `,${newCount}` : ''}`,
        sectionHeading: (nextHunkMatch[5] || '').trim(),
        oldStart,
        oldCount,
        newStart,
        newCount,
        added: 0,
        removed: 0,
        rawLines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    // 仅收录合法的 Unified Diff Hunk 行
    if (
      rawLine.startsWith(' ')
      || rawLine.startsWith('+')
      || rawLine.startsWith('-')
      || clean === '\\ No newline at end of file'
    ) {
      currentHunk.rawLines.push(rawLine);
      if (rawLine.startsWith('+')) currentHunk.added += 1;
      else if (rawLine.startsWith('-')) currentHunk.removed += 1;
    }
  }

  const isModeOnly = hasModeHeader && hunks.length === 0;
  const canStageIndividualHunks = !binary
    && !untracked
    && !isRename
    && !isNewFile
    && !isDeletedFile
    && !isModeOnly
    && hasMinusHeader
    && hasPlusHeader
    && hunks.length >= 1;

  return {
    headerLines,
    oldPath,
    newPath,
    binary,
    untracked,
    isNewFile,
    isDeletedFile,
    isRename,
    isModeOnly,
    hunks,
    canStageIndividualHunks,
  };
}

/**
 * 构造仅包含指定单个 `hunkIndex` 的标准 Unified Diff 补丁文本。
 * 过滤掉整文件 `index <sha>..<sha>` 与 `old/new mode` 行，避免分块应用时触发全文件 SHA 校验失败。
 */
export function buildSingleHunkPatch(patchOrParsed: string | ParsedGitFilePatch, hunkIndex: number): string {
  const parsed = typeof patchOrParsed === 'string' ? parseUnifiedDiffHunks(patchOrParsed) : patchOrParsed;
  if (!parsed.canStageIndividualHunks) {
    throw new Error('当前文件差异不支持按单块 (Hunk) 独立应用，请使用整文件操作。');
  }
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= parsed.hunks.length) {
    throw new Error(`变更块序号超出范围（共 ${parsed.hunks.length} 处变更块）。`);
  }
  const hunk = parsed.hunks[hunkIndex]!;
  if (!hunk.rawLines.length || (hunk.added === 0 && hunk.removed === 0)) {
    throw new Error('所选变更块不包含有效的增删行。');
  }

  const essentialHeaders = parsed.headerLines.filter((raw) => {
    const clean = stripTrailingCr(raw);
    return clean.startsWith('diff --git ') || clean.startsWith('--- ') || clean.startsWith('+++ ');
  });
  if (!essentialHeaders.some(line => stripTrailingCr(line).startsWith('--- '))
    || !essentialHeaders.some(line => stripTrailingCr(line).startsWith('+++ '))) {
    throw new Error('差异缺少标准 Unified Diff 文件头，无法生成单块补丁。');
  }

  return `${[...essentialHeaders, hunk.header, ...hunk.rawLines].join('\n')}\n`;
}
