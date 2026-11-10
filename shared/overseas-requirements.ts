import { z } from 'zod';
import type { RequirementDevelopmentRecord } from './requirement-development.js';
import type { JiraIssue } from './hub.js';

export const overseasStageLabels = {
  unconfirmed: '待核对', intake: '待评审', planned: '待开发', development: '开发中',
  verification: '验证中', handoff: '待提测', acceptance: '待验收', accepted: '已验收',
} as const;
export const overseasSystemStatusLabels = { pending: '未开始', development: '开发中', verification: '待验证', passed: '已验证', not_applicable: '不涉及' } as const;
export const overseasI18nLabels = { pending: '待处理', in_progress: '处理中', ready: '已就绪', not_applicable: '不涉及' } as const;
export const overseasSystemNameSchema = z.string().trim().min(1, '请填写系统名称').max(60, '系统名称最多 60 个字');
// Jira 返回的标题、状态和正文保留原文；校验时检查空白，不改写展示值。
const text = (max: number) => z.string().max(max);
const date = z.union([z.iso.date(), z.literal('')]);
const link = text(2000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, '请填写完整的 http(s) 链接');
const fields = {
  id: z.uuid(), title: text(300).refine(value => !!value.trim(), '请填写需求名称'), description: text(20000).default(''),
  issueKey: text(100).regex(/^(?:[A-Z][A-Z0-9_]*-\d+)?$/, '请填写有效的 Jira Key').default(''),
  issueUrl: link.default(''), jiraStatus: text(200).default(''),
  prdUrl: link.default(''), prototypeUrl: link.default(''),
  owner: text(120).default(''), version: text(200).default(''), startDate: date.default(''), endDate: date.default(''),
  stage: z.enum(Object.keys(overseasStageLabels) as [keyof typeof overseasStageLabels, ...Array<keyof typeof overseasStageLabels>]).default('intake'),
  systems: z.array(z.object({ name: text(60).refine(value => !!value.trim(), '请填写系统名称'), status: z.enum(['pending', 'development', 'verification', 'passed', 'not_applicable']),
    evidence: text(4000), previewUrl: link }).strict()).max(50).default([]),
  i18n: z.object({ status: z.enum(['pending', 'in_progress', 'ready', 'not_applicable']), evidence: text(4000) }).strict().default({ status: 'pending', evidence: '' }),
  blocker: text(4000).default(''), acceptanceEvidence: text(4000).default(''),
  executionIds: z.array(z.uuid()).max(50).default([]),
  groupRoomIds: z.array(z.uuid()).max(50).default([]),
};
type RequirementFields = z.infer<z.ZodObject<typeof fields>>;
function validateRequirement(value: RequirementFields, context: z.RefinementCtx) {
  const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: 'custom', message, path });
  if (value.startDate && value.endDate && value.startDate > value.endDate) issue('结束日期不能早于开始日期', ['endDate']);
  if (new Set(value.systems.map(item => item.name.trim().toLowerCase())).size !== value.systems.length) issue('涉及系统不能重复', ['systems']);
  if (new Set(value.executionIds).size !== value.executionIds.length) issue('开发记录不能重复关联', ['executionIds']);
  if (new Set(value.groupRoomIds).size !== value.groupRoomIds.length) issue('团队群聊不能重复关联', ['groupRoomIds']);
  value.systems.forEach((system, index) => {
    if (system.status === 'passed' && !system.evidence.trim()) issue(`${system.name} 已验证时需填写验证证据`, ['systems', index, 'evidence']);
  });
  if (value.i18n.status === 'ready' && !value.i18n.evidence.trim()) issue('多语言已就绪时需填写产物或验证证据', ['i18n', 'evidence']);
  if (value.stage === 'accepted') {
    if (!value.acceptanceEvidence.trim()) issue('已验收时需填写人工验收结论与证据', ['acceptanceEvidence']);
    if (value.blocker.trim()) issue('仍有阻塞，不能标记已验收', ['blocker']);
    if (!value.systems.length || value.systems.some(item => !['passed', 'not_applicable'].includes(item.status))) issue('请先核对所有涉及系统的验证结果', ['systems']);
    if (!['ready', 'not_applicable'].includes(value.i18n.status)) issue('请先核对多语言交付结果', ['i18n']);
  }
}
export const overseasRequirementSaveSchema = z.object({ ...fields, expectedRevision: z.number().int().min(0) }).strict().superRefine(validateRequirement);
export const overseasRequirementSchema = z.object({ ...fields, revision: z.number().int().positive(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict().superRefine(validateRequirement);
export const overseasRequirementStateSchema = z.object({ version: z.literal(1), items: z.array(overseasRequirementSchema),
  systems: z.array(overseasSystemNameSchema).default([]), removedIds: z.array(z.uuid()).default([]) }).strict()
  .superRefine((value, context) => {
    const ids = value.items.map(item => item.id), executions = value.items.flatMap(item => item.executionIds), groups = value.items.flatMap(item => item.groupRoomIds);
    if (new Set(ids).size !== ids.length || new Set(executions).size !== executions.length || new Set(groups).size !== groups.length) context.addIssue({ code: 'custom', message: '需求、开发记录或团队群聊存在重复关联' });
  });
export type OverseasRequirement = z.infer<typeof overseasRequirementSchema>;
export type OverseasRequirementSave = z.infer<typeof overseasRequirementSaveSchema>;

export function emptyOverseasRequirement(id: string): OverseasRequirement {
  return { id, revision: 0, title: '', description: '', issueKey: '', issueUrl: '', jiraStatus: '', prdUrl: '', prototypeUrl: '',
    owner: '', version: '', startDate: '', endDate: '', stage: 'intake', systems: [], i18n: { status: 'pending', evidence: '' },
    blocker: '', acceptanceEvidence: '', executionIds: [], groupRoomIds: [], createdAt: '', updatedAt: '' };
}
export function overseasRequirementPayload(item: OverseasRequirement): OverseasRequirementSave {
  const { revision, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = item;
  return { ...fields, expectedRevision: revision };
}
export function overseasRequirementFromJira(issue: JiraIssue, id: string, systems: string[] = []): OverseasRequirement {
  const dateValue = (value: string | null) => value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
  return { ...emptyOverseasRequirement(id), title: issue.summary, description: issue.description || '', issueKey: issue.key,
    issueUrl: issue.url, jiraStatus: issue.status, owner: issue.assignee, version: issue.fixVersions.join('、'),
    startDate: dateValue(issue.startDate), endDate: dateValue(issue.endDate || issue.dueDate), stage: 'unconfirmed',
    systems: systems.map(name => ({ name, status: 'pending', evidence: '', previewUrl: '' })) };
}

/** 历史执行自动出现在台账中；没有业务阶段证据时保持待核对，执行结束不推断验收。 */
export function mergeOverseasRequirements(items: OverseasRequirement[], records: RequirementDevelopmentRecord[], removedIds: string[] = []): OverseasRequirement[] {
  const linked = new Set(items.flatMap(item => item.executionIds));
  const registered = new Set([...items.map(item => item.id), ...removedIds]);
  const legacy = records.filter(record => !linked.has(record.id) && !registered.has(record.id)).map(record => {
    const source = record.input.issueKey;
    const key = /(?:^|\/)([A-Z][A-Z0-9_]*-\d+)\/?$/i.exec(source)?.[1]?.toUpperCase() || '';
    return { ...emptyOverseasRequirement(record.id), title: record.input.title, description: record.input.requirement,
      issueKey: key, issueUrl: /^https?:\/\//.test(source) ? source : '', prdUrl: record.input.prdUrl,
      owner: record.input.assignee, version: record.input.fixVersion, startDate: record.input.startDate, endDate: record.input.endDate,
      stage: 'unconfirmed' as const, executionIds: [record.id], createdAt: record.createdAt, updatedAt: record.createdAt };
  });
  return [...items, ...legacy].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function filterOverseasRequirements(items: OverseasRequirement[], filter: { search: string; system: string; stage: string; owner: string; version: string }) {
  const query = filter.search.trim().toLocaleLowerCase();
  return items.filter(item => (!query || [item.title, item.issueKey, item.description, item.blocker].join(' ').toLocaleLowerCase().includes(query))
    && (!filter.system || item.systems.some(system => system.name === filter.system))
    && (!filter.stage || (filter.stage === 'blocked' ? !!item.blocker : item.stage === filter.stage))
    && (!filter.owner || item.owner === filter.owner) && (!filter.version || item.version === filter.version));
}
