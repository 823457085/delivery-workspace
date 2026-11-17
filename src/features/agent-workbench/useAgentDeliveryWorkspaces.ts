/** 会话的交付项目独立于历史执行目录，仅保存本浏览器的展示关联。 */
import { computed, shallowRef, toValue, type MaybeRefOrGetter } from 'vue';

export interface AgentDeliveryWorkspace { path: string; label: string }
type WorkspaceSelections = Record<string, AgentDeliveryWorkspace[]>;
type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const AGENT_DELIVERY_WORKSPACES_STORAGE_KEY = 'agent-delivery-workspaces:v1';

export function normalizeAgentDeliveryWorkspaces(input: unknown): AgentDeliveryWorkspace[] {
  if (!Array.isArray(input) || input.length > 10) throw new Error('最多关联 10 个交付项目');
  const unique = new Map<string, AgentDeliveryWorkspace>();
  for (const item of input) {
    const path = typeof item?.path === 'string' ? item.path.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 80) : '';
    if (!path || path.length > 4096 || !/^(?:\/|[A-Za-z]:[\\/])/.test(path)) throw new Error('请输入项目的完整工作区路径');
    if (!unique.has(path)) unique.set(path, { path, label });
  }
  return [...unique.values()];
}

export async function validateAgentDeliveryWorkspaces(
  input: AgentDeliveryWorkspace[],
  snapshot: (path: string) => Promise<{ isGit: boolean; directory: string }>,
): Promise<AgentDeliveryWorkspace[]> {
  const rows = normalizeAgentDeliveryWorkspaces(input);
  const validated = await Promise.all(rows.map(async row => {
    const project = await snapshot(row.path);
    if (!project.isGit || !project.directory) throw new Error(`工作区不是 Git 项目：${row.path}`);
    return { ...row, path: project.directory };
  }));
  return normalizeAgentDeliveryWorkspaces(validated);
}

function browserStorage(): WorkspaceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function createAgentDeliveryWorkspaceStore(storage: WorkspaceStorage | null) {
  const selections = shallowRef<WorkspaceSelections>({});
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(AGENT_DELIVERY_WORKSPACES_STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const valid: WorkspaceSelections = {};
      for (const [id, rows] of Object.entries(parsed)) {
        try { Object.defineProperty(valid, id, { value: normalizeAgentDeliveryWorkspaces(rows), enumerable: true, configurable: true }); }
        catch { /* 损坏的单个会话配置不影响其他会话。 */ }
      }
      selections.value = valid;
    }
  } catch { /* 无效或无法读取的本地偏好回退为执行目录。 */ }

  function persist(next: WorkspaceSelections) {
    if (!storage) throw new Error('浏览器本地存储不可用，交付项目尚未保存');
    storage.setItem(AGENT_DELIVERY_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
    selections.value = next;
  }
  const get = (id: string): AgentDeliveryWorkspace[] | undefined => Object.hasOwn(selections.value, id) ? selections.value[id] : undefined;
  return {
    get,
    resolve(id: string, defaults: string[], bound = false) {
      const custom = get(id);
      if (!bound && custom) return custom;
      return [...new Set(defaults.filter(Boolean))]
        .map(path => ({ path, label: custom?.find(item => item.path === path)?.label || '' }));
    },
    save(id: string, rows: AgentDeliveryWorkspace[]) {
      if (!id.trim()) throw new Error('请先选择会话');
      persist({ ...selections.value, [id]: normalizeAgentDeliveryWorkspaces(rows) });
    },
    reset(id: string) {
      const next = { ...selections.value };
      delete next[id];
      persist(next);
    },
  };
}

let sharedStore: ReturnType<typeof createAgentDeliveryWorkspaceStore> | undefined;
export function useAgentDeliveryWorkspaces(conversationId: MaybeRefOrGetter<string | undefined>, defaults: MaybeRefOrGetter<string[]>,
  bound: MaybeRefOrGetter<boolean | undefined> = false) {
  const store = sharedStore ??= createAgentDeliveryWorkspaceStore(browserStorage());
  const workspaces = computed(() => store.resolve(toValue(conversationId) || '', toValue(defaults), toValue(bound)));
  return { workspaces, save: store.save, reset: store.reset };
}
