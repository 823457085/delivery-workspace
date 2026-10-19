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

test('并排布局从成果开始，数据刷新保留页签，切换会话或布局重新选择默认页签', async () => {
  const scope = effectScope();
  const conversation = shallowRef({ id: 'a', status: 'running' });
  const split = shallowRef(true);
  const active = scope.run(() => useAgentSidePanelTab(() => conversation.value.id, () => split.value ? 'result' : 'execution'))!;
  try {
    assert.equal(active.value, 'result');
    active.value = 'knowledge';
    conversation.value = { id: 'a', status: 'completed' };
    await nextTick();
    assert.equal(active.value, 'knowledge');
    conversation.value = { id: 'b', status: 'completed' };
    await nextTick();
    assert.equal(active.value, 'result');
    active.value = 'workflow';
    split.value = false;
    await nextTick();
    assert.equal(active.value, 'execution');
    split.value = true;
    await nextTick();
    assert.equal(active.value, 'result');
  } finally { scope.stop(); }
});
