#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const variant = path.basename(process.argv[1]);
if (args[0] === '--version') { console.log('kiro-cli 2.37.0'); process.exit(0); }
if (args[0] === 'whoami') {
  if (variant.startsWith('logged-out')) process.exit(1);
  console.log(JSON.stringify({ accountType: 'BuilderId', provider: 'fixture', email: 'private@example.invalid' })); process.exit(0);
}
if (args.includes('--help')) {
  console.log(variant.startsWith('old-cli') ? 'old help' : '--v2 --output-format --resume-id --trust-tools'); process.exit(0);
}
if (args.includes('--list-models')) {
  console.log(JSON.stringify({ models: [{ model_id: 'auto', model_name: 'Auto' }, { model_id: 'test-model', model_name: 'Test model' }], default_model: 'auto' })); process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const directory = args.includes('--agent') ? process.env.KIRO_AGENT_CONFIG_DIR : null;
const profile = directory ? JSON.parse(await fs.readFile(path.join(directory, 'delivery-workbench.json'), 'utf8')) : null;
const marker = path.join(process.cwd(), 'kiro-fixture-started.json');
await fs.writeFile(`${marker}.tmp`, JSON.stringify({ args, prompt, directory, profile }));
await fs.rename(`${marker}.tmp`, marker);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const sessionId = args.includes('--resume-id') ? args[args.indexOf('--resume-id') + 1] : 'kiro-session-1234';
emit({ type: 'runStarted', data: { engine: 'v2' } });
emit({ type: 'metadata', data: { sessionId: prompt === 'mismatch' ? 'kiro-wrong-session' : sessionId } });
const scenario = prompt.split('\n')[0];
if (scenario === 'large-image-event') {
  emit({ type: 'sessionUpdate', data: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'image-read-1',
    kind: 'read', title: '读取图片', rawInput: { operations: [{ mode: 'Image', image_paths: ['fixture.png'] }] } } } });
  emit({ type: 'sessionUpdate', data: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'image-read-1',
    status: 'completed', rawOutput: { items: [{ Image: { format: 'png', source: { kind: 'bytes', data: Array(600_000).fill(255) } } }] } } } });
}
if (scenario === 'oversized-image-event') {
  emit({ type: 'sessionUpdate', data: { sessionId, update: { sessionUpdate: 'tool_call_update', status: 'completed',
    rawOutput: { items: [{ Image: { format: 'png', source: { kind: 'bytes', data: Array(8_400_000).fill(255) } } }] } } } });
}
if (scenario === 'oversized-text') emit({ type: 'sessionUpdate', data: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(2_000_001) } } } });
if (prompt === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (prompt === 'error') { emit({ type: 'runError', data: { sessionId, message: 'quota exceeded' } }); process.exit(0); }
if (prompt === 'missing-finish') process.exit(0);
emit({ type: 'sessionUpdate', data: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning must not appear' } } } });
for (const text of ['你好', ' Kiro']) emit({ type: 'sessionUpdate', data: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
if (prompt === 'permission') emit({ type: 'sessionUpdate', data: { sessionId,
  update: { sessionUpdate: 'tool_call_update', status: 'failed', _meta: { kiro: { toolCallFailureReason: 'permission_denied' } } } } });
const final = { type: 'runFinished', data: { sessionId, status: 'success', stopReason: 'end_turn', finalText: '你好 Kiro', finalTextTruncated: false } };
if (scenario === 'oversized-final-text') final.data.finalText = 'x'.repeat(2_000_001);
if (prompt === 'non-success') final.data.status = 'failed';
if (prompt === 'non-end-turn') final.data.stopReason = 'cancelled';
process.stdout.write(JSON.stringify(final));
