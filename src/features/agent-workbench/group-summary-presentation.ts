/** 只整理当前轮已有结论；不按日志关键词猜测产品缺陷，不更改流程放行状态。 */
import { readAgentDeliveryReport } from '../../../shared/delivery-report';
import { agentTaskResultSchema } from '../../../shared/agent-task-result';
import { deliveryEvidenceSchema } from '../../../shared/delivery-acceptance';
import { requirementDeliverySchema, requirementProgressDataSchema, requirementStages, requirementStageStatusLabels } from '../../../shared/requirement-development';
import { agentReplyText } from './execution-summary';
import type { GroupRoundSummary, GroupSummaryMember } from './group-chat-summary';

export interface GroupSummaryPoint {
  title: string;
  detail: string;
}

export interface GroupRoleDigest {
  id: string;
  name: string;
  statusLabel: string;
  state?: 'failed' | 'blocked' | 'returned';
  summary: string;
  run?: GroupSummaryMember['run'];
}

export interface GroupMemberFeedback {
  statusLabel: string;
  title: string;
  checks: GroupSummaryPoint[];
  nextStep: string;
}

function scenarioNames(scenes: { name: string }[]) {
  const names = scenes.map(scene => scene.name.replace(/^AC-\d+\s*[：:]\s*/i, '').replace(/Mock/gi, '模拟数据')
    .replace(/新增提交/g, '新增并保存').replace(/编辑回显/g, '打开编辑页面查看内容')
    .replace(/保存刷新回读/g, '保存后刷新页面核对内容').replace(/防串值/g, '切换记录时核对内容')
    .replace(/回显/g, '显示').replace(/回读/g, '核对结果'))
    .filter(name => name.length <= 80 && !/\b\d{5,}\b|\bL\d{4,}\b|\b[A-Z]+\d+[A-Z]*\d{3,}\b|https?:|[\\/]|\.(?:json|log|vue|js)\b|i18n|npm|退出码|key\b/i.test(name)).slice(0, 3);
  return names.join('；') + (scenes.length > names.length ? `${names.length ? '；另有' : '共'}${scenes.length - names.length}项业务检查，具体记录可展开查看` : '');
}

/** 从本轮场景和检查状态生成可读结果；原始记录保留在详情，流程状态不变。 */
export function groupMemberFeedback(member: GroupSummaryMember): GroupMemberFeedback | undefined {
  if (member.turn.member.capability !== 'verify' || member.run?.resultReady === false
    || ['pending', 'queued', 'running', 'saving'].includes(member.run?.status || member.turn.status)) return;
  try {
    const report = readAgentDeliveryReport(member.run ? member.run.result : member.turn.result) as Record<string, unknown>;
    if (report?.version !== 1) return;
    const task = agentTaskResultSchema.safeParse(report.taskResult);
    const validation = deliveryEvidenceSchema.safeParse(report.validationEvidence);
    const browser = validation.success ? validation.data.browser : undefined;
    const delivery = requirementDeliverySchema.safeParse(report.requirementDelivery);
    if (delivery.success) {
      const { scenarios, i18n, api } = delivery.data;
      const passed = scenarios.filter(scene => scene.status === 'passed');
      const unfinished = scenarios.filter(scene => ['blocked', 'not_run'].includes(scene.status));
      const failed = scenarios.filter(scene => scene.status === 'failed');
      const testsFailed = validation.success && validation.data.tests.status === 'failed';
      const interrupted = browser?.status === 'pending' && browser.evidence.split(/[。；;\n]/)
        .some(text => /cgWindowNotFound|browser access host is unavailable|无法操作浏览器|浏览器操作中断/i.test(text) && !/已解决|已恢复|未出现/.test(text));
      const missingText = i18n.status === 'blocked' && /缺少|缺失|仍缺|均缺|缺词条/.test(i18n.evidence);
      const checks: GroupSummaryPoint[] = [];
      const mockOnly = api?.status === 'mock_only' || delivery.data.previews.length > 0 && delivery.data.previews.every(preview => preview.mode === 'mock');
      if (passed.length) checks.push({ title: '已验证', detail: `${mockOnly ? '使用模拟数据：' : ''}${scenarioNames(passed)}` });
      if (unfinished.length) checks.push({ title: '还没验证', detail: scenarioNames(unfinished) });
      if (failed.length) checks.push({ title: '未通过', detail: scenarioNames(failed.map(scene => missingText && /i18n|多语言|翻译|词条/i.test(scene.name)
        ? { name: '多语言检查：部分页面文字尚未准备齐' } : scene)) });
      if (missingText && !failed.length) checks.push({ title: '页面文字', detail: '部分页面文字尚未准备齐，需要补齐后再检查。' });
      if (testsFailed) checks.push({ title: '自动检查', detail: '仍有未通过项，完整检查记录可展开查看。' });
      else if (validation.success && validation.data.tests.status === 'passed') checks.push({ title: '自动检查', detail: '报告中记录的自动检查已通过。' });
      if (interrupted) checks.push({ title: '中断原因', detail: '验证工具暂时无法操作浏览器窗口，后续页面操作还没测完。' });
      if (api) checks.push({ title: '接口验证', detail: { passed: '真实接口验证已通过。', failed: '真实接口验证未通过，需要处理后重新验证。',
        blocked: '真实接口验证受阻，尚未完成。', not_run: '真实接口尚未验证。', mock_only: '目前只用模拟数据验证，真实接口尚未验证。', not_applicable: '本次需求不涉及接口验证。' }[api.status] });
      const failedResult = testsFailed || failed.length > 0 || api?.status === 'failed' || member.outcome?.state === 'failed';
      const incomplete = unfinished.length > 0 || interrupted || i18n.status === 'blocked' || ['blocked', 'not_run', 'mock_only'].includes(api?.status || '')
        || browser?.status === 'pending' || task.success && task.data.status === 'blocked';
      const actions = [interrupted ? '恢复浏览器操作后，继续验证尚未完成的业务操作。' : unfinished.length ? '继续验证尚未完成的业务操作。' : '',
        missingText ? '补齐页面文字后重新检查。' : failedResult ? '处理未通过的检查项后重新验证。' : '',
        api && ['blocked', 'failed', 'not_run', 'mock_only'].includes(api.status) ? '完成真实接口验证。' : ''].filter(Boolean);
      return { statusLabel: failedResult ? '仍有检查未通过' : incomplete ? '还有操作未验证' : '检查结果已返回',
        title: failedResult || incomplete ? '业务验证还没完成' : '本轮验证结果', checks,
        nextStep: actions.join('') || '按已验证的场景核对结果，再确认是否验收。' };
    }
    if (!task.success || task.data.role !== 'verifier' || task.data.status !== 'blocked') return;
    if (browser?.status === 'passed') return;
    const blockers = [...task.data.blockers, browser?.evidence || ''].flatMap(text => text.split(/[。；;\n]/))
      .filter(text => !/已恢复|已解决|已修复|不再出现|未发现|未出现|未复现/.test(text));
    if (!blockers.some(text => /ERR_CONNECTION_REFUSED|ECONNREFUSED|拒绝连接|无监听|(?:入口|测试页面|本地服务).{0,120}(?:不可用|无法连接|未启动)/i.test(text))) return;
    const tests = validation.success ? validation.data.tests : undefined;
    const testsFailed = tests?.status === 'failed';
    const otherChecksFailed = !testsFailed && task.data.selfTests.some(test => test.exitCode !== null && test.exitCode !== 0);
    const acceptanceFailed = task.data.acceptance.some(item => item.status === 'failed');
    const checks = [{ title: '页面操作', detail: '测试页面无法连接，页面上的操作还没有验证结果。' }];
    checks.push({ title: '自动检查', detail: testsFailed ? '已执行，仍有未通过项，需要排查原因。'
      : tests?.status === 'passed' ? '已通过；页面上的实际操作还需要继续验证。'
      : tests?.status === 'not_applicable' ? '报告标记为本轮不适用。' : '本轮尚无通过或失败的明确结论。' });
    if (otherChecksFailed) checks.push({ title: '其他检查', detail: '报告记录了未执行成功的检查，需要确认原因；这不代表业务功能已测出问题。' });
    if (acceptanceFailed) checks.push({ title: '验收检查', detail: '报告中另有验收项未通过，具体原因见原始报告。' });
    if (blockers.some(text => /(?:缺少|未恢复|尚未恢复|未提供).*(?:原始文件|原文件|请求归档|历史请求|测试资料)|(?:原始文件|原文件|请求归档|历史请求|测试资料).*(?:缺少|未恢复|尚未恢复|未提供)/.test(text))) {
      checks.push({ title: '测试准备', detail: '报告还提到缺少原始测试资料，需要确认如何准备后再继续。' });
    }
    return {
      statusLabel: testsFailed ? '页面未测 · 自动检查未通过' : otherChecksFailed ? '页面未测 · 检查未通过' : acceptanceFailed ? '页面未测 · 验收有未通过项' : '等待测试环境',
      title: '业务验证还没完成', checks,
      nextStep: `先恢复可访问的测试页面，再继续验证页面操作。${testsFailed ? '同时排查未通过的自动检查。' : otherChecksFailed ? '同时核对其他检查未成功的原因。' : ''}${acceptanceFailed ? '还需处理报告中的未通过验收项。' : ''}`,
    };
  } catch { return; }
}

// ponytail: 仅解释报告明确断言的问题；未知术语保留待说明，不扫描混有成功/失败过程的命令日志。
const plainIssueRules = [
  { id: 'original-text', pattern: /接口文案转换|改写接口原文|接口文案被改写|L\s*码被(?:替换|翻译)/,
    title: '页面上的部分文字被改写', impact: '用户看到的文字与原始返回的文字不一致。', action: '让页面原样显示收到的文字，再检查相关页面。' },
  { id: 'initial-state', pattern: /初始状态|初始态/,
    title: '页面刚打开时，默认内容不符合需求', impact: '用户还没有操作，页面的默认显示就与需求不一致。', action: '按需求调整页面打开时的内容和默认选项。' },
  { id: 'feature-toggle', pattern: /灰度直接链接展示|非灰度直链仍显示|灰度关闭.*仍显示/,
    title: '关闭新功能后，仍能看到部分新内容', impact: '从链接直接进入某些页面时，仍会出现应隐藏的新功能内容。', action: '让这些入口也遵守功能开关，关闭后再重新检查。' },
  { id: 'translation-file', pattern: /(?:词条.{0,8}撞号|重复编号|编号重复).*(?:导入表|导入文件)|(?:导入表|导入文件).*(?:词条.{0,8}撞号|重复编号|编号重复)/,
    title: '多语言文件中有重复的文字编号', impact: '直接导入文件可能覆盖系统里原有的文字。', action: '先修改重复编号，重新生成并检查多语言文件，再决定是否导入。' },
  { id: 'missing-translations', pattern: /英文回退缺项|缺少.*翻译|缺.*英文回退/,
    title: '部分页面文字缺少对应翻译', impact: '页面可能直接显示内部编号，用户看不到正常文字。', action: '补齐这些文字的翻译，再检查页面显示。' },
  { id: 'account-filter', pattern: /账户(?:筛选)?参数.*(?:未经后端确认|待与后端|需与后端)|账户筛选.*未确认/,
    title: '不同账户的数据是否分开显示，还没有确认', impact: '报告提出账户筛选方式尚待确认，不能据此断定数据已经混在一起。', action: '先确认不同账户的筛选规则，再使用真实数据检查。' },
  { id: 'option-matching', pattern: /收单行按名称匹配|未确认的收单行回退为猜测值/,
    title: '部分选项的识别和提交方式需要确认', impact: '选项名称或编号变化时，页面可能选错内容或少显示应填写的信息。', action: '按约定的原始编号识别选项，并核对保存时提交的值。' },
  { id: 'record-editing', pattern: /新模式记录的编辑路径|新记录编辑态兼容问题|必填无法保存/,
    title: '部分已有记录编辑后，可能无法正常保存', impact: '审查报告指出，编辑某些记录时可能无法保存，或保存的信息不完整。', action: '修正已有记录的编辑和保存流程，再重新检查。' },
  { id: 'column-order', pattern: /列表列顺序|列顺序.*(?:不符|差异)/,
    title: '列表的列顺序与需求不一致', impact: '页面上的信息排列与确认的需求不一致。', action: '按需求调整列顺序，再核对页面。' },
  { id: 'form-controls', pattern: /单选按钮与原型下拉框不一致/,
    title: '部分选择按钮与确认的设计不一致', impact: '设计要求使用下拉选择的地方，目前显示成了单选按钮。', action: '按确认的设计调整选择方式，再检查选择和保存操作。' },
  { id: 'list-refresh', pattern: /分类分页覆盖|慢分页覆盖刷新/,
    title: '刷新列表时，可能被较早的数据覆盖', impact: '较慢的旧请求可能覆盖最新列表，让用户看到过时结果。', action: '处理请求返回顺序，再检查刷新和翻页操作。' },
  { id: 'cancel-time', pattern: /取消时间退回审核时间/,
    title: '部分记录的取消时间可能显示不准确', impact: '审查报告指出，有的记录会用审核时间代替取消时间。', action: '分别显示对应的时间，修正后重新检查。' },
  { id: 'record-status', pattern: /状态取值顺序变化/,
    title: '部分记录显示的状态还需要核对', impact: '审查报告指出状态的取值方式有变化，需要确认页面显示是否准确。', action: '确认每种状态应显示什么，再逐项检查页面。' },
  { id: 'total-amount', pattern: /汇总金额使用猜测字段/,
    title: '汇总金额的取值方式还需要确认', impact: '报告指出金额取自尚未确认的数据字段，当前显示结果需要核对。', action: '先确认总金额应取哪个值，再用真实数据核对。' },
  { id: 'design', pattern: /审查发现与实际代码不符|与\s*PRD\s*和原型不符|与\s*PRD\s*\/\s*原型.*差异/,
    title: '技术方案还有内容需要修正', impact: '报告指出，方案中的部分内容与确认的需求或现有实现不一致。', action: '先修正不一致的说明，核对后再发布技术方案。' },
];

function plainIssues(assertions: { text: string; member: GroupSummaryMember }[]) {
  const clauses = assertions.flatMap(item => item.text.split(/[。；;\n]/).filter(text => text.trim()
    && !/未发现|未出现|未复现|已修复|已解决|不再出现|不存在|已消除|已符合|与(?:需求|原型|设计)一致|无需(?:修改|修复|调整|处理)|已通过/.test(text)).map(text => ({ ...item, text })));
  return plainIssueRules.flatMap(({ pattern, ...rule }) => {
    const matches = clauses.filter(item => pattern.test(item.text));
    if (!matches.length) return [];
    return [{ ...rule, sources: [...new Map(matches.map(item => [item.member.turn.id, item.member])).values()] }];
  });
}

function cleanInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s，。；、）)”"']+/g, '')
    .replace(/<br\s*\/?>/gi, '；')
    .replace(/[*_`~]/g, '')
    .replace(/（[^）]*\/Users\/[^）]+）/g, '')
    .replace(/\([^)]*\/Users\/[^)]+\)/g, '')
    .replace(/\/Users\/[^\s，。；、）)”"']+/g, '')
    .replace(/[，,]\s*(?:SHA-?256|组合指纹|基准)\s*[=:：]?\s*[a-f0-9]*/gi, '')
    .replace(/（\s*(?:SHA-?256|组合指纹)[^）]*）/gi, '')
    .replace(/\bSHA-?256\s*[=:：]?\s*[a-f0-9]*/gi, '')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '')
    .replace(/（\s*[，、；：]?\s*）/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；：])/g, '$1')
    .replace(/([，。；：])\1+/g, '$1')
    .trim();
}

function stripNarration(text: string): string {
  const sentences = text.split(/(?<=[。！？!?])\s*/).map(s => s.trim()).filter(Boolean);
  const filtered = sentences.filter(s => !/^(?:我先|先只读|先确认|先检查|下面看|接下来|改用.*工具|Shell\s*在本会话|工作区中\s*Glob|验证成员保存了|diff\s*已读完|本机找到.*没有发现|确认\s*base-en\.json.*继续核对)/.test(s));
  return filtered.join('');
}

function truncateText(text: string, limit = 180): string {
  const cleaned = text.trim();
  if (cleaned.length <= limit) return cleaned;
  const slice = cleaned.slice(0, limit);
  const boundary = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('；'));
  return boundary >= Math.floor(limit * 0.55) ? slice.slice(0, boundary + 1) : `${slice.replace(/[，、；：\s]+$/, '')}…`;
}

function reportReplyText(report: Record<string, unknown>): string {
  return [
    (report.conversationReply as { text?: unknown } | undefined)?.text,
    (report.coordinationReply as { text?: unknown } | undefined)?.text,
    report.answer,
  ].find((value): value is string => typeof value === 'string' && !!value.trim()) || '';
}

/** 调度协议不作为用户正文；无法读取的报告只保留围栏外的自然语言。 */
function summaryReplyText(raw: string): string {
  try {
    const report = readAgentDeliveryReport(raw) as Record<string, unknown> | undefined;
    if (report?.version === 1) return reportReplyText(report);
  } catch { /* 格式错误仍由流程状态说明；此处不把 JSON 当作岗位结论。 */ }
  const text = agentReplyText(raw).replace(/```[\s\S]*?```/g, '').split(/```(?:delivery-report|json)\b/)[0].trim();
  return /^[{\[]/.test(text) ? '' : text;
}

function currentRoleMembers(summary: GroupRoundSummary): GroupSummaryMember[] {
  const roles = new Set<string>();
  return summary.members.filter(member => member.current).reverse().filter(member => {
    const role = member.run?.team?.profileId || member.turn.member.id;
    if (roles.has(role)) return false;
    roles.add(role);
    return true;
  }).reverse();
}

function memberResultPending(member: GroupSummaryMember) {
  return member.run?.resultReady === false || ['pending', 'queued', 'running', 'saving'].includes(member.state)
    || ['queued', 'running'].includes(member.run?.status || '');
}

function parseMarkdownDigest(raw: string): { lead: string; points: GroupSummaryPoint[]; nextAction: string } {
  const body = summaryReplyText(raw);
  if (!body) return { lead: '', points: [], nextAction: '' };
  const lines = body.split(/\r?\n/);
  const leadParts: string[] = [];
  const points: GroupSummaryPoint[] = [];
  const actionParts: string[] = [];
  let inActionSection = false;
  let current: { title: string; details: string[] } | undefined;

  const flush = () => {
    if (!current) return;
    const detail = cleanInline(current.details.join(' '));
    const title = cleanInline(current.title).replace(/[：:]$/, '');
    if (title || detail) points.push({ title: title || '核实要点', detail: detail || title });
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('|') || /^[-=]{3,}$/.test(line)) continue;
    if (/^(?:具体核实情况如下|原因与当前情况说明如下|具体情况如下|核实情况如下|说明如下|依据|这次核对的局限|结论和需要改正的地方)[：:]?$/.test(line)) continue;
    if (line.startsWith('#')) {
      flush();
      const heading = cleanInline(line.replace(/^#+\s*/, ''));
      inActionSection = /下一步|建议|处理方式/.test(heading);
      continue;
    }
    if (inActionSection) {
      const cleaned = cleanInline(line.replace(/^[-*•\d.、）)]+\s*/, ''));
      if (cleaned) actionParts.push(cleaned);
      continue;
    }
    const numbered = /^(\d+)[.、）)]\s*(.+)$/.exec(line);
    if (numbered) {
      flush();
      const rest = numbered[2].trim();
      const split = /^\*\*([^*]+)\*\*\s*[：:]?\s*(.*)$/.exec(rest) || /^([^：:]{2,26})[：:]\s*(.+)$/.exec(rest);
      current = split ? { title: split[1], details: split[2] ? [split[2]] : [] } : { title: '', details: [rest] };
      continue;
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (bullet) {
      const content = bullet[1].trim();
      const cleaned = cleanInline(content);
      if (/^(?:如需|如果|建议|后续需要|若只需|若本次)/.test(cleaned)) {
        actionParts.push(cleaned);
        if (current && current.details.length > 0) continue;
      }
      if (current) {
        current.details.push(content);
      } else {
        const split = /^\*\*([^*]+)\*\*\s*[：:]?\s*(.*)$/.exec(content) || /^([^：:]{2,22})[：:]\s*(.+)$/.exec(content);
        if (split && split[2]) points.push({ title: cleanInline(split[1]), detail: cleanInline(split[2]) });
        else if (cleaned) points.push({ title: '', detail: cleaned });
      }
      continue;
    }
    if (current) {
      current.details.push(line);
    } else {
      const cleaned = stripNarration(cleanInline(line));
      if (!cleaned) continue;
      if (/^(?:如需|如果|建议|后续需要|若只需|若本次)/.test(cleaned)) actionParts.push(cleaned);
      else leadParts.push(cleaned);
    }
  }
  flush();
  return { lead: leadParts.slice(0, 2).join(' '), points: points.slice(0, 5), nextAction: actionParts.join('；') };
}

function summarizeMemberRole(member: GroupSummaryMember, report?: {
  progress: ReturnType<typeof requirementProgressDataSchema.safeParse>;
  task: ReturnType<typeof agentTaskResultSchema.safeParse>;
  rawReport: Record<string, unknown>;
}): string {
  if (memberResultPending(member)) return '本岗位正在处理，本次结论尚未返回。';
  const feedback = groupMemberFeedback(member);
  if (feedback) return feedback.checks.map(check => `${check.title}：${check.detail}`).join(' ');
  const raw = member.run ? member.run.result : member.turn.result;
  if (!raw.trim()) return member.run?.error || member.turn.error || '该岗位暂未返回结论。';
  if (report) {
    const { progress, task, rawReport } = report;
    if (task.success && task.data.summary.trim()) return task.data.summary;
    const direct = [
      (rawReport.diagnosis as { summary?: unknown } | undefined)?.summary,
      (rawReport.jiraHandoff as { conclusion?: unknown } | undefined)?.conclusion,
      reportReplyText(rawReport),
    ].find(item => typeof item === 'string' && item.trim()) as string | undefined;
    if (direct) return direct;
    if (progress.success) {
      const stages = progress.data.stages;
      const cap = member.turn.member.capability;
      if (cap === 'review' && stages.development.evidence) return truncateText(cleanInline(stages.development.evidence));
      if (cap === 'verify' && stages.verification.evidence) return truncateText(cleanInline(stages.verification.evidence));
      if (cap === 'write' && (stages.development.evidence || stages.design.evidence)) {
        return truncateText(cleanInline(stages.development.evidence || stages.design.evidence));
      }
      if (cap === 'read') {
        const isLeader = member.turn.member.id === 'leader' || /负责人/.test(member.turn.member.name);
        const stageText = isLeader
          ? [stages.intake.evidence, stages.tasks.evidence].filter(Boolean).join(' ')
          : stages.handoff.evidence || stages.intake.evidence;
        if (stageText) return truncateText(cleanInline(stageText));
      }
    }
  }
  const digest = parseMarkdownDigest(raw);
  const parts = [digest.lead, ...digest.points.slice(0, 2).map(p => p.title && p.detail && p.title !== p.detail ? `${p.title}：${p.detail}` : p.detail)].filter(Boolean);
  if (parts.length) return truncateText(parts.join(' '));
  return truncateText(stripNarration(cleanInline(summaryReplyText(raw))));
}

export function groupSummaryPresentation(summary: GroupRoundSummary, deliveryText?: string) {
  const currentMembers = summary.members.filter(member => member.current);
  const latestMembers = currentRoleMembers(summary);
  const reports = currentMembers.filter(member => !memberResultPending(member)).flatMap(member => {
    try {
      const report = readAgentDeliveryReport(member.run ? member.run.result : member.turn.result) as Record<string, unknown> | undefined;
      if (!report || report.version !== 1) return [];
      return [{ member, rawReport: report, validation: deliveryEvidenceSchema.safeParse(report.validationEvidence),
        progress: requirementProgressDataSchema.safeParse(report.requirementProgress),
        delivery: requirementDeliverySchema.safeParse(report.requirementDelivery), task: agentTaskResultSchema.safeParse(report.taskResult) }];
    } catch { return []; }
  });
  const checks = (['tests', 'browser'] as const).flatMap(kind => {
    const sources = reports.flatMap(item => item.validation.success ? [{ member: item.member, ...item.validation.data[kind] }] : []);
    if (!sources.length) return [];
    // 后序抄录不能覆盖前序失败，也不能把多个岗位的同类记录计成多个产品缺陷。
    const ordered = [...sources].reverse().sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed')
      || Number(b.member.turn.member.capability === 'verify') - Number(a.member.turn.member.capability === 'verify'));
    const verifierSources = sources.filter(item => item.member.turn.member.capability === 'verify');
    const latest = verifierSources.length ? verifierSources : sources.slice(-1);
    const status = sources.some(item => item.status === 'failed') ? 'failed'
      : latest.some(item => item.status === 'pending') ? 'pending'
      : latest.some(item => item.status === 'passed') ? 'passed' : 'not_applicable';
    return [{ kind, title: kind === 'tests' ? '自动检查' : '页面操作检查', status,
      label: status === 'failed' ? '还有检查没通过' : status === 'passed' ? '已运行的检查已通过' : status === 'pending' ? '还没确认结果' : '本轮不适用', sources: ordered }];
  });
  const findings = new Map<string, { problem: string; expectation: string; members: GroupSummaryMember[] }>();
  for (const item of reports) if (item.task.success && item.task.data.role === 'reviewer') {
    for (const finding of item.task.data.findings.filter(finding => finding.severity !== 'minor' && finding.problem)) {
      const key = JSON.stringify([finding.file, finding.line, finding.problem, finding.expectation]);
      const existing = findings.get(key);
      if (existing) existing.members.push(item.member);
      else findings.set(key, { problem: finding.problem, expectation: finding.expectation, members: [item.member] });
    }
  }
  const assertions = reports.flatMap(item => {
    const items: { text: string; member: GroupSummaryMember }[] = [];
    if (item.task.success && item.task.data.role === 'reviewer') for (const finding of item.task.data.findings) {
      if (finding.severity !== 'minor' && finding.problem) items.push({ text: finding.problem, member: item.member });
    }
    if (!item.progress.success) return items;
    const stages = item.progress.data.stages;
    if (item.member.turn.member.capability === 'verify' && stages.verification.status === 'blocked') {
      // 只取验证者明确列出的当前问题，不把首次报错、重跑成功等过程当作新问题。
      const listed = /候选存在([^。]+?)问题[，,]需要/.exec(stages.verification.evidence);
      if (listed) items.push({ text: listed[1], member: item.member });
    }
    if (item.member.turn.member.capability === 'review' && /^审查(?:结论为)?不通过[。；;，,]/.test(stages.development.evidence)) {
      items.push({ text: stages.development.evidence, member: item.member }, { text: stages.design.evidence, member: item.member });
    }
    return items;
  });
  const issues = plainIssues(assertions);
  const failed = checks.filter(check => check.status === 'failed');
  const scenarioFailure = reports.some(item => item.delivery.success && (item.delivery.data.api?.status === 'failed'
    || item.delivery.data.scenarios.some(scene => scene.status === 'failed')));
  const hasFailures = failed.length > 0 || findings.size > 0 || scenarioFailure;
  const running = summary.status === 'running';
  const headline = summary.status === 'cancelled' ? '本轮已停止'
    : running ? '团队还在处理，结果尚未确认'
    : hasFailures ? '还需要修改，暂时不能验收'
    : summary.status === 'blocked' ? '这轮工作还没完成，需要先处理遇到的阻碍'
    : '各成员已汇报，是否可以验收还需确认';
  const implementer = latestMembers.find(member => member.turn.member.capability === 'write');
  const verifier = latestMembers.find(member => member.turn.member.capability === 'verify');
  const final = reports.find(item => item.member.turn.id === summary.report?.turn.id);
  const progressReport = final?.progress.success ? final : [...reports].reverse().find(item => item.progress.success);
  const source = summary.source;
  const isRequirement = source?.workflow === 'requirement' && !!(summary.round.taskPrompt || progressReport || reports.some(item => item.delivery.success));
  const requirement = isRequirement ? (() => {
    // 实测优先于汇总抄录；同一场景的失败/阻塞不会被后序的通过或未测覆盖。
    const direct = reports.filter(item => item.member.turn.member.capability === 'verify');
    const builders = reports.filter(item => item.member.turn.member.capability === 'write');
    const ordered = [...direct, ...builders, ...reports.filter(item => !direct.includes(item) && !builders.includes(item)).reverse()];
    const deliveries = ordered.flatMap(item => item.delivery.success ? [item.delivery.data] : []);
    type Scenario = NonNullable<typeof deliveries[number]>['scenarios'][number];
    const scenarios = new Map<string, Scenario>();
    for (const item of deliveries) for (const scene of item.scenarios) {
      const previous = scenarios.get(scene.name);
      if (!previous || !['failed', 'blocked'].includes(previous.status) && (['failed', 'blocked'].includes(scene.status) || previous.status === 'not_run')) scenarios.set(scene.name, scene);
    }
    const stageTitles = { intake: source.requirementPreparation ? '需求评审与范围' : '需求材料核对', tasks: 'Jira 拆分与排期', design: '前端技术方案',
      development: '工作区与功能开发', verification: 'i18n-test 与接口验证', handoff: '交接结果' };
    const stageReports = [...reports].reverse();
    const stages = requirementStages.map(key => {
      const specialists = key === 'verification' ? direct : key === 'development' || key === 'design' ? builders : [];
      const values = [...specialists, ...stageReports.filter(item => !specialists.includes(item))]
        .flatMap(item => item.progress.success && item.progress.data.stages[key].evidence ? [item.progress.data.stages[key]] : []);
      const selected = values.find(item => item.status === 'blocked') || values.find(item => !['pending', 'not_applicable'].includes(item.status)) || values[0];
      const document = source.requirementPreparation ? key === 'intake' ? 'review' as const : key === 'design' ? 'design' as const : undefined : undefined;
      return { key, title: stageTitles[key], status: selected ? requirementStageStatusLabels[selected.status] : document ? '文档已生成' : '未记录',
        evidence: selected?.evidence || '', document };
    });
    const validUrl = (href: string) => /^https?:\/\//i.test(href) ? href : undefined;
    const previews = new Map<string, typeof deliveries[number]['previews'][number]>();
    // 地址仅接受实际执行者的声明；纯审查/整理成员不能把未实测地址提升为交付。
    for (const item of [...direct, ...builders]) if (item.delivery.success) for (const preview of item.delivery.data.previews) {
      if (!previews.has(preview.url)) previews.set(preview.url, preview);
    }
    const apiReports = deliveries.flatMap(item => item.api ? [item.api] : []);
    const api = apiReports.find(item => item.status === 'failed') || apiReports.find(item => item.status === 'blocked')
      || apiReports.find(item => item.status !== 'not_run') || apiReports[0];
    const i18n = deliveries.find(item => item.i18n.status === 'blocked')?.i18n
      || [...builders, ...direct].find(item => item.delivery.success && item.delivery.data.i18n.status !== 'pending')?.delivery.data?.i18n
      || deliveries.find(item => item.i18n.status !== 'pending')?.i18n || deliveries[0]?.i18n;
    const checkDetails = checks.flatMap(check => {
      const evidence = check.sources[0]?.evidence;
      return evidence ? [{ title: check.title, evidence }] : [];
    });
    const nextAction = deliveries.find(item => item.nextStep && !/\b(?:npm|pnpm|yarn|git|node)\s|\.(?:json|log|vue|js)\b|退出(?:码)?\s*\d|AC-\d+|cgWindow|\bHTTP\s*\d|test\/pre|\/Users\//i.test(item.nextStep))?.nextStep || '';
    return {
      taskId: source.taskId, issueKey: source.issueKey, issueUrl: validUrl(source.issueUrl),
      goal: deliveries.find(item => item.goal)?.goal || source.title.replace(/^需求开发\s*·\s*/, ''),
      stages, scenarios: [...scenarios.values()], previews: [...previews.values()], i18n, api, checkDetails,
      verificationFeedback: verifier ? groupMemberFeedback(verifier) : undefined,
      projects: source.projects, tasks: source.requirementTasks?.map(item => ({ ...item, url: validUrl(item.url) })),
      issueKeys: [...new Set(reports.flatMap(item => item.progress.success ? item.progress.data.issueKeys : []))],
      nextStep: nextAction,
    };
  })() : undefined;
  const stageLabels = { intake: '需求范围已核对', tasks: '关联任务已核对', design: '技术方案已整理', development: '功能修改已完成', verification: '本轮检查已完成', handoff: '交接内容已整理' };
  const completed = final?.progress.success ? Object.entries(stageLabels).flatMap(([key, label]) =>
    final.progress.success && final.progress.data.stages[key as keyof typeof stageLabels].status === 'completed' ? [label] : []) : [];
  const canonical = reports.find(item => item.member.turn.member.capability === 'verify' && item.validation.success)
    || [...reports].reverse().find(item => item.validation.success);
  const unconfirmed = canonical?.validation.success ? [
    ...(canonical.validation.data.remote.status === 'pending' ? ['代码是否已上传到远端，尚未确认'] : []),
    ...(canonical.validation.data.deployment.status === 'pending' ? ['部署情况和实际效果，尚未确认'] : []),
  ] : [];
  const records = latestMembers.filter(member => member.run || member.turn.result || member.turn.error);
  const currentTurnIds = new Set(currentMembers.map(member => member.turn.id));
  const blockers = [...new Map(summary.blockers.filter(item => currentTurnIds.has(item.turn.id))
    .map(item => [`${item.turn.id}:${item.text}`, { name: item.member.name, text: item.text }])).values()];

  const reportByTurnId = new Map(reports.map(item => [item.member.turn.id, item]));
  const roleDigests: GroupRoleDigest[] = records.map(member => ({
    id: member.turn.id,
    name: member.turn.member.name,
    statusLabel: memberResultPending(member) ? '处理中' : member.outcome?.label || (member.state === 'completed' ? '已汇报' : member.state === 'failed' ? '执行未完成' : ''),
    state: memberResultPending(member) ? undefined : member.outcome?.state,
    summary: summarizeMemberRole(member, reportByTurnId.get(member.turn.id)),
    run: member.run,
  })).filter(item => item.summary);

  let overview = '';
  const summaryPoints: GroupSummaryPoint[] = [];
  let customNextStep = '';

  if (!requirement && !running && summary.status !== 'cancelled') {
    if (progressReport?.progress.success || checks.length || issues.length || findings.size) {
      const stages = progressReport?.progress.success ? progressReport.progress.data.stages : undefined;
      const doneText = completed.length ? completed.join('、') : '本轮已有检查记录';
      const devText = stages && stages.design.status === 'completed' && stages.development.status === 'completed' && !completed.includes('功能修改已完成')
        ? '，并已完成本地技术方案与业务代码初版修改'
        : '';
      if (hasFailures || issues.length) {
        const failCheckText = failed.length ? `${failed.map(item => item.title).join('和')}存在未通过项` : '审查与验证发现待修复问题';
        const countText = issues.length ? `，共整理出 ${issues.length} 项需要注意的问题` : findings.size ? `，共指出 ${findings.size} 项代码审查问题` : '';
        overview = `${doneText}${devText}；但${failCheckText}${countText}，需修复并重新验证后再确认是否验收。`;
      } else if (summary.status === 'blocked') {
        overview = `${doneText}${devText}；当前存在未完成或阻塞项，需先处理阻碍后再继续。`;
      } else {
        const passedText = checks.filter(item => item.status === 'passed').map(item => item.title).join('、');
        overview = `${doneText}${devText}${passedText ? `，已运行的${passedText}通过` : ''}${unconfirmed.length ? `；${unconfirmed.join('，')}` : ''}。`;
      }
      if (stages) {
        summaryPoints.push({
          title: '需求与任务核对',
          detail: stages.intake.status === 'completed' && stages.tasks.status === 'completed'
            ? `需求文档、设计稿及关联任务关系已核对一致${issues.some(i => i.id === 'account-filter') ? '；部分筛选参数或字段契约仍待与后端确认' : ''}。`
            : '已核对关联任务与需求资料；部分枚举、字段契约或业务规则仍待与产品或后端进一步确认。',
        });
        if (stages.design.status !== 'pending' || stages.development.status !== 'pending') {
          summaryPoints.push({
            title: '方案与代码实现',
            detail: stages.design.status === 'completed' && stages.development.status === 'completed'
              ? '已完成技术方案整理与目标工作区代码修改。'
              : '方案或代码实现尚未全部完成，具体进展见岗位记录。',
          });
        }
        if (stages.verification.status !== 'pending' || checks.length) {
          summaryPoints.push({
            title: '验证与交付整理',
            detail: failed.length
              ? `基础编译与静态检查已执行，但${failed.map(c => c.title).join('、')}仍有未通过项；已整理本轮交接草稿，待修复复验后交付。`
              : `已执行本轮检查并整理交接说明${unconfirmed.length ? `；${unconfirmed.join('，')}` : ''}。`,
          });
        }
      }
      if (!stages) {
        const implemented = [...reports].reverse().find(item => item.task.success && item.task.data.role === 'implementer');
        if (implemented?.task.success && implemented.task.data.summary) summaryPoints.push({ title: '当前实现结果', detail: implemented.task.data.summary });
        if (checks.length) summaryPoints.push({ title: '当前验证结果', detail: checks.map(check => `${check.title}：${check.label}`).join('；') });
      }
    } else {
      const preferred = deliveryText
        || (() => {
          const reporter = [...records].reverse().find(m => m.turn.member.id === 'reporter' || /交付|整理|汇总/.test(m.turn.member.name))
            || records.find(m => m.turn.id === summary.coordinator?.turn.id)
            || [...records].reverse().find(m => m.turn.member.id === 'leader' || m.turn.member.id === 'lead' || /负责人/.test(m.turn.member.name))
            || records.at(-1);
          return reporter ? (reporter.run ? reporter.run.result : reporter.turn.result) : '';
        })();
      const parsed = parseMarkdownDigest(preferred);
      overview = parsed.lead;
      summaryPoints.push(...parsed.points);
      customNextStep = parsed.nextAction;
      if (!overview && roleDigests.length) overview = roleDigests.at(-1)!.summary;
    }
  }

  const nextStep = summary.status === 'cancelled' ? ''
    : running ? '等待当前成员完成后，再核对最终结果。'
    : requirement?.verificationFeedback?.nextStep || requirement?.nextStep || (hasFailures ? implementer && verifier
      ? `建议${implementer.turn.member.name}先修改，再请${verifier.turn.member.name}重新检查。`
      : '建议先修改报告指出的问题，再重新检查。'
    : summary.status === 'blocked' ? '建议负责人先确认哪一步没有完成，以及需要谁继续处理。'
    : requirement ? requirement.previews.length ? '打开交付地址按上面的场景复验。' : '补齐页面实测和可访问地址后再验收。'
    : customNextStep || '先查看右侧已生成的文件和检查结果，再决定是否验收。');

  const requirementHeadline = requirement && summary.status === 'returned' && !hasFailures
    ? requirement.api?.status === 'blocked' || requirement.i18n?.status === 'blocked' || requirement.scenarios.some(scene => scene.status === 'blocked')
      ? '有业务场景或交付项受阻' : !requirement.previews.length ? '当前没有可交付的业务访问地址' : headline
    : headline;
  return { headline: requirementHeadline,
    requirement, overview, nextStep, summaryPoints, roleDigests, checks, failed, blockers, findings: [...findings.values()], issues, completed, unconfirmed, records };
}
