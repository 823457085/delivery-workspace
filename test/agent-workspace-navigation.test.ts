import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyExecutionPaths, workspaceLocation, workspaceSections, workspaceView, workspaceViews } from '../src/pages/agent/workspace-navigation';

test('所有工作入口可以定位且旧链接保留具体任务参数', () => {
  for (const section of workspaceSections) for (const view of section.items) {
    assert.equal(workspaceView(view.id)?.id, view.id);
    assert.equal(workspaceLocation(view.path)?.query.view, view.id);
  }
  assert.deepEqual(workspaceLocation('/delivery/queue', { job: 'job-1', view: 'old' }), { path: '/agent', query: { job: 'job-1', view: 'queue' } });
  assert.deepEqual(workspaceLocation('/deployments', { project: 'project-1' }), { path: '/agent', query: { project: 'project-1', view: 'deployments' } });
});
test('执行中心只有一个导航入口，旧计划与巡检直达链接定位到相应分栏', () => {
  const execution = workspaceSections.find(section => section.id === 'execution')!;
  assert.equal(execution.items.filter(item => item.id === 'queue').length, 1);
  assert.equal(workspaceViews.some(item => ['plan', 'runs'].includes(item.id)), false);
  assert.equal(workspaceView('queue')?.label, '执行中心');
  for (const [path, tab] of Object.entries(legacyExecutionPaths)) {
    assert.equal(workspaceViews.some(item => item.path === path), false);
    assert.strictEqual(workspaceView(tab), workspaceView('queue'));
    assert.deepEqual(workspaceLocation(path, { [tab === 'plan' ? 'plan' : 'run']: 'detail-1', view: 'old', executionTab: 'queue', q: 'APEX' }), {
      path: '/agent', query: { [tab === 'plan' ? 'plan' : 'run']: 'detail-1', view: 'queue', executionTab: tab, q: 'APEX' },
    });
  }
  assert.deepEqual(workspaceLocation('/delivery/queue', { executionTab: 'plan', plan: 'APEX-602' }), {
    path: '/agent', query: { executionTab: 'plan', plan: 'APEX-602', view: 'queue' },
  });
});
test('不接管其他页面或无效的面板值', () => {
  assert.equal(workspaceLocation('/lab'), undefined);
  assert.equal(workspaceLocation('/api/source/scan'), undefined);
  assert.equal(workspaceView(['tasks']), undefined);
  assert.equal(workspaceView('missing'), undefined);
});
