#!/usr/bin/env node
// Local CLI peer: echo the received prompt; hold a run for virtual-time/abort checks.
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const prompt = process.argv.at(-1);
if (prompt.includes('require-workspace-trust') && !process.argv.includes('--trust')) {
  process.stderr.write('Workspace Trust Required: Do you trust the contents of this directory?');
  process.exit(1);
}
if (prompt.includes('require-workspace-trust') && (process.argv.includes('--force') || process.argv.includes('--approve-mcps') || !process.argv.includes('enabled'))) {
  throw new Error('Workspace trust must not expand permissions');
}
output({ type: 'system', session_id: 'cursor-fixture' });
if (prompt.includes('progress-events')) {
  output({ type: 'user', message: { content: [{ type: 'text', text: '不应显示的用户回显' }] } });
  output({ type: 'thinking', subtype: 'delta', text: '区' });
  output({ type: 'thinking', subtype: 'delta', text: '间。' });
  output({ type: 'thinking', subtype: 'completed' });
  output({ type: 'assistant', message: { content: [
    { type: 'thinking', text: '不应显示的内部文本' },
    { type: 'text', text: '正在核对旧版本，确认变更范围。' },
  ] } });
  output({ type: 'tool_call', text: '不应显示为回复的工具文本' });
  output({ type: 'assistant', message: { content: [{ type: 'text', text: '核对完成，已确认变更范围。' }] } });
  output({ type: 'thinking', subtype: 'delta', text: '不应覆盖完整回复的片段' });
  if (!prompt.includes('no-result')) output({ type: 'result', result: '已完成本轮核对。' });
  process.exit(0);
}
output({ type: 'assistant', message: { content: [{ type: 'text', text: prompt }] } });
if (prompt.includes('hold-open')) setInterval(() => {}, 1000);
