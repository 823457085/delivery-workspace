/**
 * 设计说明：项目扫描、Git 状态和项目默认设置均为只读查询（保存默认值除外），
 * 与插件一致：读取不 fetch、不改仓库；默认值只影响后续新任务预览。
 */
import { computed, reactive, shallowRef, watch, type Ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { jiraDevRequest } from './useJiraDevTask';

interface ScanResult { projects: { name: string; path: string; checkouts?: { path: string }[] }[]; truncated?: boolean; warnings?: string[] }
interface ProjectStatus { branch: string | null; detached: boolean; unborn?: boolean; upstream: string | null; ahead: number | null; behind: number | null;
  staged: number; modified: number; untracked: number; clean: boolean }
interface Destination { site: string; spaceKey: string; parentId: string; title: string; url: string }
interface Preferences { scopeId: string; revision: string; settings: { baseBranch: string; designMode: 'default' | 'custom' | 'local'; designDestination?: Destination };
  designDestination: Destination | null; branches: string[]; truncated: boolean }
const scanRootsKey = 'qiyuan:jira-dev:scan-roots:v1';

export function useJiraDevProject(projectPath: Ref<string>, applyDefaultBase: (branch: string) => void,
  selectedPaths: () => string[] = () => [projectPath.value]) {
  const roots = shallowRef(localStorage.getItem(scanRootsKey) || '');
  const scanRoots = shallowRef(roots.value);
  const scan = useQuery({ queryKey: ['jira-dev-scan', scanRoots], retry: false, staleTime: 5 * 60_000,
    queryFn: ({ signal }) => {
      const list = scanRoots.value.split('\n').map(item => item.trim()).filter(Boolean);
      return jiraDevRequest<ScanResult>('scan', list.length ? { roots: list } : {}, signal);
    } });
  const candidates = computed(() => (scan.data.value?.projects || []).map(project => {
    const selected = selectedPaths().find(path => path === project.path || project.checkouts?.some(item => item.path === path));
    return { name: project.name, path: selected || project.path };
  }));
  const scanSummary = computed(() => {
    if (scan.isFetching.value) return '正在扫描本机项目…';
    if (scan.error.value) return scan.error.value.message;
    const data = scan.data.value;
    return data ? `发现 ${data.projects.length} 个项目${data.truncated ? ' · 结果已截断，请缩小扫描范围' : ''}${data.warnings?.length ? ` · ${data.warnings.join('；')}` : ''}` : '';
  });
  function rescan() {
    try { localStorage.setItem(scanRootsKey, roots.value); } catch { /* 本次扫描仍生效。 */ }
    if (scanRoots.value === roots.value) void scan.refetch(); else scanRoots.value = roots.value;
  }

  const selected = computed(() => projectPath.value.trim());
  const status = useQuery({ queryKey: ['jira-dev-project-status', selected], enabled: computed(() => selected.value.startsWith('/')), retry: false, staleTime: 30_000,
    queryFn: ({ signal }) => jiraDevRequest<ProjectStatus>('project-status', { projectPath: selected.value }, signal) });
  const statusText = computed(() => {
    const value = status.data.value;
    if (!value) return { branch: '', changes: '' };
    const branch = value.detached ? '游离 HEAD' : `${value.branch}${value.unborn ? '（尚无提交）' : ''}`;
    const comparison = value.upstream ? `上游 ${value.upstream} · ${value.ahead === null || value.behind === null ? '暂无法比较领先／落后' : `领先 ${value.ahead} · 落后 ${value.behind}`}` : '未设置上游';
    return { branch: `${branch} · ${comparison}`, changes: `${value.clean ? '工作区干净' : '有未提交改动'} · 暂存 ${value.staged} · 修改 ${value.modified} · 未跟踪 ${value.untracked}` };
  });

  const preferences = shallowRef<Preferences>();
  const preferenceStatus = shallowRef(''), savingPreferences = shallowRef(false);
  const draft = reactive({ baseBranch: '', designMode: 'default' as Preferences['settings']['designMode'], site: '', spaceKey: '', parentId: '', title: '' });
  let sequence = 0;
  async function loadPreferences() {
    const path = selected.value, current = ++sequence;
    preferences.value = undefined; preferenceStatus.value = '';
    if (!path.startsWith('/')) return;
    preferenceStatus.value = '正在读取项目默认设置与分支候选…';
    try {
      const value = await jiraDevRequest<Preferences>('preferences', { projectPath: path });
      if (current !== sequence) return;
      preferences.value = value;
      const destination = value.settings.designDestination;
      Object.assign(draft, { baseBranch: value.settings.baseBranch, designMode: value.settings.designMode, site: destination?.site || '',
        spaceKey: destination?.spaceKey || '', parentId: destination?.parentId || '', title: destination?.title || '' });
      if (value.settings.baseBranch) applyDefaultBase(value.settings.baseBranch);
      preferenceStatus.value = `已读取 ${value.branches.length} 个本地 origin 分支候选${value.truncated ? '（已截断）' : ''}；创建工作区时仍会拉取所选基准。`;
    } catch (error) { if (current === sequence) preferenceStatus.value = error instanceof Error ? error.message : String(error); }
  }
  async function savePreferences() {
    const value = preferences.value, path = selected.value;
    if (!value || savingPreferences.value) return;
    savingPreferences.value = true;
    try {
      const settings = { baseBranch: draft.baseBranch, designMode: draft.designMode,
        ...(draft.designMode === 'custom' ? { designDestination: { site: draft.site, spaceKey: draft.spaceKey, parentId: draft.parentId, title: draft.title } } : {}) };
      const result = await jiraDevRequest<Omit<Preferences, 'branches' | 'truncated'>>('preferences/save', { projectPath: path, scopeId: value.scopeId, expectedRevision: value.revision, settings });
      if (selected.value === path) {
        preferences.value = { ...value, ...result };
        preferenceStatus.value = '项目默认设置已保存，应用于新任务预览；已有确认计划保持原目录。';
      }
    } catch (error) { preferenceStatus.value = error instanceof Error ? error.message : String(error); }
    finally { savingPreferences.value = false; }
  }
  const destinationSummary = computed(() => {
    const destination = preferences.value?.designDestination;
    return destination ? `${destination.site} / ${destination.spaceKey} / ${destination.title}（${destination.parentId}）` : preferences.value ? '技术方案仅保存本地。' : '';
  });
  watch(selected, () => { void loadPreferences(); }, { immediate: true });
  return { roots, scan, candidates, scanSummary, rescan, status, statusText, preferences, preferenceStatus, savingPreferences, draft,
    destinationSummary, loadPreferences, savePreferences };
}
