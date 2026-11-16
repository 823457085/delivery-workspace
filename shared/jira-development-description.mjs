const sections = ['需求来源', '实现说明', '交付物', '影响范围', '相关文档'];
const sectionHeading = new RegExp(`^\\*(${sections.join('|')})\\*[ \\t]*$`, 'gmu');

export function hasDevelopmentDescriptionSections(description) {
  const headings = [...String(description || '').matchAll(sectionHeading)].map(match => match[1]);
  return headings.length === sections.length && sections.every((section, index) => headings[index] === section);
}

export function renderDevelopmentDescription({ source, implementation, deliverables, impact, references, markers = [] }) {
  return [source, implementation, deliverables, impact, references]
    .map((value, index) => `*${sections[index]}*\n${String(value).trim().replace(sectionHeading, '$1：')}`)
    .concat(markers)
    .join('\n\n');
}

export function jiraReferenceLinks(text) {
  const normalized = String(text || '').replace(/\[[^\]\r\n]*\|(https?:\/\/[^\]\s]+)\]/gu, '$1');
  const urls = new Set(normalized.match(/https?:\/\/[^\s<>\[\]|(){}"'`，。；、）]+/gu) || []);
  return [...urls].map(url => `[${url}|${url}]`).join('\n');
}
