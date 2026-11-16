import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceTodoInputSchema } from '../shared/workspace-todos';
import type { PortSnapshot } from '../shared/port-monitor';
import { buildTodoAgentPrompt, parseQuickTodoInput } from '../src/features/workbench/todo-quick-parse';
import {
  formatAmbientClock,
  isZenToggleShortcut,
  readZenFocusPreference,
  saveZenFocusPreference,
  ZEN_FOCUS_STORAGE_KEY,
} from '../src/shared/ui/zenFocus';
import {
  buildPortCommandItems,
  COMMAND_PINS_STORAGE_KEY,
  normalizePinnedCommandIds,
  readPinnedCommandIds,
  togglePinnedCommandId,
  writePinnedCommandIds,
} from '../src/pages/agent/command-palette-pins';
import { buildCommandPaletteItems, filterCommandPaletteItems } from '../src/pages/agent/command-palette';
import { registeredWorkspaceSections } from '../src/pages/agent/workspace-navigation';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

test('parseQuickTodoInput parses priority, relative/calendar dates, inline notes, and validates against workspaceTodoInputSchema', () => {
  // Monday 2026-11-16
  const baseDate = new Date(2026, 10, 16, 10, 30, 0);

  const parsedTomorrow = parseQuickTodoInput('核对海外网关回调签名 !高 @明天 // 重点确认超时重试幂等键', baseDate);
  assert.equal(parsedTomorrow.title, '核对海外网关回调签名');
  assert.equal(parsedTomorrow.priority, 'high');
  assert.equal(parsedTomorrow.dueDate, '2026-11-17');
  assert.equal(parsedTomorrow.details, '重点确认超时重试幂等键');
  assert.deepEqual(parsedTomorrow.matchedTokens, ['!高', '@明天']);
  assert.doesNotThrow(() =>
    workspaceTodoInputSchema.parse({
      title: parsedTomorrow.title,
      details: parsedTomorrow.details,
      dueDate: parsedTomorrow.dueDate,
      priority: parsedTomorrow.priority,
    }),
  );

  // Weekday tokens: @周五 -> 2026-11-20, @下周一 -> 2026-11-23
  assert.equal(parseQuickTodoInput('准备版本发布清单 @周五', baseDate).dueDate, '2026-11-20');
  assert.equal(parseQuickTodoInput('周会复盘对齐 @下周一 p1', baseDate).dueDate, '2026-11-23');
  assert.equal(parseQuickTodoInput('周会复盘对齐 @下周一 p1', baseDate).priority, 'high');

  // Relative days & short MM-DD
  assert.equal(parseQuickTodoInput('清理过期镜像 @3天后', baseDate).dueDate, '2026-11-19');
  assert.equal(parseQuickTodoInput('续期测试证书 @11-28', baseDate).dueDate, '2026-11-28');

  // Past month rolls over cleanly when >30 days in the past
  assert.equal(parseQuickTodoInput('年度归档巡检 @01-15', baseDate).dueDate, '2027-01-15');

  // Invalid calendar date (e.g. Feb 30) is NOT accepted as dueDate so backend validation never fails
  const invalidFeb = parseQuickTodoInput('异常日期兜底测试 @2026-02-30', baseDate);
  assert.equal(invalidFeb.dueDate, '');
  assert.equal(invalidFeb.title, '异常日期兜底测试 @2026-02-30');
});

test('buildTodoAgentPrompt formats structured context for 1-click AI delegation', () => {
  const prompt = buildTodoAgentPrompt({
    title: '排查 5288 端口热重载偶发断连',
    details: '复现路径：连续切换工作树后 SSE 重连延迟',
    priority: 'high',
    dueDate: '2026-11-18',
  });
  assert.match(prompt, /排查 5288 端口热重载偶发断连/);
  assert.match(prompt, /优先级：高/);
  assert.match(prompt, /截止日期：2026-11-18/);
  assert.match(prompt, /SSE 重连延迟/);
});

test('zenFocus shortcut detection, ambient clock formatting, and storage persistence work reliably', () => {
  assert.equal(
    isZenToggleShortcut({ key: '\\', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false }),
    true,
  );
  assert.equal(
    isZenToggleShortcut({ key: '\\', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, isComposing: false }),
    true,
  );
  assert.equal(
    isZenToggleShortcut({ key: '\\', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, isComposing: false }),
    false,
  );
  assert.equal(
    isZenToggleShortcut({ key: '\\', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: true }),
    false,
  );

  const clock = formatAmbientClock(new Date(2026, 10, 16, 7, 5, 9));
  assert.equal(clock.time, '07:05');
  assert.equal(clock.seconds, '09');
  assert.equal(clock.greeting, '破晓早安');
  assert.match(clock.dateLine, /11月16日/);

  const storage = createMemoryStorage();
  assert.equal(readZenFocusPreference(storage), false);
  assert.equal(saveZenFocusPreference(true, storage), true);
  assert.equal(storage.getItem(ZEN_FOCUS_STORAGE_KEY), '1');
  assert.equal(readZenFocusPreference(storage), true);
});

test('command-palette-pins & command-palette support :port live lookup, pinned ranking, and zen/showcase actions', () => {
  const storage = createMemoryStorage();
  let state = togglePinnedCommandId([], 'workspace:ports');
  assert.equal(state.pinned, true);
  assert.deepEqual(state.ids, ['workspace:ports']);

  state = togglePinnedCommandId(state.ids, 'action:toggle-zen');
  assert.deepEqual(state.ids, ['action:toggle-zen', 'workspace:ports']);
  writePinnedCommandIds(state.ids, storage);
  assert.ok(storage.getItem(COMMAND_PINS_STORAGE_KEY));
  assert.deepEqual(readPinnedCommandIds(storage), ['action:toggle-zen', 'workspace:ports']);

  // Unpinning removes cleanly
  const unpinned = togglePinnedCommandId(state.ids, 'workspace:ports');
  assert.equal(unpinned.pinned, false);
  assert.deepEqual(unpinned.ids, ['action:toggle-zen']);

  // Deduplication and max cap
  assert.deepEqual(normalizePinnedCommandIds(['a', 'b', 'a', '', 'c'], 2), ['a', 'b']);

  const mockPortSnapshot: PortSnapshot = {
    checkedAt: '2026-11-16T00:00:00.000Z',
    selfPort: 5288,
    summary: { listeningPorts: 2, processCount: 2, workspacePortCount: 2, externalPortCount: 0, multiProcessPortCount: 0 },
    projects: [],
    ports: [
      {
        port: 5288,
        status: 'listening',
        source: 'registered-and-live',
        registeredProjects: [],
        listeners: [
          {
            pid: 43210,
            port: 5288,
            protocol: 'TCP',
            address: '127.0.0.1:5288',
            process: 'node',
            command: 'node server/index.ts',
            cwd: '/Users/example/workspaces/delivery-workspace',
            project: { id: 'ws', name: 'Delivery Workspace', rootPath: '/Users/example/workspaces', workspacePath: '/Users/example/workspaces/delivery-workspace', branch: 'main', isWorktree: false },
            service: 'web',
            manager: 'pm2',
          },
        ],
      },
      {
        port: 8090,
        status: 'listening',
        source: 'live',
        registeredProjects: [],
        listeners: [
          {
            pid: 54321,
            port: 8090,
            protocol: 'TCP',
            address: '127.0.0.1:8090',
            process: 'go-gateway',
            command: './go-gateway',
            service: 'gateway-api',
            manager: 'standalone',
          },
        ],
      },
    ],
  };

  const portItems = buildPortCommandItems(mockPortSnapshot);
  assert.equal(portItems.length, 2);
  assert.equal(portItems[0]?.portNumber, 5288);
  assert.equal(portItems[0]?.active, true);

  const sections = registeredWorkspaceSections(['jira', 'local-projects', 'port-monitor']);
  const allItems = buildCommandPaletteItems({
    sections,
    currentViewId: 'today',
    isChatActive: false,
    chatMode: 'session',
    railCollapsed: false,
    zenFocusEnabled: false,
    currentThemeId: 'immersive-photo',
    ports: portItems,
  });

  // Zen and Showcase actions exist and > 群聊 still ranks new-group #1
  assert.ok(allItems.some(item => item.actionId === 'toggle-zen'));
  assert.ok(allItems.some(item => item.actionId === 'open-showcase'));
  assert.equal(filterCommandPaletteItems(allItems, '> 群聊')[0]?.actionId, 'new-group');

  // `:` prefix filters listening ports cleanly
  const portFiltered = filterCommandPaletteItems(allItems, ':8090');
  assert.equal(portFiltered.length, 1);
  assert.equal(portFiltered[0]?.portNumber, 8090);

  // Pinned items bubble to the very top of empty-query default view in exact pin order
  const defaultWithPins = filterCommandPaletteItems(
    allItems,
    '',
    'all',
    [],
    Date.now(),
    ['workspace:ports', 'port:8090'],
  );
  assert.equal(defaultWithPins[0]?.id, 'workspace:ports');
  assert.equal(defaultWithPins[0]?.pinned, true);
  assert.equal(defaultWithPins[1]?.id, 'port:8090');
  assert.equal(defaultWithPins[1]?.pinned, true);
});
