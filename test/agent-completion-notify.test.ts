import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectAgentTransitionNotifications,
  formatWorkspaceTabTitle,
  readCompletionNotifyEnabled,
  writeCompletionNotifyEnabled,
} from '../src/features/agent-workbench/useAgentCompletionNotify.js';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.get(key) ?? null; },
    key(index: number) { return [...map.keys()][index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, value); },
  };
}

test('detectAgentTransitionNotifications 首屏快照不误报，仅在运行态跃迁到终态或待确认态时触发', () => {
  const stateMap = new Map<string, string>();

  const initial = detectAgentTransitionNotifications(
    stateMap,
    [
      { id: 'c1', title: '旧已完成会话', status: 'completed', changedFileCount: 2 },
      { id: 'c2', title: '正在修复接口', status: 'running' },
      { id: 'g1', title: '前后端联调群', status: 'running', isGroup: true },
    ],
    false,
  );
  assert.deepEqual(initial, [], '首屏加载已有快照绝不发送通知');

  const syncHistorical = detectAgentTransitionNotifications(
    stateMap,
    [
      { id: 'c1', title: '旧已完成会话', status: 'completed', changedFileCount: 2 },
      { id: 'c2', title: '正在修复接口', status: 'completed', changedFileCount: 3 },
      { id: 'c3', title: '新同步的历史完成会话', status: 'completed' },
      { id: 'g1', title: '前后端联调群', status: 'waiting_login', isGroup: true },
    ],
    true,
  );

  assert.equal(syncHistorical.length, 2);
  assert.equal(syncHistorical[0]?.targetId, 'c2');
  assert.equal(syncHistorical[0]?.kind, 'completed');
  assert.ok(syncHistorical[0]?.body.includes('改动 3 个文件'));
  assert.equal(syncHistorical[1]?.targetId, 'g1');
  assert.equal(syncHistorical[1]?.kind, 'attention');

  const repeatedPoll = detectAgentTransitionNotifications(
    stateMap,
    [
      { id: 'c2', title: '正在修复接口', status: 'completed', changedFileCount: 3 },
      { id: 'g1', title: '前后端联调群', status: 'waiting_login', isGroup: true },
    ],
    true,
  );
  assert.deepEqual(repeatedPoll, [], '状态未再次跃迁时不重复提醒');
});

test('formatWorkspaceTabTitle 优先展示待确认，其次展示运行中数量，空闲时恢复原页面标题', () => {
  assert.equal(formatWorkspaceTabTitle('Agent Studio · Delivery Workspace', 0, 0), 'Agent Studio · Delivery Workspace');
  assert.equal(formatWorkspaceTabTitle('Agent Studio · Delivery Workspace', 2, 0), '● 2 运行中 · Agent Studio · Delivery Workspace');
  assert.equal(formatWorkspaceTabTitle('Agent Studio · Delivery Workspace', 2, 1), '⚠ 1 待确认 · Agent Studio · Delivery Workspace');
});

test('readCompletionNotifyEnabled / writeCompletionNotifyEnabled 持久化开关偏好', () => {
  const storage = createMemoryStorage();
  assert.equal(readCompletionNotifyEnabled(storage), false);
  writeCompletionNotifyEnabled(true, storage);
  assert.equal(readCompletionNotifyEnabled(storage), true);
  writeCompletionNotifyEnabled(false, storage);
  assert.equal(readCompletionNotifyEnabled(storage), false);
});
