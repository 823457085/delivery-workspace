export function jiraWikiMarkdown(source: string) {
  let code = '';
  return source.replace(/\r\n?/g, '\n').split('\n').map(line => {
    if (/^```/.test(line.trim()) && (!code || code === 'markdown')) {
      code = code ? '' : 'markdown';
      return line;
    }
    const fence = line.trim().match(/^\{(code|noformat)(?::([^}]+))?\}$/);
    if (fence && (!code || code === fence[1])) {
      const opening = !code;
      code = opening ? fence[1] : '';
      return '```' + (opening ? fence[2] || '' : '');
    }
    if (code) return line;
    const block = line.match(/^[ \t]*(h([1-6])\.|\*|#)\s+(.*)$/);
    const prefix = block ? block[2] ? '#'.repeat(Number(block[2])) + ' ' : block[1] === '*' ? '- ' : '1. ' : '';
    const body = block ? block[3] : line;
    return prefix + body.replace(/\{\{([^\n]+?)\}\}(?!})|`[^`\n]+`|\*\*[^*\n]+\*\*|\{\*\}([^\n]+?)\{\*\}|\[([^\]|]+)\|(https?:\/\/[^\]]+)\]|https?:\/\/[^\s]+|\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)/g,
      (match, inlineCode, escapedBold, label, url, bold, italic) => inlineCode !== undefined ? '`' + inlineCode + '`'
        : escapedBold !== undefined ? `**${escapedBold}**`
        : label !== undefined ? `[${label}](${url})` : bold !== undefined ? `**${bold}**` : italic !== undefined ? `*${italic}*` : match);
  }).join('\n');
}
export function safeJiraHtml(source: string, baseUrl?:string) {
  const document = new DOMParser().parseFromString(source,'text/html');
  const tags=new Set('p div span h1 h2 h3 h4 h5 h6 ul ol li strong b em i u s del code pre blockquote table thead tbody tfoot tr th td br hr a'.split(' '));
  const discard=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','SVG','MATH','TEMPLATE']);
  function clean(parent: Element) {
    for(const node of [...parent.children]) {
      if(discard.has(node.tagName)){node.remove();continue;}
      clean(node);
      if(!tags.has(node.tagName.toLowerCase())){node.replaceWith(...node.childNodes);continue;}
      const href=node.getAttribute('href');
      for(const attribute of [...node.attributes])node.removeAttribute(attribute.name);
      if(node.tagName==='A' && href) {
        try {const url=new URL(href,baseUrl);if(['http:','https:'].includes(url.protocol)){node.setAttribute('href',url.href);node.setAttribute('target','_blank');node.setAttribute('rel','noopener noreferrer');}}
        catch { /* Relative links are kept as text, never resolved against the local workbench. */ }
      }
    }
  }
  clean(document.body);return document.body.innerHTML;
}
