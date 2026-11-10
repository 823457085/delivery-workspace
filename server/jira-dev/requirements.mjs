/** 需求拆分与单项缺陷修复共用确认、去重和回读；结果不明只读核对，不重放写入。 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sourceIdentity } from './jira-client.mjs';
import { writePrivateJson } from './ui-state.mjs';
import { defaultDesignDestination, normalizeDesignDestination } from './project-preferences.mjs';
import { chinaWorkingDates, splitWorkingDates } from '../../shared/china-work-calendar.mjs';
import { childScopeTitles, requirementScopes, requirementSummary, requirementTitle } from '../../shared/jira-dev-requirement-titles.mjs';

const roles = ['parent', 'design', 'implementation'];
const names = { parent: '前端 DEV', design: '技术方案', implementation: '前端实现' };
const rawText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const marked = (issue, marker) => Boolean(marker) && (issue.labels?.includes(marker) || rawText(issue.description).includes(marker));
const designTitle = /技术方案|tech(?:nical)?[ -]?design/i;
const implementationTitle = /实现|前端开发|frontend\s+development|implementation|implement\b/i;
const developmentType = /^(?:task|dev|development|开发任务|任务|开发)$/i;
const developmentTitle = /前端|frontend|\bFE\b|^【(?:APP|PC|WEB|H5|小程序)】\s*(?:开发|完成)/i;
const repairTitle = /前端修复|修复.*前端|(?:frontend|front.end|\bFE\b).*\bfix\b|^【(?:APP|PC|WEB|H5|小程序)】\s*修复/i;
const childrenOf = (issue, issues) => issues.filter(candidate => candidate.parent?.key === issue.key && candidate.issueType?.subtask !== false);
const isImplementation = issue => !designTitle.test(issue.summary) && implementationTitle.test(issue.summary);
const isRepairTask = issue => repairTitle.test(issue.summary) && (issue.issueType?.subtask === true || developmentType.test(issue.issueType?.name));
const isDevelopmentParent = (issue, issues) => !issue.parent && issue.issueType?.subtask === false
  && developmentType.test(issue.issueType.name) && (developmentTitle.test(issue.summary) || childrenOf(issue, issues).some(isImplementation));
const sameSite = (source, issue) => !!issue?.key && !issue.materialStatus
  && issue.url === source.url.slice(0, -`/browse/${source.key}`.length) + `/browse/${issue.key}`;
const frontendChoices = issues => issues.map(({ key, url, summary }) => ({ key, url, summary }));
const frontendChoiceWarning = issues => issues.length > 1
  ? `找到多个关联开发主任务：${issues.map(issue => issue.key).join('、')}。请选择要复用的开发主任务。`
  : '请选择要复用的关联开发主任务。';
const frontendChoiceError = () => Object.assign(new Error('该 Jira 开发主任务当前无法用于此预览，请重新读取候选。'),
  { code: 'JIRA_FRONTEND_CHOICE', statusCode: 409 });
const completed = record => record.items.every(item => item.state === 'created' && !item.scheduleReviewRequired && (!item.dateUpdate || item.dateUpdate.state === 'created')) && (!record.sourceLink || record.sourceLink.state === 'created');
const unknown = record => record.items.some(item => item.state === 'unknown' || item.dateUpdate?.state === 'unknown') || record.sourceLink?.state === 'unknown';
const titleRuleVersion = 5;
const scheduleRuleVersion = 2;
const reuseRuleVersion = 1;
const linkedItem = record => record.items.find(item => item.role === 'parent') || record.items.find(item => item.role === 'implementation');
// 已尝试写入的计划保留原确认内容和去重标记，不能因升级标题规则中断恢复。
const needsTitleReview = record => record.sourceKind === 'product' && record.titleRuleVersion !== titleRuleVersion && !record.sourceLink?.attemptedAt && !record.items.some(item => item.attemptedAt || item.dateUpdate?.attemptedAt || ['unknown', 'attempting'].includes(item.state)) && record.items.some(item => item.action === 'create' && item.state !== 'created');
const needsScheduleReview = record => record.sourceKind === 'product' && record.scheduleRuleVersion !== scheduleRuleVersion && !unknown(record) && record.status !== 'applied' && record.items.some(item => item.action === 'create' && item.state !== 'created');

/** 产品需求按前端父任务排期拆分；复用和缺陷流程保留各角色原有日期语义。 */
function validDate(value) {
  return typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !value.startsWith('0000-') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validateRange(startDate, endDate) {
  if ((startDate && !validDate(startDate)) || (endDate && !validDate(endDate))) throw new Error('计划日期必须是真实的 YYYY-MM-DD 日期。');
  if (startDate && endDate && endDate < startDate) throw new Error('计划结束日期不能早于计划开始日期。');
}
function schedulesFrom(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(role => !roles.includes(role))) throw new Error('任务排期参数不正确。');
  return Object.fromEntries(roles.map(role => {
    const input = value[role] === undefined ? {} : value[role];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['startDate', 'endDate'].includes(key))) throw new Error('任务排期参数不正确。');
    const schedule = {};
    for (const key of ['startDate', 'endDate']) {
      if (input[key] === undefined || input[key] === '') continue;
      if (!validDate(input[key])) throw new Error('计划日期必须是真实的 YYYY-MM-DD 日期。');
      schedule[key] = input[key];
    }
    validateRange(schedule.startDate, schedule.endDate);
    return [role, schedule];
  }));
}
function scheduleFor(item, requested = {}) {
  const previousStartDate = item.action === 'reuse' ? item.issue?.startDate || '' : '';
  const previousEndDate = item.action === 'reuse' ? item.issue?.endDate || '' : '';
  const startDate = requested.startDate || previousStartDate, endDate = requested.endDate || previousEndDate;
  if (Object.keys(requested).length) validateRange(startDate, endDate);
  return { startDate, endDate, previousStartDate, previousEndDate, changed: item.action === 'reuse' && (startDate !== previousStartDate || endDate !== previousEndDate) };
}
function workdaysIn({ startDate, endDate }) {
  validateRange(startDate, endDate);
  if (!startDate || !endDate) throw new Error('请补齐主任务的计划开始日期和计划结束日期，再按最多三个工作日拆分子任务。');
  const days = chinaWorkingDates(startDate, endDate);
  if (!days.length) throw new Error('主任务或子任务的计划日期内没有工作日，请调整排期。');
  return days;
}
function splitChildren(record, title, details) {
  const parent = record.items[0], days = workdaysIn(parent.schedule);
  const designEnd = record.schedules.design.endDate || days[0];
  const defaults = {
    design: { startDate: days[0], endDate: days[0] },
    implementation: { startDate: days.find(day => day > designEnd) || days.at(-1), endDate: days.at(-1) },
  };
  const scopes = requirementScopes(details, record.sourceIssue.description);
  record.items = [parent, ...record.items.slice(1).flatMap(item => {
    const requested = { ...defaults[item.role], ...record.schedules[item.role] };
    const workdays = workdaysIn(requested);
    if (requested.startDate < parent.schedule.startDate || requested.endDate > parent.schedule.endDate) throw new Error('子任务日期必须位于主任务的计划日期范围内。');
    const parts = splitWorkingDates(workdays, 3);
    const titles = childScopeTitles(item, parts, scopes, title);
    return parts.map((part, index) => {
      const plannedSchedule = { startDate: part[0], endDate: part.at(-1) };
      const marker = `${item.marker}-${plannedSchedule.startDate}-${plannedSchedule.endDate}`;
      return { ...item, id: marker, marker, plannedSchedule, workdays: part.length,
        summary: titles[index].summary,
        description: item.description.replace(`JIRA_DEV_REQUIREMENT_MARKER: ${item.marker}`, `${titles[index].scope}计划范围：${plannedSchedule.startDate} 至 ${plannedSchedule.endDate}（${part.length} 个工作日）。本子任务承接上述需求范围及该时间段内的${names[item.role]}工作，单独记录交付结果。\n\nJIRA_DEV_REQUIREMENT_MARKER: ${marker}`),
        schedule: scheduleFor(item, plannedSchedule) };
    });
  })];
}
function verifyDates(item, issue, creation = false) {
  const expected = item.schedule;
  if (!expected) return;
  if (['startDate', 'endDate'].some(key => (!creation || expected[key]) && (issue?.[key] || '') !== expected[key])) throw Object.assign(new Error('计划日期回读与已确认预览不一致；仅保留结果待核对，不重放写入。'), { uncertain: true, key: issue?.key, url: issue?.url });
}

export function createRequirementStore({ jira, dataDirectory }) {
  const filename = join(dataDirectory, 'requirement-plans.json');
  let queue = Promise.resolve(), records = [];
  const serial = callback => {
    const result = queue.then(async () => {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const lock = new DatabaseSync(join(dataDirectory, 'requirement-operation-lock.sqlite'));
      try {
        try { lock.exec('BEGIN IMMEDIATE'); } catch { throw new Error('另一个面板正在核对前端任务，请稍后读取结果。'); }
        try { records = JSON.parse(await readFile(filename, 'utf8')); if (!Array.isArray(records)) throw new Error(); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('本机前端任务记录无法读取；未覆盖原记录。'); records = []; }
        for (const record of records) {
          for (const item of record.items) {
            if (item.state === 'attempting') item.state = 'unknown';
            if (item.dateUpdate?.state === 'attempting') item.dateUpdate.state = 'unknown';
          }
          if (record.sourceLink?.state === 'attempting') record.sourceLink.state = 'unknown';
          if (unknown(record)) record.status = 'unknown';
        }
        return await callback();
      } finally { lock.close(); }
    });
    queue = result.catch(() => {}); return result;
  };
  const save = () => writePrivateJson(filename, records);
  const find = taskId => { const value = records.find(item => item.taskId === taskId); if (!value) throw new Error('前端任务预览不存在，请重新生成。'); return value; };
  const scopeOf = (issue, repositoryId, repositoryName, sourceKind) => createHash('sha256').update(`${issue.url || issue.key}\0${repositoryId || repositoryName || 'default'}${sourceKind === 'defect' ? '\0repair' : ''}`).digest('hex').slice(0, 24);
  const publicIssue = issue => { if (!issue) return issue; const { rawFields, ...value } = issue; return value; };
  const publicRecord = record => {
    const { taskId, status, sourceKind, sourceIssue, developmentIssue, items, requiresConfirmation, warning, sourceLink, repositoryId, repositoryName } = record;
    const stale = needsTitleReview(record), staleSchedule = needsScheduleReview(record);
    return structuredClone({ taskId, status, sourceKind, sourceIssue: publicIssue(sourceIssue), ...(developmentIssue ? { developmentIssue: publicIssue(developmentIssue) } : {}), ...(sourceKind === 'frontend' && status === 'local' && record.developmentCandidates?.length ? { developmentCandidates: record.developmentCandidates } : {}), ...(record.repairMode ? { repairMode: record.repairMode, targetProject: record.targetProject, assignee: record.assignee, fixVersions: record.fixVersions } : {}), items: items.map(item => ({ ...item, schedule: item.schedule || scheduleFor(item), ...(item.issue ? { issue: publicIssue(item.issue) } : {}) })), requiresConfirmation: stale || staleSchedule ? false : requiresConfirmation, ...(record.needsReconfirmation ? { needsReconfirmation: true } : {}), ...(warning || stale || staleSchedule ? { warning: [warning, stale ? '任务标题规则已更新，请核对业务模块和项目范围后重新生成预览；已有 Jira 事项保留。' : '', staleSchedule ? '子任务拆分规则已更新，请重新生成预览，按主任务日期拆成最多三个工作日的子任务；已有 Jira 事项保留。' : ''].filter(Boolean).join(' ') } : {}), ...(sourceLink ? { sourceLink } : {}), repositoryId, repositoryName, businessModule: record.businessModule || '', ...(record.designDestination ? { designDestination: record.designDestination, designPublicationAuthorized: record.designPublicationAuthorized === true } : {}), ...(stale ? { needsTitleReview: true } : {}), ...(staleSchedule ? { needsScheduleReview: true } : {}), ...(record.reuseRuleVersion ? { reuseRuleVersion: record.reuseRuleVersion } : {}) });
  };
  function finish(record) {
    const implementations = record.items.filter(item => item.role === 'implementation');
    const implementation = implementations.length > 1 ? record.items.find(item => item.role === 'parent' && item.state === 'created') : implementations.find(item => item.state === 'created');
    if (implementation?.issue) record.developmentIssue = implementation.issue;
    if (record.sourceKind === 'defect' && implementation?.issue) repairFacts(record, implementation.issue);
    record.status = unknown(record) ? 'unknown' : completed(record) ? 'applied' : 'ready';
    record.requiresConfirmation = record.status === 'ready';
  }
  function reuse(item, issue) {
    Object.assign(item, { action: 'reuse', state: 'created', key: issue.key, url: issue.url, summary: issue.summary, description: rawText(issue.description), issue }); delete item.error;
  }
  async function readFrontendReuse(sourceIssue) {
    const { sourceIssue: source, issues } = await search({ sourceIssue, items: [] });
    if (source.key !== sourceIssue.key) throw Object.assign(new Error('读取的 Jira 编号与任务来源不一致。'), { code: 'JIRA_SITE_MISMATCH' });
    let main;
    if (source.parent) {
      main = issues.find(issue => issue.key === source.parent.key);
      if (!main) throw new Error(`未读到父任务 ${source.parent.key}，请核对 Jira 权限。`);
    } else if (source.subtasks?.length || childrenOf(source, issues).length) {
      if (isDevelopmentParent(source, issues)) main = source;
    }
    const linked = main ? [] : issues.filter(issue => source.links?.some(link => link.key === issue.key) && sameSite(source, issue) && isDevelopmentParent(issue, issues));
    return { source, issues, main, linked };
  }
  function frontendReuseCandidates({ source, issues, main, linked }) {
    return main && sameSite(source, main) && isDevelopmentParent(main, issues) ? [main] : linked;
  }
  function selectFrontend(candidates, developmentKey) {
    if (!developmentKey) return undefined;
    const selected = candidates.find(issue => issue.key === developmentKey);
    if (!selected) throw frontendChoiceError();
    return selected;
  }
  function resolveFrontend({ source, issues, main, linked }, selected) {
    if (!selected && linked.length > 1) throw new Error(frontendChoiceWarning(linked));
    main = selected || main || linked[0];
    const items = [];
    let developmentIssue;
    const add = (role, issue, parentRole) => {
      if (!sameSite(source, issue)) throw new Error('无法核验已有 Jira 任务的编号和站点。');
      const item = { role, ...(parentRole ? { parentRole } : {}) };
      reuse(item, issue);
      items.push(item);
    };
    if (main) {
      const children = childrenOf(main, issues);
      if (source.parent?.key === main.key && !children.some(child => child.key === source.key)) children.push(source);
      const missing = (main.subtasks || []).filter(child => !children.some(issue => issue.key === child.key));
      if (missing.length) throw new Error(`未完整读取 ${main.key} 的子任务：${missing.map(issue => issue.key).join('、')}。请核对 Jira 权限后重新预览。`);
      add('parent', main);
      for (const child of children.filter(issue => designTitle.test(issue.summary))) add('design', child, 'parent');
      if (source.parent && !designTitle.test(source.summary) && !isImplementation(source)) throw new Error(`${source.key} 无法确认为实现子任务，请输入开发主任务或实现任务编号。`);
      const implementations = source.parent && isImplementation(source) ? [source] : children.filter(isImplementation);
      if (!implementations.length) throw new Error(`${main.key} 下没有可识别的实现子任务，请核对或直接输入实现任务编号。`);
      for (const child of implementations) add('implementation', child, 'parent');
      developmentIssue = implementations.length > 1 ? main : implementations[0];
    } else {
      if (source.subtasks?.length || source.issueType && !developmentType.test(source.issueType.name)) {
        throw new Error(`${source.key} 未找到可复用的前端开发任务。请核对 Jira 关联，或直接输入已建的开发主任务或实现任务编号。`);
      }
      add('implementation', source);
      developmentIssue = source;
    }
    return { sourceIssue: source, items, developmentIssue };
  }
  async function lookupFrontend(sourceIssue) {
    return resolveFrontend(await readFrontendReuse(sourceIssue));
  }
  async function prepareFrontend(record, lookup, selected) {
    Object.assign(record, resolveFrontend(lookup, selected));
    for (const role of roles) {
      const matches = record.items.filter(item => item.role === role);
      if (Object.keys(record.schedules[role]).length && matches.length !== 1) {
        throw new Error(`无法将排期应用到${names[role]}（匹配 ${matches.length} 张）。请留空保留原日期，或在 Jira 中单独调整。`);
      }
    }
    for (const item of record.items) await prepareSchedule(record, item);
    record.status = 'ready';
    record.sourceLink = { action: 'reuse', state: 'created' };
    record.requiresConfirmation = record.items.some(item => item.dateUpdate?.state === 'pending');
  }
  async function refreshFrontend(record, developmentKey) {
    const source = record.sourceIssue;
    if (!source?.key || !source.url || records.some(other => other.scope === record.scope && unknown(other))) {
      if (developmentKey) throw frontendChoiceError();
      return publicRecord(record);
    }
    const lookup = await readFrontendReuse(source);
    const available = frontendReuseCandidates(lookup);
    const selected = selectFrontend(available, developmentKey);
    if (!available.length && !record.developmentCandidates?.length) return publicRecord(record);

    const candidates = frontendChoices(available);
    let next = { ...record, developmentCandidates: candidates };
    next.warning = candidates.length ? frontendChoiceWarning(candidates) : '未找到可复用的关联开发主任务，请核对 Jira 关联后重新读取。';
    if (selected) {
      const preview = structuredClone(next);
      preview.schedules = schedulesFrom(preview.schedules);
      preview.reuseRuleVersion = reuseRuleVersion;
      try {
        await prepareFrontend(preview, lookup, selected);
        delete preview.developmentCandidates;
        delete preview.warning;
        next = preview;
      } catch (error) {
        if (['JIRA_SOURCE', 'JIRA_SITE_MISMATCH'].includes(error.code)) throw error;
        next.warning = `${error.message} 请调整后重新生成预览；本次不写 Jira。`;
      }
    }
    records[records.indexOf(record)] = next;
    await save();
    return publicRecord(next);
  }
  function repairFacts(record, issue) {
    record.targetProject = issue.project; record.assignee = issue.assignee; record.fixVersions = issue.fixVersions || [];
  }
  async function readScheduledIssue(item) {
    const issue = typeof jira.readIssue === 'function' ? await jira.readIssue(item.url) : (await jira.readRequirementScheduleContext(item.url)).issue;
    if (issue?.url !== item.url || issue?.key !== item.key) throw Object.assign(new Error('日期核验事项与已确认任务不一致。'), { code: 'JIRA_SITE_MISMATCH' });
    return issue;
  }
  async function prepareSchedule(record, item) {
    const requested = item.plannedSchedule || record.schedules?.[item.role] || {};
    if (item.action === 'reuse' && (!Object.hasOwn(item.issue || {}, 'startDate') || !Object.hasOwn(item.issue || {}, 'endDate'))) {
      if (typeof jira.readIssue === 'function' || typeof jira.readRequirementScheduleContext === 'function') reuse(item, await readScheduledIssue(item));
      else if (Object.keys(requested).length) throw new Error('当前连接不支持核验已有任务日期，请更新连接后重新预览。');
    }
    item.schedule = scheduleFor(item, requested);
    delete item.dateUpdate;
    if (!item.schedule.changed) return;
    if (typeof jira.readRequirementScheduleContext !== 'function') throw new Error('当前连接不支持核验已有任务日期，请更新连接后重新预览。');
    const context = await jira.readRequirementScheduleContext(item.url);
    if (context.issue?.url !== item.url || context.issue?.key !== item.key) throw Object.assign(new Error('日期核验事项与已确认任务不一致。'), { code: 'JIRA_SITE_MISMATCH' });
    if (context.startField && context.startField === context.endField) throw new Error('计划开始日期和计划结束日期不能配置为同一个 Jira 字段。');
    reuse(item, context.issue); item.schedule = scheduleFor(item, requested);
    if (!item.schedule.changed) return;
    const fields = {};
    for (const key of ['startDate', 'endDate']) {
      if (!requested[key] || requested[key] === item.schedule[key === 'startDate' ? 'previousStartDate' : 'previousEndDate']) continue;
      const fieldId = context?.[key === 'startDate' ? 'startField' : 'endField'], meta = context?.fields?.[fieldId];
      if (!fieldId || !meta || meta.schema?.type !== 'date' || !meta.operations?.includes('set')) throw new Error(`${names[item.role]}的${key === 'startDate' ? '计划开始日期' : '计划结束日期'}未在 Jira 编辑元数据中开放，保留本地预览。`);
      fields[fieldId] = requested[key];
    }
    item.dateUpdate = { state: 'pending', fields };
  }
  function draftItems(sourceIssue, details, repositoryId, repositoryName, scope, title) {
    return roles.map(role => {
      const marker = `jira-dev-requirement-${scope}-${role}`;
      const { multiProject, repositoryNames = [] } = title;
      const summary = requirementSummary(role, title);
      const description = [
        `需求来源：${sourceIssue.url || sourceIssue.key || '用户提供的需求材料'}`,
        multiProject ? `项目范围：${repositoryNames.join('、')}（共 ${repositoryNames.length} 个项目）` : repositoryName ? `仓库：${repositoryName}` : '', repositoryId ? `Repository ID: ${repositoryId}` : '',
        `目标版本：${sourceIssue.fixVersions?.length ? sourceIssue.fixVersions.map(version => version.name || version.id).join('、') : '来源未指定，不推测版本'}`,
        '范围与影响：以需求原文及用户补充为准；读取当前仓库代码后核对页面、接口与兼容影响，不扩展业务范围。',
        `交付内容：${names[role]}`,
        role === 'design' ? '根据产品需求与现有代码完成前端技术方案；已有方案先核对后复用。' : role === 'implementation' ? '依据已确认需求与技术方案完成实现、自测和交接；真实接口验证情况单独说明。' : `关联产品需求，承接${multiProject ? '所选项目' : '本仓库'}前端技术方案与实现。`,
        role === 'design' ? '交付物与完成条件：基于实际代码保存或核验可读的技术方案文件，记录真实路径；覆盖需求范围、交互与状态、接口暂拟项、影响及验证计划。未知后端字段明确待对齐，本地设计继续。' : role === 'implementation' ? '交付物与完成条件：完成已确认范围代码和必要检查，记录真实命令、结果与交接；区分静态检查、mock、浏览器和真实接口证据，mock 不代表真实联调或业务验收。' : '交付物与完成条件：技术方案有实际文件与来源，实现有代码和相称验证证据；未运行或待后端对齐部分如实记录，不虚报验收。',
        details ? `用户补充原文：\n${details}` : '',
        `需求标题原文：${sourceIssue.summary || ''}\n需求正文原文：\n${rawText(sourceIssue.description)}`,
        `JIRA_DEV_REQUIREMENT_MARKER: ${marker}`,
      ].filter(Boolean).join('\n\n');
      return { role, action: 'create', summary, description, marker, ...(role !== 'parent' ? { parentRole: 'parent' } : {}), state: 'pending', requiredFields: [] };
    });
  }
  function verifyMatch(record, item, issue, parentKey) {
    const suffix = `/browse/${record.sourceIssue.key}`, site = record.sourceIssue.url.slice(0, -suffix.length);
    if (!issue?.key || issue.url !== `${site}/browse/${issue.key}`) throw new Error('查重事项与来源 Jira 站点不一致，未复用或创建任务。');
    if (!rawText(issue.description).includes(`JIRA_DEV_REQUIREMENT_MARKER: ${item.marker}`) || !rawText(issue.description).includes(record.sourceIssue.url) || (record.repositoryId && !rawText(issue.description).includes(`Repository ID: ${record.repositoryId}`))) throw new Error('查重标记缺少准确来源或仓库证据，未复用或创建任务。');
    if (item.key && item.key !== issue.key) throw new Error('查重标记与已记录的事项编号不一致，未覆盖已有创建结果。');
    if (!item.parentRole ? issue.issueType?.subtask !== false || Boolean(issue.parent) : issue.issueType?.subtask !== true || !parentKey || issue.parent?.key !== parentKey) throw new Error('查重事项的父子归属与任务计划不一致，未复用或创建任务。');
    if (item.issueType && String(issue.issueType?.id) !== String(item.issueType.id)) throw new Error('查重事项类型与已确认预览不一致。');
    if (record.sourceKind === 'defect' && ((item.fields?.project?.key && issue.project?.key !== item.fields.project.key) || (item.fields?.project?.id && String(issue.project?.id) !== String(item.fields.project.id)))) throw new Error('查重事项的项目与已确认修复计划不一致，请核对已有事项。');
  }
  function createFields(item, type, context) {
    const meta = type?.fields || {}, issue = context.issue;
    if ((item.schedule?.startDate || item.schedule?.endDate) && context.startField && context.startField === context.endField) throw new Error('计划开始日期和计划结束日期不能配置为同一个 Jira 字段。');
    const fields = { project: issue.project?.id ? { id: issue.project.id } : { key: issue.project?.key }, issuetype: { id: type?.id }, summary: item.summary, description: item.description };
    const missing = [];
    for (const id of ['project', 'issuetype', 'summary', 'description']) if (!meta[id]) missing.push({ id, name: id });
    if (item.parentRole) { fields.parent = { key: '$parent' }; if (!meta.parent) missing.push({ id: 'parent', name: '父任务' }); }
    if (meta.labels) fields.labels = [item.marker];
    if (meta.assignee && context.assignee && (!Array.isArray(meta.assignee.allowedValues) || meta.assignee.allowedValues.some(user => context.assignee.accountId ? user.accountId === context.assignee.accountId : user.name === context.assignee.name))) fields.assignee = context.assignee;
    else missing.push({ id: 'assignee', name: '当前用户指派' });
    if (meta.reporter?.required && context.assignee) fields.reporter = context.assignee;
    for (const key of ['startDate', 'endDate']) {
      if (!item.schedule?.[key]) continue;
      const id = context[key === 'startDate' ? 'startField' : 'endField'], field = meta[id];
      if (!id || !field || field.schema?.type !== 'date' || !field.operations?.includes('set')) missing.push({ id: id || key, name: key === 'startDate' ? '计划开始日期' : '计划结束日期' });
      else fields[id] = item.schedule[key];
    }
    const allowed = (field, value) => !Array.isArray(field.allowedValues) || field.allowedValues.some(option => String(option.id ?? option.value ?? option) === String(value?.id ?? value?.value ?? value));
    for (const id of ['fixVersions', 'components']) {
      const values = issue[id] || [];
      if (!values.length) continue;
      if (id === 'fixVersions' && item.parentRole && !meta[id]) {
        item.description += '\n\n版本追踪：当前子任务创建屏幕未开放 FixVersion，目标版本由本组 DEV 父任务记录，子任务按父任务版本追踪。';
        fields.description = item.description; continue;
      }
      if (!meta[id] || values.some(value => !allowed(meta[id], value))) missing.push({ id, name: meta[id]?.name || id });
      else fields[id] = values.map(value => ({ id: String(value.id) }));
    }
    for (const [id, field] of Object.entries(meta)) {
      if (!field.required || field.hasDefaultValue === true || fields[id] !== undefined) continue;
      if (id === context.startField || id === context.endField || field.schema?.type === 'date') { missing.push({ id, name: field.name || id }); continue; }
      const value = issue.rawFields?.[id];
      const values = Array.isArray(value) ? value : [value];
      if (value == null || value === '' || !values.length || values.some(value => value == null || !allowed(field, value))) { missing.push({ id, name: field.name || id }); continue; }
      const normalized = values.map(value => typeof value !== 'object' ? value : value.id ? { id: String(value.id) } : value.value ? { value: value.value } : null);
      if (normalized.some(value => value == null)) missing.push({ id, name: field.name || id });
      else fields[id] = Array.isArray(value) ? normalized : normalized[0];
    }
    item.issueType = type ? { id: String(type.id), name: type.name, subtask: type.subtask } : undefined;
    item.requiredFields = [...new Map(missing.map(field => [field.id, field])).values()]; item.fields = fields;
  }
  async function search(record) {
    const result = await jira.findRequirementIssues({ sourceIssue: record.sourceIssue, repositoryId: record.repositoryId, markers: record.items.map(item => item.marker).filter(Boolean), ...(record.sourceKind === 'defect' ? { allProjects: true } : {}) });
    if (result.sourceIssue?.url !== record.sourceIssue.url) throw Object.assign(new Error('Jira 事项站点与任务来源不一致。'), { code: 'JIRA_SITE_MISMATCH' });
    if (result.truncated) throw new Error('查重结果未完整返回，先保留本地草稿，不创建重复任务。');
    return result;
  }
  function adoptMarked(record, issues) {
    const adopted = [];
    for (const item of record.items) {
      const candidates = issues.filter(issue => marked(issue, item.marker));
      if (candidates.length > 1) throw new Error(`${names[item.role]}标记匹配多个事项，请先核对，未创建新任务。`);
      if (candidates.length === 1) {
        verifyMatch(record, item, candidates[0], record.items.find(item => item.role === 'parent')?.key);
        if (item.action === 'create' && ['unknown', 'attempting', 'created'].includes(item.state)) verifyDates(item, candidates[0], true);
        if (item.action === 'create' && ['pending', 'error'].includes(item.state)) adopted.push(item);
        reuse(item, candidates[0]);
      }
    }
    return adopted;
  }
  async function reconcile(record) {
    try {
      const result = await search(record), adopted = adoptMarked(record, result.issues);
      for (const item of adopted) item.scheduleReviewRequired = true;
      for (const item of record.items.filter(item => item.scheduleReviewRequired)) { await prepareSchedule(record, item); delete item.scheduleReviewRequired; }
      for (const item of record.items.filter(item => item.dateUpdate?.state === 'unknown')) {
        const issue = await readScheduledIssue(item);
        verifyDates(item, issue);
        reuse(item, issue); item.dateUpdate.state = 'created'; delete item.dateUpdate.error;
      }
      if (record.sourceLink?.state === 'unknown') {
        const parent = linkedItem(record);
        if (result.sourceIssue.links?.some(link => link.key === parent?.key && String(link.type?.id) === String(record.sourceLink.type?.id))) record.sourceLink.state = 'created';
      }
      finish(record);
      if (record.status === 'ready') record.needsReconfirmation = true;
      else delete record.needsReconfirmation;
      if (record.status === 'unknown') record.warning = '仍有创建、排期或关联结果待核对；不会重放写入，请稍后只读核对任务标记和日期。';
      else delete record.warning;
      await save();
    } catch (error) {
      if (!unknown(record)) { record.status = 'error'; record.requiresConfirmation = true; }
      delete record.needsReconfirmation; record.warning = error.message; await save();
    }
    return publicRecord(record);
  }
  /** 缺陷仅拆出一张前端修复事项；共享确认、去重与未知结果恢复，不引入需求方案层级。 */
  async function prepareRepair(record, input) {
    if (!['create', 'reuse'].includes(input.repairMode)) throw new Error('请选择新建开发 Jira 或关联已有开发 Jira。');
    const context = await jira.readRequirementContext(record.sourceIssue.url, { projectKey: input.repairProject || '', linksOnly: input.repairMode === 'reuse' });
    if (context.issue?.url !== record.sourceIssue.url || context.issue?.key !== record.sourceIssue.key) throw Object.assign(new Error('缺陷来源与当前 Jira 连接不一致。'), { code: 'JIRA_SITE_MISMATCH' });
    record.sourceIssue = context.issue;
    const result = await search(record), item = record.items[0];
    const original = result.sourceIssue;
    const linkedKeys = new Set((original.links || []).map(link => link.key));
    const relatedParents = new Set(result.issues.filter(issue => linkedKeys.has(issue.key) && isDevelopmentParent(issue, result.issues)).map(issue => issue.key));
    const useExisting = issue => {
      if (!sameSite(original, issue)) throw Object.assign(new Error('已有开发 Jira 与缺陷站点不一致或未实时核验。'), { code: 'JIRA_SITE_MISMATCH' });
      if (issue.key === original.key) throw new Error('要复用的开发 Jira 与原缺陷相同；需要直接在原缺陷上修复时请选择“使用当前 Jira 直接修复”。');
      if (issue.issueType && !issue.issueType.subtask && !developmentType.test(issue.issueType.name)) throw new Error(`${issue.key} 不是开发任务，请填写开发主任务或修复子任务编号。`);
      delete item.marker;
      reuse(item, issue);
    };
    const chooseRepair = (candidates, key) => {
      if (candidates.length > 1) throw new Error(`${key} 对应多张前端修复任务：${candidates.map(issue => issue.key).join('、')}。请填写本次要修复的 Jira 编号。`);
      return candidates[0];
    };
    const explicit = input.repairMode === 'reuse' && input.repairSource?.trim();
    if (explicit) {
      const supplied = await jira.readIssue(explicit);
      if (!sameSite(original, supplied)) throw Object.assign(new Error('已有开发 Jira 与缺陷站点不一致或未实时核验。'), { code: 'JIRA_SITE_MISMATCH' });
      if (supplied.subtasks?.length) {
        const related = await search({ ...record, sourceIssue: supplied, items: [] });
        const child = chooseRepair(childrenOf(related.sourceIssue, related.issues).filter(isRepairTask), supplied.key);
        if (!child) throw new Error(`${supplied.key} 下未找到可确认的前端修复子任务，请直接填写修复 Jira 编号。`);
        useExisting(child);
      } else useExisting(supplied);
    } else {
      adoptMarked(record, result.issues);
      if (item.action !== 'reuse') {
        const candidates = result.issues.filter(issue => (issue.parent?.key === original.key || linkedKeys.has(issue.key) || relatedParents.has(issue.parent?.key)) && isRepairTask(issue));
        const related = chooseRepair(candidates, original.key);
        if (related) useExisting(related);
      }
    }
    if (item.action === 'reuse') {
      if (input.repairProject && item.issue.project?.key !== input.repairProject) throw new Error(`已有前端修复任务 ${item.key} 属于其他项目，请选择“复用已有开发 Jira”核对。`);
      item.schedule = scheduleFor(item);
    } else {
      if (input.repairMode === 'reuse') throw new Error(`未找到 ${original.key} 对应的前端修复任务。请填写已有开发主任务或修复子任务编号。`);
      const related = result.issues.filter(issue => linkedKeys.has(issue.key) && developmentTitle.test(issue.summary));
      if (related.length) throw new Error(`发现相关前端任务 ${related.map(issue => issue.key).join('、')}，请先选择“复用已有开发 Jira”核对，避免重复建单。`);
      const type = context.issueTypes.find(type => !type.subtask && /^(?:dev|development|开发任务|开发)$/i.test(type.name)) || context.issueTypes.find(type => !type.subtask && /^(?:task|任务)$/i.test(type.name));
      const targetProject = context.project || context.issue.project;
      if (input.repairProject && targetProject?.key !== input.repairProject) throw new Error('目标项目元数据与所选项目不一致。');
      const crossProject = targetProject?.key !== context.issue.project?.key;
      let fixVersions = crossProject ? [] : context.issue.fixVersions || [];
      if (input.repairVersion?.trim()) {
        const available = type?.fields?.fixVersions?.allowedValues || [];
        // 回填保留接口版本原名；仅未命中原名时容忍人工输入的首尾空格。
        const exact = available.filter(version => version.name === input.repairVersion);
        const matching = exact.length ? exact : available.filter(version => version.name === input.repairVersion.trim());
        if (matching.length !== 1 || !matching[0].id) throw new Error('目标项目中未找到唯一且可用的版本名称，请核对版本后重新预览。');
        fixVersions = [matching[0]];
      }
      createFields(item, type, { ...context, issue: { ...context.issue, project: targetProject, fixVersions, components: crossProject ? [] : context.issue.components, rawFields: crossProject ? {} : context.issue.rawFields } });
      record.targetProject = targetProject; record.assignee = context.account; record.fixVersions = fixVersions;
      if (!item.issueType || item.requiredFields.length) throw new Error(`创建元数据或必填字段未满足${item.requiredFields.length ? `（${item.requiredFields.map(field => field.name).join('、')}）` : ''}，请补齐后重新预览。`);
    }
    if (item.action === 'reuse') repairFacts(record, item.issue);
    const existingLink = item.key && result.sourceIssue.links?.find(link => link.key === item.key);
    const linkedAlready = existingLink || item.issue?.parent?.key === original.key || relatedParents.has(item.issue?.parent?.key);
    const type = context.linkTypes?.find(type => /relat|关联/i.test(`${type.name} ${type.inward || ''} ${type.outward || ''}`));
    if (!linkedAlready && !type) throw new Error(context.linkWarning || '未取得可用关联类型，暂不能建立原缺陷与前端任务的关联。');
    record.sourceLink = linkedAlready
      ? { action: 'reuse', state: 'created', type: existingLink?.type } : { action: 'create', state: 'pending', type };
    record.status = 'ready'; record.requiresConfirmation = true;
  }
  return {
    lookupFrontend,
    async lookupFrontendCandidates(issue) {
      return frontendChoices(frontendReuseCandidates(await readFrontendReuse(issue)));
    },
    prepare(input) { return serial(async () => {
      const { taskId, sourceKind, developmentKey, details = '', repositoryId = '', repositoryName = '', repositoryNames = [], businessModule = '' } = input;
      if (typeof taskId !== 'string' || !taskId || !['product', 'frontend', 'defect'].includes(sourceKind) || typeof details !== 'string' || details.length > 20000 || typeof repositoryId !== 'string' || repositoryId.length > 1000 || typeof repositoryName !== 'string' || repositoryName.length > 200) throw new Error('前端任务参数不正确。');
      if (!Array.isArray(repositoryNames) || repositoryNames.length > 10 || repositoryNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 200 || /[\r\n]/u.test(name))) throw new Error('所选项目名称参数不正确。');
      const schedules = schedulesFrom(input.schedules);
      const sourceIssue = structuredClone(input.sourceIssue || { key: '', url: '', summary: details.split(/\r?\n/)[0] || '本地需求', description: details });
      if (sourceKind === 'product' && (typeof businessModule !== 'string' || businessModule.length > 100)) throw new Error('业务模块参数不正确。');
      const title = sourceKind === 'product' ? requirementTitle(sourceIssue, details, businessModule, repositoryNames) : { businessModule: '', subject: sourceIssue.summary || sourceIssue.key };
      if (sourceIssue.url) {
        const identity = sourceIdentity(sourceIssue.url);
        if (identity.key !== sourceIssue.key || identity.url !== sourceIssue.url) throw new Error('产品需求编号与来源链接不一致。');
      }
      const scope = scopeOf(sourceIssue, repositoryId, repositoryName, sourceKind);
      const prior = records.find(record => record.taskId === taskId);
      if (prior && (prior.scope !== scope || prior.sourceKind !== sourceKind)) throw new Error('任务预览不能改绑其他需求或仓库。');
      if (prior && (unknown(prior) || prior.status === 'applied')) return publicRecord(prior);
      const destination = Object.hasOwn(input, 'designDestination') ? normalizeDesignDestination(input.designDestination) : defaultDesignDestination();
      const record = { taskId, sourceKind, sourceIssue, repositoryId, repositoryName, scope, schedules, ...(prior ? prior.designDestination ? { designDestination: prior.designDestination } : {} : destination ? { designDestination: destination } : {}), titleRuleVersion, scheduleRuleVersion, businessModule: title.businessModule, status: 'local', requiresConfirmation: false, items: draftItems(sourceIssue, details, repositoryId, repositoryName, scope, title), createdAt: new Date().toISOString() };
      if (sourceKind === 'frontend' || sourceKind === 'defect') record.reuseRuleVersion = reuseRuleVersion;
      if (sourceKind === 'frontend') record.items = [];
      if (sourceKind === 'defect') {
        delete record.designDestination;
        record.repairMode = input.repairMode;
        const marker = `jira-dev-requirement-${scope}-implementation`;
        const summary = input.repairSummary?.trim() || `前端修复 ${sourceIssue.summary || sourceIssue.key}`;
        record.items = [{ role: 'implementation', action: 'create', state: 'pending', requiredFields: [], marker, summary: summary.slice(0, 250), description: [`缺陷来源：${sourceIssue.url || sourceIssue.key}`, `原缺陷标题：${sourceIssue.summary || ''}`, `原缺陷正文：\n${rawText(sourceIssue.description)}`, details ? `前端修复范围：\n${details}` : '前端修复范围：定位本仓库相关问题，修复并自测，记录待后端配合和联调事项。', repositoryName ? `仓库：${repositoryName}` : '', repositoryId ? `Repository ID: ${repositoryId}` : '', '完成条件：保留代码、自测和交接证据；前端完成不等于原缺陷验收通过，不自动关闭原缺陷或变更后端任务。', `JIRA_DEV_REQUIREMENT_MARKER: ${marker}`].filter(Boolean).join('\n\n') }];
      }
      for (const item of record.items) item.schedule = scheduleFor(item, schedules[item.role]);
      const persist = async () => {
        if (record.status === 'local' && record.repairMode === 'reuse') record.items = record.items.filter(item => item.action === 'reuse');
        if (prior) records[records.indexOf(prior)] = record;
        else records.push(record);
        await save();
        return publicRecord(record);
      };
      const unresolved = records.find(other => other.scope === scope && unknown(other));
      if (developmentKey && (unresolved || !sourceIssue.url || sourceIssue.materialStatus || !sourceIssue.key)) throw frontendChoiceError();
      if (unresolved) { record.warning = sourceKind === 'defect' ? `同一缺陷和仓库已有待核对操作（taskId=${unresolved.taskId}）；请读取原任务核对，本次不重复建单。` : `同一需求和仓库已有待核对操作（taskId=${unresolved.taskId}）；本次不创建新 Jira，仍可继续本地方案与实现。请读取原任务核对。`; return persist(); }
      if (!sourceIssue.url || sourceIssue.materialStatus || !sourceIssue.key) { record.warning = sourceKind === 'defect' ? '原缺陷尚未实时核验，请恢复 Jira 连接并重新预览；本次不创建任务。' : '未实时核验产品需求或缺少完整 Jira 来源；保留本地任务草稿，可继续技术方案和实现，不创建虚构编号。'; return persist(); }
      try {
        if (sourceKind === 'defect') { await prepareRepair(record, input); return persist(); }
        if (sourceKind === 'frontend') {
          const lookup = await readFrontendReuse(record.sourceIssue);
          const available = frontendReuseCandidates(lookup);
          const selected = selectFrontend(available, developmentKey);
          if (!selected && available.length > 1) {
            record.developmentCandidates = frontendChoices(available);
            record.warning = frontendChoiceWarning(available);
          } else await prepareFrontend(record, lookup, selected);
          return persist();
        }
        const context = await jira.readRequirementContext(sourceIssue.url);
        if (context.issue?.url !== sourceIssue.url || context.issue.key !== sourceIssue.key) throw Object.assign(new Error('读取的产品需求与已确认来源不一致。'), { code: 'JIRA_SITE_MISMATCH' });
        record.sourceIssue = context.issue;
        const verifiedTitle = requirementTitle(context.issue, details, businessModule, repositoryNames);
        record.businessModule = verifiedTitle.businessModule;
        record.items = draftItems(context.issue, details, repositoryId, repositoryName, scope, verifiedTitle);
        for (const item of record.items) item.schedule = scheduleFor(item, schedules[item.role]);
        let result = await search(record);
        const parentItem = record.items[0];
        adoptMarked({ ...record, items: [parentItem] }, result.issues);
        if (parentItem.state !== 'created') {
          const relatedKeys = new Set([...(result.sourceIssue.links || []).map(issue => issue.key), ...(result.sourceIssue.subtasks || []).map(issue => issue.key)]);
          const related = result.issues.filter(issue => relatedKeys.has(issue.key) && isDevelopmentParent(issue, result.issues));
          const scoped = related.filter(issue => (repositoryId && rawText(issue.description).includes(`Repository ID: ${repositoryId}`)) || (repositoryName && `${issue.summary}\n${rawText(issue.description)}`.includes(repositoryName)) || (!repositoryId && !repositoryName));
          if (scoped.length === 1) reuse(parentItem, scoped[0]);
          else if (related.length) throw new Error('发现已有相关前端任务，但仓库归属或数量不唯一；请选择该前端任务复用，本地方案与实现可继续。');
        }
        if (parentItem.key && parentItem.issue?.project?.id && String(parentItem.issue.project.id) !== String(context.issue.project?.id)) throw new Error('已有前端任务属于另一项目；请以该前端任务为来源核验复用，未创建跨项目子任务，本地方案与实现可继续。');
        record.schedules.parent = Object.fromEntries(['startDate', 'endDate'].map(key => [key, schedules.parent[key] || parentItem.issue?.[key] || context.issue[key] || '']));
        await prepareSchedule(record, parentItem);
        splitChildren(record, verifiedTitle, details);
        result = await search(record); adoptMarked(record, result.issues);
        if (parentItem.key) for (const item of record.items.slice(1)) {
          if (item.state === 'created') continue;
          const children = result.issues.filter(issue => issue.parent?.key === parentItem.key && !record.items.some(candidate => candidate.key === issue.key) && issue.startDate === item.schedule.startDate && issue.endDate === item.schedule.endDate && (item.role === 'design' ? /技术方案|tech(?:nical)?[ -]?design/i.test(issue.summary) : /实现|开发|implementation/i.test(issue.summary) && !/技术方案|design/i.test(issue.summary)));
          if (children.length > 1) throw new Error(`${names[item.role]}存在多个相关子任务，请先核对，本地开发可继续。`);
          if (children.length === 1) reuse(item, children[0]);
        }
        if (parentItem.key && result.issues.some(issue => issue.parent?.key === parentItem.key && !record.items.some(item => item.key === issue.key) && /技术方案|实现|开发|implementation|tech(?:nical)?[ -]?design/i.test(issue.summary))) throw new Error('已有子任务与本次拆分日期不一致，请先核对已有排期，避免重复创建子任务。');
        if (!record.businessModule && record.items.some(item => item.action === 'create')) throw new Error('需求中未明确业务模块，请填写“业务模块”后重新生成预览；不使用仓库名、项目名或研发角色代替。');
        for (const item of record.items) await prepareSchedule(record, item);
        const parentType = context.issueTypes.find(type => !type.subtask && /^(?:dev|development|开发任务|开发)$/i.test(type.name)) || context.issueTypes.find(type => !type.subtask && /^(?:task|任务)$/i.test(type.name));
        const subType = context.issueTypes.find(type => type.subtask);
        for (const item of record.items.filter(item => item.action === 'create')) createFields(item, item.role === 'parent' ? parentType : subType, context);
        const linkType = context.linkTypes?.find(type => /relat|关联/i.test(`${type.name} ${type.inward || ''} ${type.outward || ''}`));
        const existingLink = parentItem.key && result.sourceIssue.links?.find(link => link.key === parentItem.key);
        record.sourceLink = existingLink ? { action: 'reuse', state: 'created', type: existingLink.type } : linkType ? { action: 'create', state: 'pending', type: linkType } : { action: 'description', state: 'created', warning: context.linkWarning || '未取得允许的来源关联类型；父任务正文已保留产品需求链接。' };
        const missing = record.items.flatMap(item => item.requiredFields.map(field => `${names[item.role]}：${field.name}`));
        if (record.items.some(item => item.action === 'create' && !item.issueType) || missing.length) throw new Error(`创建元数据或必填字段未满足${missing.length ? `（${missing.join('、')}）` : ''}；保留本地任务草稿，可继续方案与实现。`);
        record.status = 'ready'; record.requiresConfirmation = record.items.some(item => item.action === 'create' || item.dateUpdate?.state === 'pending') || record.sourceLink.action === 'create';
        if (record.sourceLink.warning) record.warning = record.sourceLink.warning;
      } catch (error) {
        if (['JIRA_SOURCE', 'JIRA_SITE_MISMATCH', 'JIRA_FRONTEND_CHOICE'].includes(error.code)) throw error;
        record.status = 'local'; record.requiresConfirmation = false; record.warning = `${error.message} ${sourceKind === 'product' ? '本地方案与实现不受影响；本次不写 Jira。' : '请调整后重新生成预览；本次不写 Jira。'}`;
      }
      return persist();
    }); },
    bindExistingForAutomation({ taskId, issueKey, issueUrl }) { return serial(async () => {
      const record = find(taskId);
      const sameIssue = issue => issue?.key === issueKey && issue.url === issueUrl;
      const implementation = record.items.find(item => item.role === 'implementation');
      // 巡检只绑定已经核验的前端事项，不经过可能写 Jira 或授权发布的 apply。
      if (record.sourceKind !== 'frontend' || !['ready', 'applied'].includes(record.status)
        || record.requiresConfirmation || record.needsReconfirmation || !record.reuseRuleVersion
        || needsTitleReview(record) || needsScheduleReview(record)
        || !sameIssue(record.sourceIssue) || !sameIssue(record.developmentIssue) || !sameIssue(implementation?.issue)
        || record.items.filter(item => item.role === 'implementation').length !== 1
        || record.sourceLink?.action !== 'reuse' || record.sourceLink.state !== 'created'
        || record.items.some(item => item.action !== 'reuse' || item.state !== 'created' || !item.key || !item.url
          || item.schedule?.changed || item.dateUpdate || item.scheduleReviewRequired)) {
        throw new Error('计划需要人工核对，请打开巡检预览后确认。');
      }
      if (record.status !== 'applied') { finish(record); await save(); }
      return publicRecord(record);
    }); },
    apply({ taskId, confirmed }) { return serial(async () => {
      if (confirmed !== true) throw new Error('请先审阅并明确确认前端 Jira 任务预览。');
      const record = find(taskId);
      if (unknown(record)) return reconcile(record);
      if (record.status === 'ready' && ['frontend', 'defect'].includes(record.sourceKind) && !record.reuseRuleVersion) throw new Error('Jira 复用规则已更新，请重新生成预览。');
      if (needsTitleReview(record)) throw new Error('任务标题规则已更新，请核对业务模块和项目范围后重新生成预览；未创建新 Jira 事项。');
      if (needsScheduleReview(record)) throw new Error('子任务拆分规则已更新，请按主任务日期重新生成预览；未创建新 Jira 事项。');
      if (record.needsReconfirmation) { delete record.needsReconfirmation; await save(); }
      if (record.designDestination && !record.designPublicationAuthorized) { record.designPublicationAuthorized = true; await save(); }
      if (record.status === 'applied' || record.status === 'local') return publicRecord(record);
      const unresolved = records.find(other => other.taskId !== taskId && other.scope === record.scope && unknown(other));
      if (unresolved) { record.status = 'local'; record.requiresConfirmation = false; record.warning = record.sourceKind === 'defect' ? `同一缺陷和仓库的 taskId=${unresolved.taskId} 结果待核对；请读取原任务核对，不重复建单。` : `同一需求和仓库的 taskId=${unresolved.taskId} 结果待核对；不再 POST，可继续本地开发。`; await save(); return publicRecord(record); }
      try {
        const result = await search(record), adopted = adoptMarked(record, result.issues);
        for (const item of adopted) item.scheduleReviewRequired = true;
        const reviewItems = record.items.filter(item => item.scheduleReviewRequired);
        if (record.sourceKind === 'defect' && reviewItems.length) {
          for (const item of reviewItems) { item.schedule = scheduleFor(item); delete item.dateUpdate; delete item.scheduleReviewRequired; repairFacts(record, item.issue); }
          record.status = 'ready'; record.requiresConfirmation = true; record.needsReconfirmation = true;
          record.warning = '查重发现已有前端任务，请核对原负责人、版本和日期后再次确认；不会重复建单或修改已有排期。';
          await save(); return publicRecord(record);
        }
        for (const item of reviewItems) { await prepareSchedule(record, item); delete item.scheduleReviewRequired; }
        if (reviewItems.length && record.items.some(item => item.dateUpdate?.state === 'pending')) {
          record.status = 'ready'; record.requiresConfirmation = true;
          record.warning = '查重发现了已有任务，请核对已有日期与拟修改日期后再次确认；本次尚未写入排期。';
          await save(); return publicRecord(record);
        }
        if (record.sourceLink?.action === 'create') {
          const parent = linkedItem(record);
          if (result.sourceIssue.links?.some(link => link.key === parent?.key && String(link.type?.id) === String(record.sourceLink.type?.id))) record.sourceLink.state = 'created';
        }
        for (const item of record.items) {
          if (item.dateUpdate && item.dateUpdate.state !== 'created') {
            item.dateUpdate.state = 'attempting'; item.dateUpdate.attemptedAt = new Date().toISOString(); await save();
            try {
              const updated = await jira.updateRequirementDates({
                source: item.url,
                ...(item.schedule.startDate !== item.schedule.previousStartDate ? { startDate: item.schedule.startDate } : {}),
                ...(item.schedule.endDate !== item.schedule.previousEndDate ? { endDate: item.schedule.endDate } : {}),
                expectedStartDate: item.schedule.previousStartDate, expectedEndDate: item.schedule.previousEndDate, confirmed: true,
              });
              if (!updated?.verified || updated.key !== item.key || updated.url !== item.url) throw Object.assign(new Error('任务排期未能回读核对。'), { uncertain: true });
              verifyDates(item, updated);
              reuse(item, updated); item.dateUpdate.state = 'created'; delete item.dateUpdate.error; await save();
            } catch (error) {
              item.dateUpdate.state = error.uncertain === false ? 'error' : 'unknown'; item.dateUpdate.error = error.message;
              record.status = item.dateUpdate.state === 'unknown' ? 'unknown' : 'error'; record.requiresConfirmation = item.dateUpdate.state === 'error'; record.warning = error.message;
              await save(); return publicRecord(record);
            }
          }
          if (item.state === 'created') continue;
          const parent = linkedItem(record);
          const fields = structuredClone(item.fields);
          if (item.parentRole) { if (!parent?.key) throw new Error('父任务尚未核对，未创建子任务。'); fields.parent = { key: parent.key }; }
          item.state = 'attempting'; item.attemptedAt = new Date().toISOString(); await save();
          try {
            const created = await jira.createRequirementIssue({ source: record.sourceIssue.url, fields, marker: item.marker, confirmed: true });
            if (!created?.verified || !created.key || !created.url || !marked(created, item.marker)) throw Object.assign(new Error('创建任务未能回读核对标记。'), { uncertain: true });
            verifyMatch(record, item, created, parent?.key);
            verifyDates(item, created, true);
            Object.assign(item, { state: 'created', key: created.key, url: created.url, issue: created }); delete item.error;
            if (item.role === 'implementation') record.developmentIssue = created;
            await save();
          } catch (error) {
            item.state = error.uncertain === false ? 'error' : 'unknown'; item.error = error.message;
            if (error.key) { item.key = error.key; item.url = error.url; }
            record.status = item.state === 'unknown' ? 'unknown' : 'error'; record.requiresConfirmation = item.state === 'error'; record.warning = error.message; await save(); return publicRecord(record);
          }
        }
        if (record.sourceLink?.action === 'create' && record.sourceLink.state !== 'created') {
          const parent = linkedItem(record);
          record.sourceLink.state = 'attempting'; record.sourceLink.attemptedAt = new Date().toISOString(); await save();
          try {
            const linked = await jira.linkRequirementIssues({ source: record.sourceIssue.url, toKey: parent.key, typeId: record.sourceLink.type.id, confirmed: true });
            if (!linked?.verified) throw Object.assign(new Error('来源关联未能 GET 回读核对。'), { uncertain: true });
            record.sourceLink.state = 'created'; delete record.sourceLink.error; await save();
          } catch (error) {
            record.sourceLink.state = error.uncertain === false ? 'error' : 'unknown'; record.sourceLink.error = error.message;
            record.status = record.sourceLink.state === 'unknown' ? 'unknown' : 'error'; record.requiresConfirmation = record.sourceLink.state === 'error'; record.warning = error.message; await save(); return publicRecord(record);
          }
        }
        finish(record); delete record.warning; await save(); return publicRecord(record);
      } catch (error) { record.warning = `${error.message} ${record.sourceKind === 'defect' ? '本次未继续写 Jira，请核对已有任务后再确认未完成项。' : '本次未继续写 Jira，可保留已有任务并继续本地开发。'}`; record.status = 'error'; record.requiresConfirmation = true; await save(); return publicRecord(record); }
    }); },
    get({ taskId, refreshFrontend: refresh, developmentKey }) { return serial(async () => {
      const record = find(taskId);
      const localFrontend = record.sourceKind === 'frontend' && record.status === 'local' && !unknown(record);
      if (developmentKey && (!refresh || !localFrontend)) throw frontendChoiceError();
      if (refresh && localFrontend) return refreshFrontend(record, developmentKey);
      return unknown(record) ? reconcile(record) : publicRecord(record);
    }); },
  };
}
