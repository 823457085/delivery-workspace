export interface ConflictBlock {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
  base?: string;
}

// Keep byte-for-byte line endings and offsets when replacing a conflict block.
export function parseConflictBlocks(content: string): ConflictBlock[] {
  const lines = [...content.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const text = (index: number) => {
    const line = lines[index][0].replace(/\r?\n$/, '');
    return index === 0 ? line.replace(/^\ufeff/, '') : line;
  };
  const blocks: ConflictBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = text(i).match(/^(<{7,})(?:[ \t].*)?$/);
    if (!start) continue;
    const width = start[1].length;
    const isMarker = (index: number, marker: string) => {
      const line = text(index);
      const prefix = marker.repeat(width);
      return line === prefix || (line.startsWith(prefix) && /^[ \t]/.test(line.slice(width)));
    };
    let base = -1, separator = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^<{7,}(?:[ \t].*)?$/.test(text(j))) break;
      if (separator < 0 && base < 0 && isMarker(j, '|')) base = j;
      else if (separator < 0 && isMarker(j, '=')) separator = j;
      else if (separator >= 0 && isMarker(j, '>')) {
        blocks.push({
          start: lines[i].index! + (i === 0 && content.startsWith('\ufeff') ? 1 : 0),
          end: lines[j].index! + lines[j][0].length,
          startLine: i + 1,
          endLine: j + 1,
          ours: content.slice(lines[i].index! + lines[i][0].length, lines[base < 0 ? separator : base].index),
          theirs: content.slice(lines[separator].index! + lines[separator][0].length, lines[j].index),
          ...(base < 0 ? {} : { base: content.slice(lines[base].index! + lines[base][0].length, lines[separator].index) }),
        });
        i = j;
        break;
      }
    }
  }
  return blocks;
}

export function hasConflictMarkers(content: string): boolean {
  return /^(?:<{7,}|\|{7,}|={7,}|>{7,})(?:[ \t].*)?\r?$/m.test(content);
}

export function resolveConflictBlock(content: string, block: ConflictBlock, choice: 'ours' | 'theirs' | 'both'): string {
  const replacement = choice === 'both' ? block.ours + block.theirs : block[choice];
  return content.slice(0, block.start) + replacement + content.slice(block.end);
}
