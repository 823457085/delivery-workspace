import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GroupRoomSummary } from '../shared/agent-group-chat.js';
import type { LocalProject, ProjectsData } from '../shared/hub.js';
import { GROUP_SIDEBAR_STORAGE_KEY, groupRoomSections, readGroupSidebarPreferences, saveGroupSidebarPreferences } from '../src/features/agent-workbench/group-room-sidebar.js';

function room(id: string, workspacePath = '', createdAt = '2026-11-01T09:00:00Z', workspacePaths?: string[]): GroupRoomSummary {
  return { id, title: id, workspacePath, workspacePaths, paused: false, createdAt, updatedAt: createdAt, state: 'idle' };
}
function project(projectId: string, path: string, fields: Partial<LocalProject> = {}): LocalProject {
  return { projectId, projectName: projectId, displayName: '', suggestedDisplayName: '', repository: '', path, displayPath: path,
    relativePath: '', rootPath: '', rootLabel: '', folderName: '', branch: '', upstream: '', clean: true, changed: 0, staged: 0,
    modified: 0, untracked: 0, detached: false, ahead: 0, behind: 0, webUrl: '', remoteUrl: '', ...fields };
}
const data = (projects: LocalProject[]): ProjectsData => ({ projects, roots: [], directoryCount: projects.length,
  durationMs: 0, limited: false, unreadableCount: 0 });

test('置顶单独置前且项目组不重复，取消置顶返回项目；旧群聊始终保留', () => {
  const rooms = [room('new', '/work/app', '2026-11-05T09:00:00Z'), room('old', '/work/app', '2025-01-01T09:00:00Z'), room('other', '/work/api')];
  const pinned = groupRoomSections(rooms, new Set(['old']));
  assert.equal(pinned[0].id, 'pinned');
  assert.equal(pinned[0].pinned, true);
  assert.deepEqual(pinned[0].rooms.map(item => item.id), ['old']);
  assert.deepEqual(pinned.slice(1).flatMap(section => section.rooms.map(item => item.id)), ['new', 'other']);
  assert.equal(pinned.flatMap(section => section.rooms).length, rooms.length);
  const unpinned = groupRoomSections(rooms, new Set());
  assert(!unpinned.some(section => section.pinned));
  assert.deepEqual(unpinned.find(section => section.path === '/work/app')?.rooms.map(item => item.id), ['new', 'old']);
});

test('项目身份合并已登记的不同目录，同名不同项目仍各自分组，名称按配置优先', () => {
  const projects = data([project('app-id', '/work/app', { displayName: '管理端', suggestedDisplayName: '建议名' }),
    project('app-id', '/work/app-feature', { projectName: '实现副本' }),
    project('other-id', '/different/app', { displayName: '管理端' }),
    project('suggested-id', '/work/service', { suggestedDisplayName: '服务端', projectName: '原名' })]);
  const sections = groupRoomSections([room('one', '/work/app'), room('two', '/work/app-feature'), room('three', '/different/app'), room('four', '/work/service')], new Set(), projects);
  const app = sections.find(section => section.id === 'project:app-id')!;
  assert.equal(app.label, '管理端');
  assert.deepEqual(app.rooms.map(item => item.id), ['one', 'two']);
  assert.equal(sections.find(section => section.id === 'project:other-id')?.label, '管理端');
  assert.equal(sections.find(section => section.id === 'project:suggested-id')?.label, '服务端');
  assert.equal(sections.length, 3);
});

test('未登记路径仅按路径分组，显示workspacePathLabel，不猜worktree所属项目', () => {
  const projects = data([project('known', '/work/app', { displayName: '应用' })]);
  const sections = groupRoomSections([room('known', '/work/app'), room('clone', '/work/app/.worktrees/feature'),
    room('same-leaf', '/other/feature'), room('admin', '/work/merchant/admin')], new Set(), projects);
  assert.equal(sections.length, 4);
  assert.equal(sections.find(section => section.id === 'workspace:/work/app/.worktrees/feature')?.label, 'feature');
  assert.equal(sections.find(section => section.id === 'workspace:/work/merchant/admin')?.label, 'merchant / admin');
  assert.equal(sections.find(section => section.id === 'project:known')?.rooms.length, 1);
});

test('多项目组合按身份去重和排序，目录顺序与重复项不造成群聊丢失或重复', () => {
  const projects = data([project('a', '/work/app', { displayName: '应用' }), project('a', '/work/app-copy'), project('b', '/work/api', { displayName: '接口' })]);
  const rooms = [room('first', '/work/app', undefined, ['/work/app/', '/work/api', '/work/app-copy', '/work/app']),
    room('second', '/work/api', undefined, ['/work/api/', '/work/app']), room('same-project', '/work/app', undefined, ['/work/app', '/work/app-copy'])];
  const sections = groupRoomSections(rooms, new Set(), projects);
  const combination = sections.find(section => section.id.startsWith('projects:'))!;
  assert.equal(combination.label, '应用 + 接口');
  assert.deepEqual(combination.rooms.map(item => item.id), ['first', 'second']);
  assert.deepEqual(sections.find(section => section.id === 'project:a')?.rooms.map(item => item.id), ['same-project']);
  assert.deepEqual(sections.flatMap(section => section.rooms.map(item => item.id)).sort(), rooms.map(item => item.id).sort());
  assert.equal(groupRoomSections([rooms[1], rooms[0]], new Set(), data([...projects.projects].reverse()))[0].id, combination.id);
});

test('未指定目录和空多目录安全归组，路径拼写归一不推断大小写或父目录', () => {
  const sections = groupRoomSections([room('empty'), room('whitespace', '  ', undefined, [' ', '']),
    room('fallback', '/work/fallback', undefined, ['', ' ']), room('windows', 'C:\\work\\app\\'), room('slash', 'C:/work/app'),
    room('case-sensitive', 'C:/work/App')], new Set());
  assert.deepEqual(sections.find(section => section.id === 'unassigned')?.rooms.map(item => item.id), ['empty', 'whitespace']);
  assert.equal(sections.find(section => section.id === 'unassigned')?.label, '未指定工作区');
  assert.equal(sections.find(section => section.id === 'workspace:/work/fallback')?.rooms[0].id, 'fallback');
  assert.deepEqual(sections.find(section => section.id === 'workspace:C:/work/app')?.rooms.map(item => item.id), ['slash', 'windows']);
  assert.equal(sections.find(section => section.id === 'workspace:C:/work/App')?.rooms.length, 1);
});

test('保留群聊最近更新优先，同时间按ID排序，不修改输入数组', () => {
  const rooms = [room('z', '/work/same', '2026-11-03T09:00:00Z'), room('a', '/work/same', '2026-11-03T09:00:00Z'),
    room('new', '/work/new', '2026-11-05T09:00:00Z'), room('invalid', '/work/same', 'invalid')];
  const before = JSON.stringify(rooms);
  const sections = groupRoomSections(rooms, new Set());
  assert.equal(sections[0].path, '/work/new');
  assert.deepEqual(sections[1].rooms.map(item => item.id), ['a', 'z', 'invalid']);
  assert.equal(JSON.stringify(rooms), before);
  const changed = groupRoomSections(rooms.map((item, index) => ({ ...item, updatedAt: `2027-12-0${index + 1}T09:00:00Z` })).reverse(), new Set());
  assert.equal(changed[0].path, '/work/same');
  assert.deepEqual(changed[0].rooms.map(item => item.id), ['invalid', 'a', 'z']);
  assert.equal(changed[1].rooms[0].id, 'new');
});

test('置顶与折叠偏好只使用独立存储键，取消置顶可持久化，不污染普通会话偏好', () => {
  const entries = new Map([['delivery-workspace.agent-pins.v1', '["ordinary"]'], ['delivery-workspace.theme.v1', 'obsidian']]);
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  assert.deepEqual(readGroupSidebarPreferences(storage), { pinnedIds: new Set(), collapsedIds: new Set() });
  const preferences = { pinnedIds: new Set(['one', 'two']), collapsedIds: new Set(['project:app']) };
  assert.equal(saveGroupSidebarPreferences(storage, preferences), true);
  assert.equal(entries.has(GROUP_SIDEBAR_STORAGE_KEY), true);
  assert.deepEqual(readGroupSidebarPreferences(storage), preferences);
  preferences.pinnedIds.delete('one');
  assert.equal(saveGroupSidebarPreferences(storage, preferences), true);
  assert.deepEqual(readGroupSidebarPreferences(storage).pinnedIds, new Set(['two']));
  assert.equal(entries.get('delivery-workspace.agent-pins.v1'), '["ordinary"]');
  assert.equal(entries.get('delivery-workspace.theme.v1'), 'obsidian');
});

test('损坏、无权限和混合类型存储安全回退，每次读取返回独立Set', () => {
  for (const value of [null, 'invalid', '[]', 'null', '1']) {
    assert.deepEqual(readGroupSidebarPreferences({ getItem: () => value }), { pinnedIds: new Set(), collapsedIds: new Set() });
  }
  const parsed = readGroupSidebarPreferences({ getItem: () => JSON.stringify({ pinnedIds: ['one', '', ' ', 3, null, 'one'], collapsedIds: 'wrong' }) });
  assert.deepEqual(parsed, { pinnedIds: new Set(['one']), collapsedIds: new Set() });
  const denied = { getItem(): string { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const first = readGroupSidebarPreferences(denied); first.pinnedIds.add('local');
  assert.equal(readGroupSidebarPreferences(denied).pinnedIds.size, 0);
  assert.equal(saveGroupSidebarPreferences(denied, first), false);
});
