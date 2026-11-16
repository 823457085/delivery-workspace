/**
 * 设计说明：借鉴 OpenHands (`useAgentNotification`) 与 Claude Squad 的后台值守机制。
 * 1. 仅在任务状态发生「运行中/排队 -> 完成/失败/需人工确认」真实跃迁时触发，首屏快照与历史同步绝不误报；
 * 2. 支持浏览器标题栏实时进度角标（如 `● 2 运行中`、`⚠ 1 待确认`）；
 * 3. 用户开启「完成提醒」后，提供轻柔提示音 + 系统桌面通知（后台标签页时点击通知直达对应会话）。
 */
import { computed, shallowRef } from 'vue';
import { ElNotification } from 'element-plus';

export const COMPLETION_NOTIFY_STORAGE_KEY = 'agent-completion-notify:v1';

export type AgentTransitionNoticeKind = 'completed' | 'failed' | 'attention';

export interface AgentTransitionSnapshotItem {
  id: string;
  title: string;
  status: string;
  changedFileCount?: number;
  isGroup?: boolean;
}

export interface AgentTransitionNotice {
  id: string;
  targetId: string;
  isGroup: boolean;
  kind: AgentTransitionNoticeKind;
  title: string;
  body: string;
}

const ACTIVE_STATES = new Set(['queued', 'running', 'planning', 'saving']);
const COMPLETED_STATES = new Set(['completed']);
const FAILED_STATES = new Set(['failed', 'interrupted', 'blocked', 'needs_reconciliation']);
const ATTENTION_STATES = new Set(['waiting_input', 'needs_decision', 'waiting_login', 'needs-review']);

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readCompletionNotifyEnabled(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    const parsed = JSON.parse(storage.getItem(COMPLETION_NOTIFY_STORAGE_KEY) || 'null');
    return !!parsed && parsed.enabled === true;
  } catch {
    return false;
  }
}

export function writeCompletionNotifyEnabled(
  enabled: boolean,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(COMPLETION_NOTIFY_STORAGE_KEY, JSON.stringify({ enabled }));
  } catch {
    /* 忽略隐私模式写入异常 */
  }
}

const notifyEnabledState = shallowRef<boolean>(readCompletionNotifyEnabled());
export const workspaceRunningCount = shallowRef(0);
export const workspaceAttentionCount = shallowRef(0);

export function setWorkspaceLiveActivityCounts(running: number, attention: number) {
  workspaceRunningCount.value = Math.max(0, running);
  workspaceAttentionCount.value = Math.max(0, attention);
}

export function playCompletionChime(kind: AgentTransitionNoticeKind | 'ready' = 'completed') {
  if (typeof window === 'undefined') return;
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = kind === 'failed'
      ? [392, 311.13]
      : kind === 'attention'
        ? [523.25, 659.25]
        : kind === 'ready'
          ? [587.33, 783.99]
          : [523.25, 659.25, 783.99];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.09);
      gain.gain.setValueAtTime(0.0001, now + idx * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.06, now + idx * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.09 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.09);
      osc.stop(now + idx * 0.09 + 0.2);
    });
    setTimeout(() => { void ctx.close().catch(() => {}); }, 800);
  } catch {
    /* 浏览器音频策略受限时静默降级 */
  }
}

export async function toggleCompletionNotify(storage: Storage | null = defaultStorage()): Promise<boolean> {
  const next = !notifyEnabledState.value;
  notifyEnabledState.value = next;
  writeCompletionNotifyEnabled(next, storage);
  if (next) {
    playCompletionChime('ready');
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* 用户忽略或浏览器限制时保留页面内提醒与提示音 */
      }
    }
  }
  return next;
}

export function useCompletionNotifyPreference() {
  return {
    enabled: computed(() => notifyEnabledState.value),
    toggle: () => toggleCompletionNotify(),
  };
}

export function detectAgentTransitionNotifications(
  previousByKey: Map<string, string>,
  items: readonly AgentTransitionSnapshotItem[],
  initialized: boolean,
): AgentTransitionNotice[] {
  const notices: AgentTransitionNotice[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    const key = `${item.isGroup ? 'group' : 'conv'}:${item.id}`;
    seenKeys.add(key);
    const prev = previousByKey.get(key);
    previousByKey.set(key, item.status);
    if (!initialized || !prev || prev === item.status) continue;
    if (!ACTIVE_STATES.has(prev)) continue;

    const shortTitle = (item.title || '未命名会话').trim().slice(0, 48);
    if (COMPLETED_STATES.has(item.status)) {
      const filesHint = item.changedFileCount ? `（改动 ${item.changedFileCount} 个文件）` : '';
      notices.push({
        id: `${key}:completed:${Date.now()}`,
        targetId: item.id,
        isGroup: !!item.isGroup,
        kind: 'completed',
        title: item.isGroup ? '团队协作已完成' : 'AI 任务已完成',
        body: `${shortTitle}${filesHint}`,
      });
    } else if (ATTENTION_STATES.has(item.status)) {
      notices.push({
        id: `${key}:attention:${Date.now()}`,
        targetId: item.id,
        isGroup: !!item.isGroup,
        kind: 'attention',
        title: '需要你确认后继续',
        body: shortTitle,
      });
    } else if (FAILED_STATES.has(item.status)) {
      notices.push({
        id: `${key}:failed:${Date.now()}`,
        targetId: item.id,
        isGroup: !!item.isGroup,
        kind: 'failed',
        title: item.isGroup ? '团队任务遇到阻塞' : 'AI 任务执行未通过',
        body: shortTitle,
      });
    }
  }

  for (const existingKey of [...previousByKey.keys()]) {
    if (!seenKeys.has(existingKey)) previousByKey.delete(existingKey);
  }

  return notices;
}

export function formatWorkspaceTabTitle(baseTitle: string, runningCount: number, attentionCount: number): string {
  const cleanBase = baseTitle.trim() || 'Agent Studio · Delivery Workspace';
  if (attentionCount > 0) return `⚠ ${attentionCount} 待确认 · ${cleanBase}`;
  if (runningCount > 0) return `● ${runningCount} 运行中 · ${cleanBase}`;
  return cleanBase;
}

export function dispatchAgentTransitionNotice(
  notice: AgentTransitionNotice,
  onOpenTarget?: (notice: AgentTransitionNotice) => void,
) {
  if (!notifyEnabledState.value || typeof window === 'undefined') return;
  playCompletionChime(notice.kind);

  const isHidden = typeof document !== 'undefined' && document.hidden;
  if (isHidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const desktop = new Notification(notice.title, {
        body: `${notice.body}\n点击返回 5288 工作台查看`,
        tag: `${notice.isGroup ? 'group' : 'conv'}:${notice.targetId}`,
      });
      desktop.onclick = () => {
        window.focus();
        onOpenTarget?.(notice);
        desktop.close();
      };
      return;
    } catch {
      /* 降级到页面内通知卡片 */
    }
  }

  ElNotification({
    title: notice.title,
    message: `${notice.body}（点击查看）`,
    type: notice.kind === 'completed' ? 'success' : notice.kind === 'attention' ? 'warning' : 'error',
    duration: 5500,
    position: 'bottom-right',
    onClick: () => {
      onOpenTarget?.(notice);
    },
  });
}
