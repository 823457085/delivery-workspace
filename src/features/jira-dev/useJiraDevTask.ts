/**
 * 设计说明：沿用 Jira 研发助手插件面板的表单与确认顺序（读取 Jira → 生成预览 → 确认 Jira 写入 → 开始）。
 * 区别只在最后一步：在工作台按所选 CLI / 模型启动会话并打开，不再新建 Codex 聊天。
 * 草稿按流程保存在本机浏览器；预览 taskId 保留到“开始下一项”，避免已写 Jira 的任务被编辑覆盖。
 */
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { chinaWorkingDates, splitWorkingDates } from '../../../shared/china-work-calendar.mjs';
import { childScopeTitles, requirementScopes, requirementSummary, requirementTitle } from '../../../shared/jira-dev-requirement-titles.mjs';
import { jiraDevNeedsApply, jiraDevStartBlocker, type JiraDevDevelopmentCandidate, type JiraDevIssueReadResult, type JiraDevIssueView, type JiraDevRuntimeSelection, type JiraDevTaskView,
  type JiraDevRequirementContext, type JiraDevRequirementPhase, type JiraDevWorkflow } from '../../../shared/jira-dev';

const roles = ['parent', 'design', 'implementation'] as const;
type Role = typeof roles[number];
type Schedules = Record<Role, { startDate: string; endDate: string }>;
type ProjectSelection = { path: string; baseBranch: string; branchName: string };
export interface JiraDevForm {
  source: string; projectPath: string; baseBranch: string; branchName: string; details: string; useI18n: boolean;
  additionalProjects: ProjectSelection[];
  repairMode: 'create' | 'direct' | 'reuse'; repairSource: string; repairProject: string; repairSummary: string; repairVersion: string; repairStartDate: string; repairEndDate: string;
  sourceKind: 'product' | 'frontend'; developmentKey: string; businessModule: string; designSource: string; schedules: Schedules;
}
const emptySchedules = (): Schedules => ({ parent: { startDate: '', endDate: '' }, design: { startDate: '', endDate: '' }, implementation: { startDate: '', endDate: '' } });
const emptyForm = (): JiraDevForm => ({ source: '', projectPath: '', baseBranch: '', branchName: '', additionalProjects: [], details: '', useI18n: true,
  repairMode: 'create', repairSource: '', repairProject: '', repairSummary: '', repairVersion: '', repairStartDate: '', repairEndDate: '',
  sourceKind: 'product', developmentKey: '', businessModule: '', designSource: '', schedules: emptySchedules() });
const repairDefaults = ['repairProject', 'repairSummary', 'repairVersion', 'repairStartDate', 'repairEndDate'] as const;

export function parseJiraSource(value: string) {
  const text = value.trim();
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(text)) return { key: text.toUpperCase() };
  try {
    const url = new URL(text);
    const match = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.pathname.match(/\/(?:browse|projects\/[A-Z][A-Z0-9_]*\/issues)\/([A-Z][A-Z0-9_]*-\d+)\/?$/i) : null;
    return match ? { key: match[1]!.toUpperCase() } : null;
  } catch { return null; }
}
export function validScheduleDate(value: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !value.startsWith('0000-') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function jiraDevRequest<T>(action: string, value?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent-runtimes/jira-dev/${action}`, value === undefined ? { signal } : { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(value) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 404 && !result.message ? '后台尚未加载 Jira 研发功能，请在当前任务结束后重启本地服务。' : result.message || '请求失败');
  return result as T;
}

export function useJiraDevTask(workflow: JiraDevWorkflow, openRun: (id: string) => void, context?: JiraDevRequirementContext) {
  const storageKey = `qiyuan:jira-dev:${workflow}:v1${context ? `:${context.id}` : ''}`;
  const form = reactive<JiraDevForm>(emptyForm());
  if (context) Object.assign(form, { source: context.source, details: context.details, useI18n: context.useI18n });
  const taskId = shallowRef(context?.taskId || '');
  const edited = new Set<string>();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved?.form) for (const key of Object.keys(form) as (keyof JiraDevForm)[]) {
      if (key === 'schedules') { for (const role of roles) Object.assign(form.schedules[role], saved.form.schedules?.[role] || {}); }
      else if (key === 'additionalProjects') {
        if (workflow === 'requirement' && Array.isArray(saved.form.additionalProjects)) form.additionalProjects = saved.form.additionalProjects
          .filter((item: ProjectSelection) => item && typeof item.path === 'string' && typeof item.baseBranch === 'string' && typeof item.branchName === 'string').slice(0, 9);
      }
      else if (typeof saved.form[key] === typeof form[key]) Object.assign(form, { [key]: saved.form[key] });
    }
    if (Array.isArray(saved?.edited)) for (const key of saved.edited) if (typeof key === 'string') edited.add(key);
    if (/^[0-9a-f-]{36}$/.test(saved?.taskId || '')) taskId.value = saved.taskId;
  } catch { /* 草稿不可读不影响填写。 */ }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ form, taskId: taskId.value, edited: [...edited] })); } catch { /* 当前表单仍可使用。 */ }
  }
  watch(form, save, { deep: true });
  const selectedProjects = computed<ProjectSelection[]>(() => [
    ...(form.projectPath ? [{ path: form.projectPath, baseBranch: form.baseBranch, branchName: form.branchName }] : []),
    ...(workflow === 'requirement' ? form.additionalProjects : []),
  ]);

  const issue = shallowRef<JiraDevIssueView>();
  const developmentCandidates = shallowRef<JiraDevDevelopmentCandidate[]>([]);
  const task = shallowRef<JiraDevTaskView>();
  const reading = shallowRef(false), busy = shallowRef(false), previewOpen = shallowRef(false);
  const status = shallowRef('');
  const versions = ref<string[]>([]), versionStatus = shallowRef('');

  // 已写 Jira、结果待核对或已启动的任务不得被表单编辑静默替换，与插件的编辑锁一致。
  const locked = computed(() => !!task.value && (!!task.value.launch || ['applied', 'unknown'].includes(task.value.plan?.status || '')));
  const plan = computed(() => task.value?.plan);
  const startBlocker = computed(() => task.value ? jiraDevStartBlocker(task.value) : '请先生成任务预览');
  const needsApply = computed(() => !!task.value && jiraDevNeedsApply(task.value));
  const launched = computed(() => !!task.value?.launch && task.value.launch.status !== 'failed');
  const startLabel = computed(() => {
    const value = task.value, current = value?.plan;
    if (!value) return '开始';
    if (launched.value) return value.launch?.status === 'uncertain' ? '启动结果待核对' : '本次任务已启动';
    if (startBlocker.value) return startBlocker.value;
    if (workflow === 'jira') {
      if (value.repairMode !== 'create' && value.repairMode !== 'reuse') return '创建工作区并开始修复';
      if (current?.status === 'applied') return '创建工作区并开始前端修复';
      if (current?.status === 'error') return '确认重试未完成项并开始修复';
      return current?.items.some(item => item.action === 'reuse') ? '确认复用并开始修复' : '确认新建开发 Jira 并开始修复';
    }
    if (current?.status === 'applied') return '开始技术方案与功能开发';
    if (current?.status === 'local') return current.designDestination && !current.designPublicationAuthorized ? '确认方案目录并按本地任务草稿开始' : '按本地任务草稿继续方案与开发';
    if (current?.status === 'error') return '确认重试未完成的 Jira 任务并开始';
    if (current?.items.some(item => item.action === 'reuse' && item.schedule?.changed)) return current.designDestination ? '确认任务、修改日期与方案目录并开始' : '确认创建/关联任务及修改日期并开始';
    return current?.designDestination ? '确认任务与方案目录并开始' : '确认创建/关联前端任务并开始';
  });

  function invalidate() {
    if (locked.value) return;
    task.value = undefined; taskId.value = ''; previewOpen.value = false; save();
    // 表单已变化，旧的校验或预览状态不再准确；底部改为显示实时缺项。
    if (!busy.value && !reading.value) status.value = '';
  }
  function fillBranchDefaults(previousKey?: string) {
    const parsed = parseJiraSource(form.source);
    const nextBranch = parsed ? `feature/${parsed.key}` : '';
    const inherited = (branch: string) => !branch.trim() || branch === 'feature/' || (!!previousKey && branch === `feature/${previousKey}`);
    if (inherited(form.branchName)) form.branchName = nextBranch;
    for (const project of form.additionalProjects) if (inherited(project.branchName)) project.branchName = nextBranch;
  }
  function edit<K extends keyof JiraDevForm>(key: K, value: JiraDevForm[K]) {
    if (locked.value) return;
    const previous = parseJiraSource(form.source);
    form[key] = value;
    if (key === 'source' || key === 'sourceKind') { form.developmentKey = ''; developmentCandidates.value = []; }
    if ((repairDefaults as readonly string[]).includes(key)) edited.add(key);
    if (key === 'source') {
      issue.value = undefined; versions.value = []; versionStatus.value = '';
      form.repairSource = '';
      for (const field of repairDefaults) if (!edited.has(field)) form[field] = '';
      for (const role of roles) for (const date of ['startDate', 'endDate'] as const) if (!edited.has(`${role}.${date}`)) form.schedules[role][date] = '';
      fillBranchDefaults(previous?.key);
    }
    if (key === 'projectPath') form.baseBranch = '';
    if (key === 'repairMode' || key === 'repairProject') fillRepairDefaults();
    if (key === 'sourceKind') { form.schedules = emptySchedules(); for (const item of [...edited]) if (item.includes('.')) edited.delete(item); }
    invalidate();
    if (key === 'sourceKind' && form.sourceKind === 'frontend' && issue.value) void readIssue();
  }
  function selectProjects(paths: string[]) {
    if (locked.value) return;
    const unique = [...new Set(paths.map(path => path.trim()).filter(Boolean))];
    if (unique.length > 10) { ElMessage.warning('一次需求最多选择 10 个项目。'); return; }
    const known = new Map(selectedProjects.value.map(project => [project.path, project]));
    const source = parseJiraSource(form.source);
    const branchName = source && (!form.branchName.trim() || form.branchName === 'feature/') ? `feature/${source.key}` : form.branchName;
    const selections = unique.map(path => known.get(path) || { path, baseBranch: '', branchName });
    const first = selections[0];
    Object.assign(form, { projectPath: first?.path || '', baseBranch: first?.baseBranch || '', branchName: first?.branchName || '', additionalProjects: selections.slice(1) });
    invalidate();
  }
  function editProject(path: string, key: 'baseBranch' | 'branchName', value: string) {
    if (locked.value) return;
    if (form.projectPath === path) form[key] = value;
    else {
      const project = form.additionalProjects.find(item => item.path === path);
      if (!project) return;
      project[key] = value;
    }
    invalidate();
  }
  function editSchedule(role: Role, key: 'startDate' | 'endDate', value: string) {
    if (locked.value) return;
    form.schedules[role][key] = value || '';
    if (value || role === 'parent') edited.add(`${role}.${key}`);
    else edited.delete(`${role}.${key}`);
    syncChildSchedules(); invalidate();
  }
  function syncChildSchedules() {
    if (workflow !== 'requirement' || form.sourceKind !== 'product' || locked.value) return;
    const { startDate, endDate } = form.schedules.parent;
    let days: string[] = [];
    if (startDate && endDate && validScheduleDate(startDate) && validScheduleDate(endDate) && startDate <= endDate) {
      try { days = chinaWorkingDates(startDate, endDate); }
      catch { /* 校验使用同一日历返回具体缺项；不推测日期或沿用旧的自动排期。 */ }
    }
    const first = days[0] || '', last = days.at(-1) || '';
    const designEnd = edited.has('design.endDate') ? form.schedules.design.endDate : first;
    const defaults = { design: { startDate: first, endDate: first },
      implementation: { startDate: days.find(day => day > designEnd) || last, endDate: last } };
    for (const role of ['design', 'implementation'] as const) for (const key of ['startDate', 'endDate'] as const) {
      if (!edited.has(`${role}.${key}`)) form.schedules[role][key] = defaults[role][key];
    }
  }
  const plannedChildren = computed(() => {
    const current = plan.value;
    if (current?.sourceKind !== 'product' || current.needsTitleReview || current.needsScheduleReview) return [];
    return current.items.filter(item => item.role !== 'parent' && (item.workdays || item.key)).map((item, index) => ({
      id: item.id || item.key || `${item.role}:${index}`, role: item.role, summary: item.summary, key: item.key,
      startDate: item.schedule?.startDate, endDate: item.schedule?.endDate, workdays: item.workdays,
    }));
  });
  const draftChildTitles = computed(() => {
    const source = issue.value || (!form.source.trim() && form.details.trim()
      ? { summary: form.details.split(/\r?\n/)[0] || '本地需求', description: form.details }
      : undefined);
    if (!source) return;
    try {
      const title = requirementTitle(source, form.details, form.businessModule, selectedProjects.value.map(project => project.path));
      return { title, scopes: requirementScopes(form.details, source.description) };
    } catch { return; }
  });
  const childSchedules = computed(() => {
    if (workflow !== 'requirement' || form.sourceKind !== 'product') return [];
    if (plannedChildren.value.length) return plannedChildren.value;
    if (locked.value) return [];
    try {
      return (['design', 'implementation'] as const).flatMap(role => {
        const { startDate, endDate } = form.schedules[role];
        if (!startDate || !endDate) return [];
        const parts = splitWorkingDates(chinaWorkingDates(startDate, endDate), 3);
        const draft = draftChildTitles.value;
        const titles = draft ? childScopeTitles({ role, summary: requirementSummary(role, draft.title) }, parts, draft.scopes, draft.title) : [];
        return parts.map((days, index) => ({
          id: `${role}:${days[0]}`, role, summary: titles[index]?.summary || '', key: undefined,
          startDate: days[0]!, endDate: days.at(-1)!, workdays: days.length,
        }));
      });
    } catch { return []; }
  });
  function fillRepairDefaults() {
    const value = issue.value;
    if (workflow !== 'jira' || form.repairMode !== 'create' || !value) return;
    const fill = (key: typeof repairDefaults[number], next: string) => { if (!edited.has(key)) form[key] = next; };
    fill('repairSummary', `前端修复 ${value.summary || value.key}`.slice(0, 250));
    fill('repairProject', value.project?.key || '');
    const sameProject = !form.repairProject || form.repairProject === value.project?.key;
    const sourceVersions = value.fixVersions || [];
    fill('repairVersion', sameProject && sourceVersions.length === 1 ? sourceVersions[0]!.name : '');
    const start = value.startDate && validScheduleDate(value.startDate) ? value.startDate : '';
    const end = value.endDate && validScheduleDate(value.endDate) ? value.endDate : '';
    fill('repairStartDate', start || (end && end < today() ? end : today()));
    fill('repairEndDate', end || (start && start > today() ? start : today()));
  }

  async function readIssue() {
    if (reading.value || locked.value || !form.source.trim()) return;
    const parsed = parseJiraSource(form.source);
    if (!parsed) { status.value = '请输入有效的 Jira Key（如 TEST-123）或当前站点的事项链接。'; ElMessage.warning(status.value); return; }
    fillBranchDefaults();
    const source = form.source;
    const includeDevelopmentCandidates = workflow === 'requirement' && form.sourceKind === 'frontend';
    reading.value = true; status.value = '正在只读读取 Jira…';
    try {
      const result = await jiraDevRequest<JiraDevIssueReadResult>('issue', {
        source, ...(includeDevelopmentCandidates ? { includeDevelopmentCandidates: true } : {}),
      });
      if (form.source !== source) return;
      if (result.issue?.key !== parsed.key) throw new Error('Jira 返回的事项与输入不匹配');
      issue.value = result.issue;
      if (includeDevelopmentCandidates && form.sourceKind === 'frontend') {
        developmentCandidates.value = result.developmentCandidates || [];
        if (!result.developmentCandidateError && form.developmentKey && !developmentCandidates.value.some(candidate => candidate.key === form.developmentKey)) {
          form.developmentKey = '';
          invalidate();
        }
      }
      if (workflow === 'jira') { fillRepairDefaults(); if (form.repairMode === 'create') void loadVersions(); }
      if (workflow === 'requirement') {
        const role = form.sourceKind === 'frontend' ? 'implementation' : 'parent';
        for (const key of ['startDate', 'endDate'] as const) {
          const date = result.issue[key];
          if (!edited.has(`${role}.${key}`) && typeof date === 'string' && validScheduleDate(date)) form.schedules[role][key] = date;
        }
        syncChildSchedules();
      }
      status.value = (form.sourceKind === 'frontend' && result.developmentCandidateError)
        || `已读取 ${result.issue.key}${result.connection?.account?.name ? ` · ${result.connection.account.name}` : ''}`;
    } catch (error) { if (form.source === source) status.value = errorText(error); }
    finally {
      reading.value = false;
      if (workflow === 'requirement' && !includeDevelopmentCandidates && form.sourceKind === 'frontend'
        && form.source === source && issue.value?.key === parsed.key) void readIssue();
    }
  }
  async function loadVersions() {
    const source = form.source, projectKey = form.repairProject;
    versions.value = [];
    if (!parseJiraSource(source) || (projectKey && !/^[A-Z][A-Z0-9_]*$/.test(projectKey))) return;
    versionStatus.value = '正在读取项目可用版本…';
    try {
      const value = await jiraDevRequest<{ projectKey: string; versions: { name: string }[]; truncated: boolean }>('versions', { source, ...(projectKey ? { projectKey } : {}) });
      if (form.source !== source || form.repairProject !== projectKey) return;
      versions.value = value.versions.map(item => item.name);
      versionStatus.value = `${value.projectKey}：${value.versions.length} 个可用版本${value.truncated ? '（已截断）' : ''}`;
    } catch (error) { if (form.source === source && form.repairProject === projectKey) versionStatus.value = `${errorText(error)}；可填写已确认的准确版本名称。`; }
  }

  function validate() {
    if (!form.projectPath.trim()) return '请选择本地项目目录。';
    if (!form.baseBranch.trim()) return '请填写基准分支。';
    if (!form.branchName.trim()) return '请填写工作分支。';
    for (const project of selectedProjects.value.slice(1)) {
      if (!project.baseBranch.trim()) return `请填写 ${project.path} 的基准分支。`;
      if (!project.branchName.trim()) return `请填写 ${project.path} 的工作分支。`;
    }
    if (form.source.trim() && !parseJiraSource(form.source)) return '请输入有效的 Jira Key 或当前站点的事项链接。';
    if (workflow === 'jira' && !form.source.trim()) return '请填写需要修复的 Jira Key 或链接。';
    if (workflow === 'jira' && form.repairMode === 'reuse' && form.repairSource.trim() && !parseJiraSource(form.repairSource)) return '请填写有效的开发主任务或修复子任务编号。';
    if (workflow === 'requirement' && form.sourceKind === 'frontend' && !form.source.trim()) return '请填写要复用的 Jira 主任务或子任务编号。';
    if (workflow === 'requirement' && form.sourceKind === 'frontend' && developmentCandidates.value.length > 1 && !form.developmentKey) return '请选择要复用的 Jira 开发主任务。';
    if (workflow === 'requirement' && !form.source.trim() && !form.details.trim()) return '请填写需求 Jira 或需求正文。';
    if (workflow === 'jira' && form.repairMode === 'create') {
      if (form.repairProject && !/^[A-Z][A-Z0-9_]*$/.test(form.repairProject)) return '请填写有效的目标 Jira 项目 Key。';
      if (!validScheduleDate(form.repairStartDate) || !validScheduleDate(form.repairEndDate) || (form.repairStartDate && form.repairEndDate && form.repairEndDate < form.repairStartDate)) return '请填写有效的计划日期，结束日期不能早于开始日期。';
    }
    if (workflow === 'requirement') for (const role of roles) {
      if (role === 'parent' && form.sourceKind === 'frontend') continue;
      const { startDate, endDate } = form.schedules[role];
      const label = role === 'parent' ? '前端 DEV' : role === 'design' ? '技术方案' : '前端实现';
      if (!validScheduleDate(startDate) || !validScheduleDate(endDate)) return `请填写${label}的有效计划日期。`;
      if (startDate && endDate && endDate < startDate) return `${label}的计划结束日期不能早于计划开始日期。`;
    }
    if (workflow === 'requirement' && form.sourceKind === 'product') {
      const { startDate, endDate } = form.schedules.parent;
      if (startDate && endDate) {
        try { if (!chinaWorkingDates(startDate, endDate).length) return '主任务所选日期没有工作日，请调整排期。'; }
        catch (error) { return errorText(error); }
      }
    }
    return '';
  }
  function requestBody() {
    const base = { workflow, projectPath: form.projectPath, source: form.source, details: form.details, baseBranch: form.baseBranch, branchName: form.branchName, useI18n: form.useI18n };
    if (workflow === 'jira') return { ...base, repairMode: form.repairMode, ...(form.repairMode === 'create'
      ? Object.fromEntries(repairDefaults.map(key => [key, form[key]])) : form.repairMode === 'reuse' ? { repairSource: form.repairSource } : {}) };
    // 只提交明确修改的日期；产品需求的默认主任务日期由后台实时读取并拆分。
    const schedules = Object.fromEntries(roles.map(role => [role, Object.fromEntries((['startDate', 'endDate'] as const)
      .map(key => [key, edited.has(`${role}.${key}`) ? form.schedules[role][key] : '']))]));
    return { ...base, projects: selectedProjects.value, sourceKind: form.sourceKind, businessModule: form.businessModule, designSource: form.designSource, schedules,
      ...(form.sourceKind === 'frontend' && form.developmentKey ? { developmentKey: form.developmentKey } : {}) };
  }
  function accept(value: JiraDevTaskView) {
    task.value = value; taskId.value = value.taskId;
    if (workflow === 'jira' && value.plan?.status === 'applied' && value.repairMode !== 'direct') form.branchName = value.branchName;
    save();
  }
  async function prepare() {
    if (busy.value || reading.value || locked.value) return;
    const problem = validate();
    if (problem) { status.value = problem; ElMessage.warning(problem); return; }
    busy.value = true; status.value = '正在核对项目与生成任务预览…';
    try {
      accept(await jiraDevRequest<JiraDevTaskView>('prepare', requestBody()));
      status.value = task.value?.warning || '请核对预览，确认后在工作台新建会话开始。';
      previewOpen.value = true;
    } catch (error) { status.value = errorText(error); }
    finally { busy.value = false; }
  }
  async function openScanPreview(id: string, issueKey: string) {
    if (busy.value || reading.value || locked.value && taskId.value !== id) return false;
    busy.value = true;
    try {
      const value = await jiraDevRequest<JiraDevTaskView>('task', { taskId: id });
      if (value.workflow !== workflow) throw new Error('预览类型与当前页面不一致');
      edited.clear();
      issue.value = value.plan?.sourceIssue;
      developmentCandidates.value = value.plan?.developmentCandidates || [];
      versions.value = [];
      versionStatus.value = '';
      Object.assign(form, emptyForm(), {
        source: value.plan?.sourceIssue?.url || issueKey,
        projectPath: value.projectPath,
        baseBranch: value.baseBranch,
        branchName: value.branchName,
        repairMode: value.repairMode || 'direct',
        sourceKind: value.plan?.sourceKind === 'product' ? 'product' : 'frontend',
        useI18n: value.useI18n ?? form.useI18n,
        additionalProjects: value.projects?.slice(1).map(({ path, baseBranch, branchName }) => ({ path, baseBranch, branchName })) || [],
      });
      accept(value);
      status.value = value.warning || '已打开巡检预览，请核对任务后继续。';
      previewOpen.value = true;
      return true;
    } catch (error) { ElMessage.error(errorText(error)); return false; }
    finally { busy.value = false; }
  }
  async function check(developmentKey?: string) {
    if (!taskId.value || busy.value) return;
    busy.value = true; status.value = '正在只读核对任务…';
    try {
      accept(await jiraDevRequest<JiraDevTaskView>('check', { taskId: taskId.value, ...(developmentKey ? { developmentKey } : {}) }));
      if (task.value?.plan?.developmentCandidates) developmentCandidates.value = task.value.plan.developmentCandidates;
      if (developmentKey && task.value?.plan?.status === 'ready') form.developmentKey = developmentKey;
      status.value = task.value?.plan?.warning || (task.value?.plan?.status === 'unknown' ? 'Jira 任务结果仍待核对；未再次提交。' : '已核对任务。');
    } catch (error) { status.value = `${errorText(error)}。核对未完成，未重复提交。`; }
    finally { busy.value = false; }
  }
  async function restore() {
    if (!taskId.value) return;
    const restoringTaskId = taskId.value;
    try {
      const value = await jiraDevRequest<JiraDevTaskView>('task', { taskId: restoringTaskId });
      if (taskId.value !== restoringTaskId) return;
      if (context && !form.projectPath) {
        Object.assign(form, { projectPath: value.projectPath, baseBranch: value.baseBranch, branchName: value.branchName,
          additionalProjects: value.projects?.slice(1).map(project => ({ path: project.path, baseBranch: project.baseBranch, branchName: project.branchName })) || [] });
      }
      accept(value);
    }
    catch { if (taskId.value === restoringTaskId) { taskId.value = ''; task.value = undefined; save(); } }
  }
  async function prepareReview(runtime: JiraDevRuntimeSelection) {
    if (!task.value || busy.value || launched.value) return;
    busy.value = true;
    try {
      accept(await jiraDevRequest<JiraDevTaskView>('requirement-prepare', { taskId: task.value.taskId, phase: 'review', runtime }));
      status.value = '';
    } catch (error) { status.value = errorText(error); }
    finally { busy.value = false; }
  }
  watch(() => previewOpen.value && task.value && (['review', 'design'] as JiraDevRequirementPhase[])
    .some(phase => task.value?.preparation?.[phase]?.status === 'running') ? task.value.taskId : '', (id, _old, cleanup) => {
    if (!id) return;
    const controller = new AbortController();
    let readingPreparation = false;
    const timer = setInterval(async () => {
      if (busy.value || readingPreparation) return;
      readingPreparation = true;
      try {
        const value = await jiraDevRequest<JiraDevTaskView>('task', { taskId: id }, controller.signal);
        if (!controller.signal.aborted && taskId.value === id && !busy.value) accept(value);
      } catch { /* 可继续用预览里的核对按钮读回状态。 */ }
      finally { readingPreparation = false; }
    }, 3000);
    cleanup(() => { clearInterval(timer); controller.abort(); });
  });
  async function start(runtime: JiraDevRuntimeSelection) {
    let current = task.value;
    if (!current || busy.value || launched.value || startBlocker.value) return;
    const groupRequirement = workflow === 'requirement' && runtime.collaborationMode === 'group';
    if (groupRequirement && (current.preparation?.review?.status !== 'ready' || current.preparation.design?.status === 'running')) return;
    busy.value = true;
    try {
      if (jiraDevNeedsApply(current)) {
        status.value = current.plan?.status === 'local' ? '正在确认技术方案目录…' : '正在执行已确认的 Jira 创建或关联…';
        current = await jiraDevRequest<JiraDevTaskView>('apply', { taskId: current.taskId, confirmed: true, ...(groupRequirement ? { group: true } : {}) }).catch(error => {
          throw new Error(`${errorText(error)}。Jira 任务结果待核对，请点“只读核对”；不会重新创建任务。`);
        });
        accept(current);
        const next = current.plan;
        if (next?.status === 'ready' && next.requiresConfirmation) { status.value = next.warning || '已更新任务与日期预览，请核对后再次确认。'; return; }
        if (next?.status === 'error') { status.value = next.warning || 'Jira 明确返回失败，可核对后确认重试未完成项；已创建项会复用。'; return; }
        if (jiraDevStartBlocker(current) || jiraDevNeedsApply(current)) { status.value = next?.warning || jiraDevStartBlocker(current) || 'Jira 任务尚未就绪，未启动会话。'; return; }
      }
      if (groupRequirement && current.preparation?.design?.status !== 'ready') {
        accept(await jiraDevRequest<JiraDevTaskView>('requirement-prepare', { taskId: current.taskId, phase: 'design', runtime }));
        status.value = '';
        return;
      }
      status.value = '正在拉取基准、创建独立工作区并启动会话…';
      const result = await jiraDevRequest<JiraDevTaskView>('start', { taskId: current.taskId, runtime, confirmed: true });
      accept(result);
      if (result.launch?.groupRoomId) { status.value = '团队群聊已创建，成员将按职责接续执行。'; previewOpen.value = false; openRun(`group:${result.launch.groupRoomId}`); }
      else if (result.launch?.runId) { status.value = '会话已在工作台启动。'; previewOpen.value = false; openRun(result.launch.conversationId || result.launch.runId); }
      else if (result.launch?.conversationId) { status.value = result.launch.error || '团队已创建，请在会话中核对执行状态。'; previewOpen.value = false; openRun(result.launch.conversationId); }
      else status.value = result.launch?.error || '启动未完成，请核对任务状态。';
    } catch (error) { status.value = errorText(error); ElMessage.error(status.value); }
    finally { busy.value = false; }
  }
  function next() {
    if (busy.value || reading.value) return;
    const { projectPath, baseBranch, useI18n, repairMode, sourceKind } = form;
    const additionalProjects = form.additionalProjects.map(project => ({ ...project, branchName: '' }));
    Object.assign(form, emptyForm(), { projectPath, baseBranch, additionalProjects, useI18n, repairMode, sourceKind });
    edited.clear(); issue.value = undefined; developmentCandidates.value = []; versions.value = []; versionStatus.value = '';
    task.value = undefined; taskId.value = ''; previewOpen.value = false; save();
    status.value = '已准备下一项，保留项目和基准分支；原任务记录与会话仍保留。';
  }
  // 底部操作栏展示当前缺项，避免按钮不可用却不知原因。
  const problem = computed(() => validate());
  // 草稿只保存表单；刷新后若已填写有效 Jira 且未锁定，自动只读重新读取，恢复事项摘要与默认值。
  void restore().then(() => { syncChildSchedules(); if (!locked.value && parseJiraSource(form.source)) void readIssue(); });
  return { form, issue, task, plan, taskId, reading, busy, status, locked, launched, needsApply, startBlocker, startLabel, previewOpen,
    developmentCandidates, versions, versionStatus, childSchedules, plannedChildren, problem, selectedProjects, selectProjects, editProject, edit, editSchedule, readIssue, loadVersions, prepare, openScanPreview, check, prepareReview, start, next };
}
