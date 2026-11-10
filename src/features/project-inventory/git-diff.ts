export interface GitDiffLine {
  kind: 'meta' | 'hunk' | 'context' | 'add' | 'remove';
  content: string;
  marker: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Keep the returned patch text intact while separating its gutters and change markers. */
export function presentGitDiff(patch: string) {
  const source = patch.split('\n');
  if (source.at(-1) === '') source.pop();
  // The untracked-file endpoint returns added lines without a unified-diff header.
  const untracked = source.length > 0 && source.every(line => line.startsWith('+'));
  let oldLine = 0, newLine = 0, inHunk = untracked;
  let added = 0, removed = 0;
  let firstChangedLine: number | undefined;
  const lines: GitDiffLine[] = source.map(text => {
    const line: GitDiffLine = { kind: 'meta', content: text, marker: '', oldLine: null, newLine: null };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      line.kind = 'hunk';
    } else if (text.startsWith('diff ')) inHunk = false;
    else if (inHunk && text.startsWith('+')) {
      line.kind = 'add'; line.marker = '+'; line.content = text.slice(1);
      line.newLine = untracked ? ++newLine : newLine++;
      firstChangedLine ??= line.newLine;
      added++;
    } else if (inHunk && text.startsWith('-')) {
      line.kind = 'remove'; line.marker = '-'; line.content = text.slice(1);
      line.oldLine = oldLine++; removed++;
      firstChangedLine ??= Math.max(1, newLine);
    } else if (inHunk && text.startsWith(' ')) {
      line.kind = 'context'; line.content = text.slice(1);
      line.oldLine = oldLine++; line.newLine = newLine++;
    }
    return line;
  });
  return { lines, added, removed, firstChangedLine };
}

interface GitDiffCell {
  line: GitDiffLine;
  note?: string;
}

type GitDiffRow = { info: GitDiffLine } | { old?: GitDiffCell; next?: GitDiffCell };

export function splitGitDiff(lines: GitDiffLine[]): GitDiffRow[] {
  const rows: GitDiffRow[] = [];
  const removed: GitDiffCell[] = [];
  const added: GitDiffCell[] = [];
  let previousChange: GitDiffCell | undefined;

  function flushChanges() {
    const length = Math.max(removed.length, added.length);
    for (let index = 0; index < length; index++) {
      rows.push({ old: removed[index], next: added[index] });
    }
    removed.length = 0;
    added.length = 0;
    previousChange = undefined;
  }

  for (const line of lines) {
    if (line.kind === 'remove' || line.kind === 'add') {
      previousChange = { line };
      (line.kind === 'remove' ? removed : added).push(previousChange);
      continue;
    }
    if (previousChange && line.kind === 'meta' && line.content === '\\ No newline at end of file') {
      previousChange.note = line.content;
      previousChange = undefined;
      continue;
    }
    flushChanges();
    rows.push(line.kind === 'context' ? { old: { line }, next: { line } } : { info: line });
  }
  flushChanges();
  return rows;
}
