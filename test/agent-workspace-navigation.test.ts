import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceLocation, workspaceSections, workspaceView } from '../src/pages/agent/workspace-navigation';

test('所有工作入口可以定位且旧链接保留具体任务参数', () => {
  for (const section of workspaceSections) for (const view of section.items) {
    assert.equal(workspaceView(view.id)?.id, view.id);
    assert.equal(workspaceLocation(view.path)?.query.view, view.id);
  }
  assert.deepEqual(workspaceLocation('/delivery/queue', { job: 'job-1', view: 'old' }), { path: '/agent', query: { job: 'job-1', view: 'queue' } });
  assert.deepEqual(workspaceLocation('/catchup/merge', { requirement: 'REQ-1' }), { path: '/agent', query: { requirement: 'REQ-1', view: 'merge' } });
});
test('不接管其他页面或无效的面板值', () => {
  assert.equal(workspaceLocation('/lab'), undefined);
  assert.equal(workspaceLocation('/api/source/scan'), undefined);
  assert.equal(workspaceView(['tasks']), undefined);
  assert.equal(workspaceView('missing'), undefined);
});
