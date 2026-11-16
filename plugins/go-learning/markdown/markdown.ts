/**
 * 设计说明：Agent 输出和草稿都是不可信文本，因此只解析工作台需要的 Markdown 子集。
 * 边界是标题、段落、列表、引用、代码块、表格和安全链接；不生成 HTML，避免 v-html 与脚本注入。
 */
export type MarkdownInline = { type: 'text' | 'emphasis' | 'code'; text: string }
  | { type: 'strong'; text: string; content?: MarkdownInline[] }
  | { type: 'link'; text: string; href: string };

export type MarkdownBlock =
  | { type: 'heading'; level: number; content: MarkdownInline[] }
  | { type: 'paragraph' | 'quote'; content: MarkdownInline[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'list'; ordered: boolean; start?: number; items: MarkdownInline[][] }
  | { type: 'table'; headers: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { type: 'rule' };

/** 用更长围栏保留命令、路径等字面文本，避免内容中的反引号提前结束代码块。 */
export function markdownCodeBlock(text: string, language = 'text') {
  const longest = Array.from(text.matchAll(/`+/g)).reduce((length, match) => Math.max(length, match[0].length), 2);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function safeHref(value: string) {
  const href = value.trim();
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : '';
  } catch { return ''; }
}

export function parseMarkdownInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let rest = source;
  while (rest) {
    const strong = rest.match(/^\*\*([^*]+)\*\*/);
    if (strong) {
      const text = strong[1], content = parseMarkdownInline(text);
      const plain = content.length === 1 && content[0].type === 'text' && content[0].text === text;
      nodes.push(plain ? { type: 'strong', text } : { type: 'strong', text, content });
      rest = rest.slice(strong[0].length);
      continue;
    }
    const code = rest.match(/^`([^`]+)`/);
    if (code) { nodes.push({ type: 'code', text: code[1] }); rest = rest.slice(code[0].length); continue; }
    const link = rest.match(/^\[([^\]]+)]\(((?:[^()]|\([^()]*\))+?)\)/);
    if (link) {
      const href = safeHref(link[2]);
      nodes.push(href ? { type: 'link', text: link[1], href } : { type: 'text', text: link[1] });
      rest = rest.slice(link[0].length);
      continue;
    }
    const bareLink = rest.match(/^https?:\/\/[^\s<>"'`]+/i);
    if (bareLink) {
      const text = bareLink[0].replace(/[.,!?;:)\]}。，！？；：]+$/, '');
      const href = safeHref(text);
      nodes.push(href ? { type: 'link', text, href } : { type: 'text', text });
      rest = rest.slice(text.length);
      continue;
    }
    const emphasis = rest.match(/^\*([^*]+)\*/);
    if (emphasis) { nodes.push({ type: 'emphasis', text: emphasis[1] }); rest = rest.slice(emphasis[0].length); continue; }
    const next = rest.slice(1).search(/[\[*`]|https?:\/\//i);
    const length = next < 0 ? rest.length : next + 1;
    nodes.push({ type: 'text', text: rest.slice(0, length) });
    rest = rest.slice(length);
  }
  return nodes;
}

function cells(line: string) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function tableSeparator(line: string) {
  const values = cells(line);
  return values.length > 0 && values.every((value) => /^:?-{3,}:?$/.test(value));
}

export function parseAgentMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', content: parseMarkdownInline(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { flushParagraph(); index++; continue; }
    const fence = line.match(/^(`{3,})\s*([\w.+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      const closingFence = new RegExp('^`{' + fence[1].length + ',}\\s*$');
      index++;
      while (index < lines.length && !closingFence.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ type: 'code', language: fence[2], text: body.join('\n') });
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && tableSeparator(lines[index + 1])) {
      flushParagraph();
      const headers = cells(line).map(parseMarkdownInline);
      const rows: MarkdownInline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]).map(parseMarkdownInline));
      blocks.push({ type: 'table', headers, rows });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ type: 'heading', level: heading[1].length, content: parseMarkdownInline(heading[2]) }); index++; continue; }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); blocks.push({ type: 'rule' }); index++; continue; }
    const list = line.match(/^\s*(?:(\d+)\.|[-*+])\s+(.+)$/);
    if (list) {
      flushParagraph();
      const ordered = !!list[1];
      const items: MarkdownInline[][] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:(\d+)\.|[-*+])\s+(.+)$/);
        if (!item || !!item[1] !== ordered) break;
        items.push(parseMarkdownInline(item[2]));
        index++;
      }
      blocks.push({ type: 'list', ordered, ...(ordered ? { start: Number(list[1]) } : {}), items });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^>\s?(.*)$/);
        if (!item) break;
        quoted.push(item[1]);
        index++;
      }
      blocks.push({ type: 'quote', content: parseMarkdownInline(quoted.join('\n')) });
      continue;
    }
    paragraph.push(line.trim());
    index++;
  }
  flushParagraph();
  return blocks;
}
