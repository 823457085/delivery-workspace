// 需求排期表和服务端 Jira 计划共用命名规则。
const rawText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

/** 业务模块只取明确命名证据；仓库身份留给查重，不能据此推测业务归属。 */
export function requirementTitle(sourceIssue, details, businessModule, repositoryNames = []) {
  const subject = sourceIssue.summary || sourceIssue.key || '需求功能';
  const prefix = subject.match(/^(?:【([^【】\r\n]+)】|\[([^\[\]\r\n]+)\])\s*(.+)$/u);
  const prefixModule = (prefix?.[1] || prefix?.[2] || '').trim();
  const hasModule = prefixModule && !/^(?:PRD|DEV|FE|需求|产品需求|前端|后端|测试|发布)$/i.test(prefixModule);
  const declared = `${details}\n${rawText(sourceIssue.description)}`.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:业务模块|所属模块|模块)\s*[:：]\s*([^\r\n]+)/u)?.[1]?.trim();
  const module = businessModule.trim() || (hasModule ? prefixModule : '') || declared || '';
  if (module.length > 100 || /[\r\n【】\[\]]/u.test(module)) throw new Error('业务模块请填写不含括号的单行名称，最多 100 字。');
  const titleSubject = hasModule ? prefix[3] : subject, multiProject = repositoryNames.length > 1;
  // 仅调整新建跨项目任务的标题；来源原文和业务名中的 ApexPay 等词保持不变。
  return { businessModule: module, subject: multiProject ? titleSubject.replace(/^apex(?:[\s:：-]+|(?=[\p{Script=Han}]))/iu, '') : titleSubject, multiProject, repositoryNames };
}

export function requirementSummary(role, { subject, businessModule, multiProject }) {
  return `${businessModule ? `【${businessModule}】` : ''}${multiProject ? '跨项目' : ''}${role === 'parent' ? `开发 ${subject}` : role === 'design' ? `编写 ${subject} 技术方案` : `实现 ${subject}`}`.slice(0, 250);
}

/** 优先明确前端/功能范围；目标仅补充有页面对象和动作证据的内容，不推测后台实现。 */
function scopeText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'text') return typeof value.text === 'string' ? value.marks?.some(mark => mark.type === 'strong') ? `**${value.text}**` : value.text : '';
  if (value.type === 'hardBreak') return '\n';
  const body = (Array.isArray(value.content) ? value.content : []).map(scopeText).join(['paragraph', 'heading'].includes(value.type) ? '' : '\n');
  return value.type === 'heading' ? `## ${body}` : value.type === 'listItem' ? `- ${body}` : body;
}
export function requirementScopes(details, description) {
  const sections = [details, description].map(input => {
    let active = '', fence = false, wiki = false;
    const found = { frontend: [], scopes: [], goals: [] };
    const frontendObject = /页面|列表|详情|表单|弹窗|按钮|开关|字段|前端|界面|(?:国家|基础|系统)配置/u;
    const action = /新增|增加|补充|展示|显示|查询|筛选|编辑|选择|填写|校验|记录|支持|调整|维护|保存|切换|提示|标识|查看/u;
    const clean = value => value.replace(/\{\*\}|\*{1,2}|`/gu, '').replace(/\[([^\]|]+)\|https?:\/\/[^\]]+\]/gu, '$1').trim();
    const append = value => {
      const text = clean(value).replace(/^(?:并|同时|以及)\s*/u, '');
      if (!text || /^(?:(?:(?:本次|此次|本期)\s*)?(?:不涉及|不调整|不包含|不含|无需|排除)|(?:本次|此次|本期)范围|只涉及|仅涉及|仅针对|只针对)/u.test(text)) return;
      if (/(?:不|无需|不再)(?:新增|增加|补充|修改|调整|变更|改造)/u.test(text)) return;
      if (/^(?:后端|服务端|数据库)/u.test(text) || !frontendObject.test(text) && /^(?:后台)|扣款|结算|计费|运算/u.test(text)) return;
      if (active === 'goals' && (!frontendObject.test(text) || !action.test(text))) return;
      let label = text.split(/[。；;]/u)[0].replace(/^.+?(?:时|后)[，,]\s*/u, '').split(/[，,:：]/u)[0]
        .replace(/^在(.+?)中(?:新增|增加|补充)\s*/u, '$1').replace(/^在(.+?)中(?=记录|展示|显示|查询|编辑|提示|保存)/u, '$1')
        .replace(/^(?:新增|增加|补充)\s*/u, '').replace(/[（(]子任务\s*\d+\s*\/\s*\d+[）)]/gu, '').trim();
      const list = text.match(/列表(?:展示|显示|查询)/u)?.[0];
      if (list && !label.includes(list)) label += `与${list}`;
      if (!label || /^(?:第[\d一二三四五六七八九十]+(?:阶段|段|项功能))$/u.test(label)) return;
      if (!found[active].some(scope => scope.text === text)) found[active].push({ text, label: label.length > 70 ? `${label.slice(0, 69)}…` : label });
    };
    for (const line of scopeText(input).replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*(?:```|\{(?:code|noformat)(?::[^}]+)?\})/u.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const titleLine = line.trim().replace(/^(?:h[1-6]\.\s*|#{1,6}\s+)/u, '');
      const emphasized = titleLine.match(/^(?:\*{1,2}|\{\*\})(.+?)(?:\*{1,2}|\{\*\})\s*(.*)$/u);
      const heading = clean(emphasized ? `${emphasized[1].replace(/[:：]\s*$/u, '')}: ${emphasized[2].replace(/^[:：]\s*/u, '')}` : titleLine);
      const section = heading.match(/^((?:(?:前端|需求|功能|实现|工作)?范围)(?:[（(][^）)]*[）)])?|背景(?:\s*[/／]\s*问题)?|目标|验收标准|非功能要求|不在范围|排除范围|关联文档|相关文档|文档)(?:(?:\s*[:：]\s*|\s+)(.*))?$/u);
      let body = line;
      if (section) {
        active = section[1].startsWith('前端范围') ? 'frontend' : /^(?:需求|功能|实现|工作)?范围/u.test(section[1]) ? 'scopes' : section[1] === '目标' ? 'goals' : '';
        wiki = !/^\s*#{1,6}\s/u.test(line);
        body = section[2] || '';
      } else {
        // Jira Wiki 用单个 # 表示有序条目，不能按 Markdown 一级标题结束范围。
        if (/^\s*h[1-6]\.\s/u.test(line) || !wiki && /^\s*#{1,6}\s/u.test(line)
          || /^\s*(?:\*{1,2}(?!\s).+?\*{1,2}|\{\*\}.+?\{\*\})\s*[:：]?\s*$/u.test(line)) { active = ''; continue; }
      }
      if (!active) continue;
      const listed = body.match(/^\s*(?:[-*#]|\d+[.)、])\s+(.+)$/u)?.[1];
      if (listed && active !== 'goals') append(listed);
      else for (const text of body.split(/[。；;]|[，,](?=(?:并|同时|以及)?(?:在|于|将|为)[^。；;]*(?:页面|列表|详情|表单|弹窗|按钮|开关|字段|界面))/u)) append(text);
    }
    return found;
  });
  for (const section of sections) if (section.frontend.length || section.scopes.length) return section.frontend.length ? section.frontend : section.scopes;
  for (const section of sections) if (section.goals.length) return section.goals;
  return [];
}
export function childScopeTitles(item, parts, scopes, title) {
  const groups = parts.map((_, index) => parts.length === 1 ? [] : scopes.length >= parts.length
    ? scopes.slice(Math.floor(index * scopes.length / parts.length), Math.floor((index + 1) * scopes.length / parts.length))
    : scopes[index] ? [scopes[index]] : []);
  const summaries = groups.map(group => group.length ? `${title.businessModule ? `【${title.businessModule}】` : ''}${title.multiProject ? '跨项目' : ''}${item.role === 'design' ? '编写' : '实现'} ${group.map(scope => scope.label).join('、')}${item.role === 'design' ? ' 技术方案' : ''}` : item.summary)
    .map(summary => summary.length > 250 ? `${summary.slice(0, 249)}…` : summary);
  return summaries.map((shortened, index) => {
    const duplicate = summaries.indexOf(shortened) !== summaries.lastIndexOf(shortened);
    const suffix = `（${parts[index][0]} 至 ${parts[index].at(-1)}）`;
    return { summary: parts.length > 1 && (duplicate || !groups[index].length) ? `${shortened.slice(0, 250 - suffix.length)}${suffix}` : shortened,
      scope: groups[index].length ? `本子任务需求范围：\n${groups[index].map(scope => `- ${scope.text}`).join('\n')}\n\n` : '' };
  });
}
