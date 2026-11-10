import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareAntigravityAgentProfile } from '../server/antigravity-agent-profile.js';

test('Antigravity agent profiles are private, independently named, and disable inherited MCP and hooks', async t => {
  const first = await prepareAntigravityAgentProfile({ mode: 'ask', accessMode: 'workspace' });
  const second = await prepareAntigravityAgentProfile({ mode: 'agent', accessMode: 'full' });
  t.after(async () => { await first.cleanup(); await second.cleanup(); });
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.name, second.name);
  for (const profile of [first, second]) {
    assert.match(profile.name, /^delivery-[0-9a-f-]{36}$/);
    assert.equal(path.isAbsolute(profile.directory), true);
    const file = path.join(profile.directory, '.agents', 'agents', `${profile.name}.md`);
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /^inheritMcp: false$/m);
    assert.match(source, /^inheritCustomizations: false$/m);
    assert.match(source, /^mainAgent: true$/m);
    assert.match(source, /^subagent: false$/m);
    assert.match(source, /^commandExecutionPolicy: eager$/m);
    assert.match(source, /^  - view_file$/m);
    assert.match(source, /^  - write_to_file$/m);
    assert.match(source, /^  - run_command$/m);
    assert.match(source, /^  - command_status$/m);
    assert.match(source, /^  - send_command_input$/m);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(profile.directory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  }
  await first.cleanup();
  await first.cleanup();
  await assert.rejects(fs.access(first.directory), { code: 'ENOENT' });
  assert.equal((await fs.stat(second.directory)).isDirectory(), true, '清理只移除本轮临时 Agent 配置');
});

test('Antigravity native conversations retain the same capabilities across mode and access changes', async () => {
  let initialTools = '';
  for (const run of [{ mode: 'ask', accessMode: 'workspace' }, { mode: 'plan', accessMode: 'workspace' },
    { mode: 'agent', accessMode: 'workspace' }, { mode: 'agent', accessMode: 'full' }] as const) {
    const profile = await prepareAntigravityAgentProfile(run);
    try {
      const source = await fs.readFile(path.join(profile.directory, '.agents', 'agents', `${profile.name}.md`), 'utf8');
      const policy = run.mode === 'agent' && run.accessMode === 'workspace' ? 'sandbox' : 'eager';
      assert.match(source, new RegExp(`^commandExecutionPolicy: ${policy}$`, 'm'));
      assert.match(source, /^inheritMcp: false$/m);
      assert.match(source, /^inheritCustomizations: false$/m);
      const tools = source.split('\n').filter(line => line.startsWith('  - ')).join('\n');
      if (!initialTools) initialTools = tools;
      assert.equal(tools, initialTools, '切换模式不能留下原生会话首轮固定的工具缺失');
      assert.match(source, /^  - write_to_file$/m);
      assert.match(source, /^  - run_command$/m);
    } finally { await profile.cleanup(); }
  }
});
