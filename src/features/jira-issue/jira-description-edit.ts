export type JiraTextFormat = 'heading' | 'bold' | 'italic' | 'bullet' | 'numbered' | 'link' | 'code';

/** Only the explicit selection changes; the rest of the Jira source stays byte-for-byte intact. */
export function formatJiraSelection(source: string, start: number, end: number, format: JiraTextFormat) {
  let from = Math.max(0, Math.min(start, source.length));
  let to = Math.max(from, Math.min(end, source.length));
  let replacement: string, selectFrom: number, selectTo: number;
  if (['heading', 'bullet', 'numbered'].includes(format)) {
    from = from ? source.lastIndexOf('\n', from - 1) + 1 : 0;
    const last = to > start && source[to - 1] === '\n' ? to - 1 : to;
    const next = source.indexOf('\n', last);
    to = next < 0 ? source.length : next;
    const prefix = format === 'heading' ? 'h2. ' : format === 'bullet' ? '* ' : '# ';
    replacement = source.slice(from, to).split('\n').map(line => prefix + line.replace(/^(?:h[1-6]\. |[*#]+ )/, '')).join('\n');
    selectFrom = from;
    selectTo = from + replacement.length;
  } else {
    const selected = source.slice(from, to);
    const inlineMarker = format === 'bold' ? '*' : format === 'italic' ? '_' : '';
    if (inlineMarker && selected && source[from - 1] === inlineMarker && source[to] === inlineMarker) {
      return { value: source.slice(0, from - 1) + selected + source.slice(to + 1), start: from - 1, end: to - 1 };
    }
    if (format === 'link') {
      const isUrl = /^https?:\/\/\S+$/.test(selected);
      const label = isUrl ? '链接文字' : selected || '链接文字';
      const url = isUrl ? selected : 'https://';
      replacement = `[${label}|${url}]`;
      selectFrom = from + (isUrl ? 1 : label.length + 2);
      selectTo = selectFrom + (isUrl ? label.length : url.length);
    } else {
      const content = selected || (format === 'code' ? '代码' : '文字');
      const marker = format === 'bold' ? '*' : format === 'italic' ? '_' : '{code}';
      const before = format === 'code' ? `${from && source[from - 1] !== '\n' ? '\n' : ''}${marker}\n` : marker;
      const after = format === 'code' ? `\n${marker}${to < source.length && source[to] !== '\n' ? '\n' : ''}` : marker;
      replacement = before + content + after;
      selectFrom = from + before.length;
      selectTo = selectFrom + content.length;
    }
  }
  return { value: source.slice(0, from) + replacement + source.slice(to), start: selectFrom, end: selectTo };
}
