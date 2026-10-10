import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, shallowRef } from 'vue';
import { useKnowledgeCatalog } from '../src/features/agent-workbench/useKnowledgeCatalog.js';
import type { AgentSkillOption } from '../shared/agent-runtime.js';

test('知识分类分页覆盖全部结果，来源/目录筛选及查询切换重置页码', async () => {
  const scope = effectScope();
  const workspace = shallowRef('/project');
  const skills = shallowRef<AgentSkillOption[]>(Array.from({ length: 29 }, (_, i) => ({ name: `skill-${i}`, invocation: `skill-${i}`, description: 'description', source: i < 3 ? 'project' : 'personal', sourceLabel: '来源' })));
  const data = { skills, files: shallowRef(['src/a.vue', 'src/b.vue', 'README.md']), matches: shallowRef([{ path: 'src/a.vue', line: 12, excerpt: 'hit' }]), search: shallowRef(''), scope: shallowRef({ workspacePath: '/project', branch: 'main', headSha: 'abc' }) };
  const catalog = scope.run(() => useKnowledgeCatalog(data, () => workspace.value))!;
  try {
    assert.equal(catalog.pages.value, 3);
    assert.equal(catalog.visible.value.length, 12);
    catalog.page.value = 3;
    assert.equal(catalog.visible.value.at(-1)?.title, 'skill-28');
    catalog.source.value = 'project'; await nextTick();
    assert.equal(catalog.page.value, 1);
    assert.equal(catalog.entries.value.length, 3);
    assert.match(catalog.visible.value[0].prompt, /^\$skill-0/);
    catalog.tab.value = 'files'; catalog.directory.value = 'src'; await nextTick();
    assert.deepEqual(catalog.visible.value.map(item => item.title), ['a.vue', 'b.vue']);
    assert.match(catalog.visible.value[0].prompt, /@src\/a.vue/);
    data.search.value = 'README'; await nextTick(); assert.equal(catalog.directory.value, '');
    catalog.tab.value = 'matches'; await nextTick();
    assert.match(catalog.visible.value[0].prompt, /第 12 行/);
    workspace.value = '/other'; await nextTick(); assert.equal(catalog.source.value, '');
  } finally { scope.stop(); }
});
