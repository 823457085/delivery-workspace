import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, shallowRef } from 'vue';
import { useAgentSidePanelTab } from '../src/features/agent-workbench/side-panel-state.js';

test('打开和切换会话默认显示记录，同会话刷新保留手动页签', async () => {
  const scope = effectScope();
  const conversation = shallowRef({ id: 'a', status: 'running' });
  const active = scope.run(() => useAgentSidePanelTab(() => conversation.value.id))!;
  try {
    assert.equal(active.value, 'execution');
    active.value = 'workflow';
    conversation.value = { id: 'a', status: 'completed' };
    await nextTick();
    assert.equal(active.value, 'workflow');
    conversation.value = { id: 'b', status: 'running' };
    await nextTick();
    assert.equal(active.value, 'execution');
    active.value = 'knowledge';
    conversation.value = { id: 'a', status: 'completed' };
    await nextTick();
    assert.equal(active.value, 'execution');
  } finally { scope.stop(); }
});
