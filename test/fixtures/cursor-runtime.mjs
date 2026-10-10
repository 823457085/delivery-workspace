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
output({ type: 'assistant', message: { content: [{ type: 'text', text: prompt }] } });
if (prompt.includes('hold-open')) setInterval(() => {}, 1000);
