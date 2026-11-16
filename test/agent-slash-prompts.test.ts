import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, ref } from 'vue';
import type { AgentRunMode } from '../shared/agent-runtime.js';
import {
  CUSTOM_SLASH_PROMPTS_KEY,
  extractSlashTrigger,
  readCustomSlashPrompts,
  useAgentSlashPrompts,
} from '../src/features/agent-workbench/useAgentSlashPrompts.js';

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

test('extractSlashTrigger 仅匹配行首或消息开头的斜杠，不误触发 URL 或文件路径', () => {
  assert.deepEqual(extractSlashTrigger('/'), { prefix: '', query: '' });
  assert.deepEqual(extractSlashTrigger('/检查'), { prefix: '', query: '检查' });
  assert.deepEqual(extractSlashTrigger('先交代背景\n/出方'), { prefix: '\n', query: '出方' });
  assert.equal(extractSlashTrigger('http://127.0.0.1:5288/api'), undefined);
  assert.equal(extractSlashTrigger('请检查 src/features/foo.ts'), undefined);
  assert.equal(extractSlashTrigger('/检查改动 后面继续打字'), undefined);
});

test('useAgentSlashPrompts 支持过滤内置指令、自动建议运行模式并保存/删除个人常用指令', async () => {
  const storage = createMemoryStorage();
  const draft = ref('');
  const selectedModes: AgentRunMode[] = [];
  const scope = effectScope();

  await scope.run(async () => {
    const slash = useAgentSlashPrompts(
      draft,
      () => ({ modes: ['agent', 'plan', 'ask'], modeLocked: false }),
      () => false,
      mode => selectedModes.push(mode),
      storage,
    );

    assert.equal(slash.open.value, false);

    draft.value = '/出方案';
    await nextTick();
    assert.equal(slash.open.value, true);
    assert.equal(slash.options.value[0]?.command, '出方案');

    slash.select(slash.options.value[0]!);
    await nextTick();
    assert.equal(slash.open.value, false);
    assert.ok(draft.value.includes('先不要改代码'));
    assert.deepEqual(selectedModes, ['plan']);

    draft.value = '请按团队规范核对接口返回结构与错误码映射';
    await nextTick();
    assert.equal(slash.canSaveDraft.value, true);
    const saved = slash.saveCurrentAsCustom('查接口规范');
    assert.ok(saved);
    assert.equal(saved.label, '/查接口规范');
    assert.equal(readCustomSlashPrompts(storage).length, 1);
    assert.ok(storage.getItem(CUSTOM_SLASH_PROMPTS_KEY)?.includes('查接口规范'));

    draft.value = '/查接口';
    await nextTick();
    assert.equal(slash.open.value, true);
    assert.equal(slash.options.value[0]?.id, saved.id);

    slash.removeCustomPrompt(saved.id);
    assert.equal(readCustomSlashPrompts(storage).length, 0);
  });

  scope.stop();
});
