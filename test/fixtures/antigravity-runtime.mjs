#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--version')) { console.log('Antigravity CLI 1.4.12'); process.exit(0); }
if (args.includes('--help')) { (name.startsWith('stderr-help') ? console.error : console.log)(name.startsWith('old-cli') ? '--print' : '--settings --input-format --output-format --conversation --disable-slash-commands --agent --add-dir'); process.exit(0); }
if (args[0] === 'models') { console.log('test-medium\tL_MODEL\ntest-high\tTest High'); process.exit(0); }
if (args.includes('-p')) {
  if (args.includes('--settings') && JSON.parse(value('--settings')).disableSlashCommands !== false) { console.error('status command expansion disabled'); process.exit(1); }
  if (name.startsWith('logged-out')) { console.error('authentication required private@example.invalid'); process.exit(1); }
  if (value('-p') === '/model') {
    if (name.startsWith('auth-health-network')) { console.error('ETIMEDOUT: model status request timed out'); process.exit(1); }
    if (name.startsWith('auth-health-unknown')) { console.error('status could not be read'); process.exit(1); }
    if (name.startsWith('auth-health-bad-json')) { console.log('invalid status payload'); process.exit(0); }
    await fs.appendFile(path.join(path.dirname(process.argv[1]), 'auth-probes.jsonl'), JSON.stringify({ args }) + '\n');
    if (name.startsWith('auth-probe-failed')) { console.error('authentication required'); process.exit(1); }
    if (name.startsWith('auth-probe-hang')) { setInterval(() => {}, 1000); await new Promise(() => {}); }
    console.log(JSON.stringify({ status: name.startsWith('auth-probe-error-status') ? 'ERROR' : 'SUCCESS',
      ...(!name.startsWith('auth-probe-missing-turns') ? { num_turns: name.startsWith('auth-probe-used-turns') ? 1 : 0 } : {}),
      command: { name: name.startsWith('auth-probe-wrong-command') ? 'usage' : 'model', data: { id: 'test-medium' } } })); process.exit(0);
  }
  if (value('-p') === '/hooks') {
    console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'hooks', data: { hooks: name.startsWith('active-hook') ? [{ enabled: true }]
      : name.startsWith('disabled-hook') ? [{ enabled: false }] : [] } } })); process.exit(0);
  }
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const content = JSON.parse(stdin).message.content;
let scenario = content.split('\n\n工作台执行目录：')[0];
const historyPath = path.join(process.cwd(), 'auth-invocations.jsonl');
const previous = await fs.readFile(historyPath, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)), () => []);
const recovering = previous[0]?.scenario?.startsWith('auth-recovery-') && !scenario.startsWith('auth-recovery-');
if (recovering) scenario = previous[0].scenario;
const directory = args.includes('--agent') ? args[args.lastIndexOf('--add-dir') + 1] : null;
const profile = directory ? await fs.readFile(path.join(directory, '.agents', 'agents', value('--agent') + '.md'), 'utf8') : null;
const invocation = { args, content, directory, profile, scenario, settings: JSON.parse(value('--settings')) };
await fs.appendFile(historyPath, JSON.stringify(invocation) + '\n');
await fs.writeFile('antigravity-fixture-started.json', JSON.stringify(invocation));
if (scenario === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
const session = args.includes('--conversation') ? value('--conversation') : 'antigravity-test-session';
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const step = (data, conversation_id = session) => emit({ event: 'step_update', step_update: { conversation_id, ...data } });
if (scenario === 'auth-failure-code') { emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } } }); process.exit(1); }
if (scenario === 'error-before-init') { emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'authentication required' } }); process.exit(1); }
emit({ event: 'init', conversation_id: session, init: { agent: scenario === 'wrong-agent' ? 'ambient-agent' : args.includes('--agent') ? value('--agent') : 'native-default', permission_mode: scenario === 'wrong-permission' ? 'always-proceed' : JSON.parse(value('--settings')).toolPermission } });
if (scenario.startsWith('auth-recovery-') && (!recovering || scenario === 'auth-recovery-repeat')) {
 const error = scenario === 'auth-recovery-code401' ? { code: 401, message: 'Request rejected' }
   : { code: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials' };
 if (scenario === 'auth-recovery-stderr') { process.stderr.write('UNAUTHENTICATED: Request had invalid authentication credentials\n'); process.exit(1); }
 emit({ event: 'result', result: { ...(scenario === 'auth-recovery-missing-id' ? {}
   : { conversation_id: scenario === 'auth-recovery-empty-id' ? '' : scenario === 'auth-recovery-different-id' ? 'different-session-id' : session }), status: 'ERROR', error,
   ...(scenario === 'auth-recovery-response' ? { response: '已有部分回复' } : {}) } }); process.exit(1);
}
if (scenario.startsWith('history-')) {
 const transcript = path.join(process.cwd(), 'native', session, '.system_generated', 'logs', 'transcript_full.jsonl');
 let baseline;
 try { baseline = await fs.readFile(transcript, 'utf8'); }
 catch { baseline = [
  { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'earlier request' },
  { step_index: 1, type: 'ERROR_MESSAGE', status: 'DONE', error: 'historical transport error' },
  { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'earlier response' },
 ].map(row => JSON.stringify(row) + '\n').join(''); }
 const previous = baseline.trimEnd().split('\n').map(line => JSON.parse(line));
 const first = previous.at(-1).step_index + 1;
 const nativeFixture = await fs.readFile(path.join(process.cwd(), 'history-fixture.json'), 'utf8').then(JSON.parse, () => undefined);
 const oldError = nativeFixture?.error || previous.findLast(row => row.type === 'ERROR_MESSAGE')?.error || 'historical transport error';
 const aggregate = scenario.startsWith('history-aggregate');
 let response = '恢复后本轮完成。';
 const streams = [
  { step_index: first, step_type: 'user_input', state: 'DONE' },
  { step_index: first + 1, step_type: 'system_message', state: 'DONE' },
  { step_index: first + 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/work/input.ts' } } },
  { step_index: first + 2, step_type: 'tool', state: 'DONE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/work/input.ts' } } },
  { step_index: first + 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: '恢复后' },
  { step_index: first + 3, step_type: 'agent_response', state: 'DONE', text_delta: '本轮完成。' },
 ];
 if (scenario === 'history-trailing-system') streams.push({ step_index: first + 4, step_type: 'system_message', state: 'DONE' });
 if (scenario === 'history-current-error') streams[1] = { step_index: first + 1, step_type: 'error_message', state: 'DONE', error: oldError };
 if (scenario === 'history-current-error-state') streams[1].state = 'ERROR';
 if (scenario === 'history-tool-error' || scenario === 'history-permission-error') streams[3].tool_info.error = {
  message: scenario === 'history-permission-error' ? 'permission check failed: Permission denied' : 'current tool failed',
 };
 if (scenario === 'history-user-active') streams[0].state = 'ACTIVE';
 if (scenario === 'history-second-user') streams[1].step_type = 'user_input';
 if (scenario === 'history-only-active') streams[5].state = 'ACTIVE';
 if (aggregate) {
  streams[1] = { step_index: first + 1, step_type: 'agent_response', state: 'DONE', text_delta: '已检查。\n' };
  streams[5].text_delta += '\n';
  response = '已检查。\n恢复后本轮完成。\n';
  if (scenario === 'history-aggregate-empty-last') {
   streams[4].text_delta = ''; streams[5].text_delta = ''; response = '已检查。\n';
  }
  if (scenario === 'history-aggregate-current-error') streams[3].tool_info.error = { message: 'current aggregate tool failed' };
 }
 for (const [index, update] of streams.entries()) {
  if (scenario === 'history-no-user-input' && index === 0 || scenario === 'history-index-gap' && index === 1
   || scenario === 'history-unfinished-tool' && index === 3) continue;
  step(update, scenario === 'history-session-mismatch' ? 'history-other-session' : session);
 }
 const current = [
  { step_index: first, type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${content}\n</USER_REQUEST>\nfixture metadata` },
  { step_index: first + 1, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'fixture metadata' },
  { step_index: first + 2, type: 'TOOL_CALL', status: 'DONE', content: 'read input' },
  { step_index: first + 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: '恢复后本轮完成。' },
 ];
 if (scenario === 'history-trailing-system') current.push({ step_index: first + 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'completion metadata' });
 if (aggregate) {
  current[1] = { step_index: first + 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '已检查。' };
  if (scenario === 'history-aggregate-native-mismatch') current[1].content = '不属于本轮的检查记录。';
  if (scenario === 'history-aggregate-empty-last') current[3].content = '';
 }
 if (scenario === 'history-input-mismatch') current[0].content = '<USER_REQUEST>\na different request\n</USER_REQUEST>';
 if (scenario === 'history-transcript-final-mismatch') current[3].content = '另一轮的回复。';
 if (scenario === 'history-transcript-second-user') current[1].type = 'USER_INPUT';
 if (scenario === 'history-transcript-error') current[1] = { step_index: first + 1, type: 'ERROR_MESSAGE', status: 'DONE', error: oldError };
 if (scenario === 'history-transcript-tool-error') current[2].error = 'current native tool failed';
 if (scenario === 'history-transcript-active') current[2].status = 'ACTIVE';
 if (scenario === 'history-transcript-index-gap') current[2].step_index++;
 if (scenario.startsWith('history-sqlite-')) {
  const db = new DatabaseSync(path.join(process.cwd(), 'conversations', `${session}.db`));
  try {
   const types = { USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17, SYSTEM_MESSAGE: 101, TOOL_CALL: 132 };
   const insert = db.prepare('INSERT INTO steps VALUES(?, ?, ?, ?, ?)');
   for (const row of current) {
    if (scenario === 'history-sqlite-missing-current-row' && row.step_index === first + 2) continue;
    const failed = scenario === 'history-sqlite-current-error' && row.step_index === first + 1;
    insert.run(row.step_index, failed ? 17 : types[row.type], 3, failed ? Buffer.from('current error details') : null, Buffer.from(row.content));
   }
   if (scenario === 'history-sqlite-history-changed') db.prepare('UPDATE steps SET step_payload=? WHERE idx=0').run(Buffer.from('changed historical request'));
  } finally { db.close(); }
 }
 await fs.mkdir(path.dirname(transcript), { recursive: true });
 let finalTranscript = baseline + current.map(row => JSON.stringify(row) + '\n').join('');
 if (scenario === 'history-transcript-prefix-replaced') finalTranscript = baseline.replace('earlier request', 'changed request') + current.map(row => JSON.stringify(row) + '\n').join('');
 if (scenario === 'history-transcript-truncated') finalTranscript = baseline.slice(0, Math.floor(baseline.length / 2));
 if (scenario === 'history-transcript-partial-line') finalTranscript = finalTranscript.trimEnd();
 await fs.writeFile(transcript, finalTranscript);
 if (scenario === 'history-transcript-missing') await fs.unlink(transcript);
 const result = { event: 'result', result: { conversation_id: session, status: scenario === 'history-success' ? 'SUCCESS' : 'ERROR',
  response: scenario === 'history-final-mismatch' ? '结果与本轮回复不同。' : scenario === 'history-output-final-whitespace' ? response + '\n' : response,
  error: scenario === 'history-different-error' ? 'a different transport error' : oldError } };
 emit(result);
 if (scenario === 'history-step-after-result') step({ step_index: first + 4, step_type: 'system_message', state: 'DONE' });
 if (scenario === 'history-duplicate-result') emit(result);
 if (scenario === 'history-hang' || scenario === 'history-wait-for-abort') {
  await fs.writeFile('antigravity-fixture-result-emitted', 'result emitted');
  setInterval(() => {}, 1000); await new Promise(() => {});
 }
 if (scenario === 'history-cleanup-delay') await new Promise(resolve => setTimeout(resolve, 6000));
 process.exit(scenario === 'history-exit2' ? 2 : 0);
}
const failureMessages = {
 'quota-rate-limit': { code: 429, message: 'Too many requests: rate limit exceeded' },
 'quota-number-only': { code: 429 },
 'quota-rate-with-quota-code': { code: 'QUOTA_EXCEEDED', message: 'Rate limit exceeded: retry after 1s' },
 'quota-exceeded-code-only': { code: 'QUOTA_EXCEEDED', message: 'Request rejected' },
 'quota-resource-exhausted': { code: 'RESOURCE_EXHAUSTED', message: 'Server temporarily has no capacity' },
 'quota-unknown': { code: 'QUOTA_SERVICE_ERROR', message: 'Quota lookup unavailable' },
 'quota-credit-file': { code: 'INTERNAL', message: 'Cannot parse credit-report.ts' },
 'quota-network': { code: 'UNAVAILABLE', message: 'quota service ETIMEDOUT' },
 'quota-permission': { code: 'PERMISSION_DENIED', message: 'credit-report.ts permission denied' },
 'quota-exhausted': { code: 'QUOTA_EXCEEDED', message: 'Weekly quota exhausted' },
 'quota-credit-balance': { code: 'INSUFFICIENT_CREDITS', message: 'Credit balance is insufficient' },
 'author-file-failure': 'ENOENT: unable to read /work/author.ts',
 'authorization-file-failure': 'ENOENT: unable to read /work/authorization.ts',
 'credential-path-failure': 'failed to open credential-config.json',
 'network-failure': { code: 'ETIMEDOUT', message: 'request timed out' },
};
if (scenario in failureMessages) {
 emit({ event: 'result', result: { conversation_id: session, status: 'ERROR', error: failureMessages[scenario] } }); process.exit(1);
}
if (scenario === 'success-then-empty-auth' || scenario === 'success-then-missing-auth') {
 emit({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '已完成回复' } });
 emit({ event: 'result', result: { ...(scenario === 'success-then-empty-auth' ? { conversation_id: '' } : {}),
   status: 'ERROR', error: { code: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials' } } }); process.exit(1);
}
if (scenario === 'exit-auth-noise' || scenario === 'success-exit-auth-noise') {
 process.stderr.write('Auth succeeded; reading authorization.ts\n');
 if (scenario === 'success-exit-auth-noise') emit({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '已完成回复' } });
 process.exit(2);
}
if (scenario === 'rich-progress') {
 step({ step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: '准备检查\n' });
 step({ step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: '' });
 step({ step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: '准备检查\n' });
 step({ step_index: 2, step_type: 'thinking', state: 'DONE', text_delta: 'PRIVATE_THINKING' });
 const tool = { step_index: 3, step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test -- --runInBand' }, output: 'PRIVATE_RAW_TOOL_BYTES' } };
 step({ ...tool, state: 'ACTIVE' }); step({ ...tool, state: 'ACTIVE' });
 step({ ...tool, state: 'DONE' }); step({ ...tool, state: 'DONE' });
 step({ step_index: 4, step_type: 'agent_response', state: 'DONE', text_delta: '检查完成\n' });
 emit({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: '准备检查\n检查完成\n' } }); process.exit(0);
}
if (scenario === 'tool-error') {
 step({ step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/work/missing.ts' } } });
 step({ step_index: 1, step_type: 'tool', state: 'ERROR', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/work/missing.ts' }, error: { message: 'PRIVATE_DIAGNOSTIC missing file' } } });
}
if (['tool-read-permission', 'tool-history-skill-permission', 'tool-command-permission', 'tool-long-read-permission'].includes(scenario)) {
 const command = scenario === 'tool-command-permission';
 const target = scenario === 'tool-history-skill-permission' ? '/outside/old-verification/.agents/skills/vue-best-practices/SKILL.md'
   : scenario === 'tool-long-read-permission' ? '/outside/' + 'segment/'.repeat(45) + 'HEAD'
     : '/outside/repository/.git/worktrees/workspace4/HEAD';
 const parameters = command ? { CommandLine: 'curl -H "Authorization: Bearer PRIVATE_COMMAND_TOKEN" https://example.invalid' }
   : { AbsolutePath: target };
 step({ step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: command ? 'run_command' : 'view_file', tool_info: { parameters } });
 step({ step_index: 1, step_type: 'tool', state: 'ERROR', tool_name: command ? 'run_command' : 'view_file', tool_info: {
   ...(scenario === 'tool-history-skill-permission' ? { parameters } : {}),
   output: 'PRIVATE_RAW_TOOL_OUTPUT', error: { type: 'TOOL_ERROR', message: 'permission check failed: Permission denied PRIVATE_ERROR_TOKEN',
     headers: { Authorization: 'Bearer PRIVATE_ERROR_HEADER' } },
 } });
}
if (scenario === 'mismatch') step({ step_type: 'agent_response', text_delta: 'wrong' }, 'different-session-id');
if (scenario === 'tool-permission') step({ step_type: 'tool', step_index: 1, state: 'ERROR', tool_name: 'write_file', tool_info: { error: { type: 'TOOL_ERROR', message: 'permission check failed: Permission denied' } } });
if (scenario === 'stderr-permission') process.stderr.write('Tool permission denied in headless mode\n');
if (scenario === 'large-image-event') step({ step_type: 'tool', step_index: 1, tool_name: 'read_file', tool_info: { output: 'x'.repeat(3_000_000) } });
if (scenario === 'oversized-event') process.stdout.write(JSON.stringify({ event: 'unknown', data: 'x'.repeat(34 * 1024 * 1024) }) + '\n');
if (scenario === 'oversized-text') step({ step_type: 'agent_response', text_delta: 'x'.repeat(2_000_001) });
step({ step_type: 'agent_response', state: 'ACTIVE', text_delta: '你好' });
step({ step_type: 'agent_response', state: 'DONE', text_delta: ' Antigravity' });
if (scenario !== 'missing-finish') {
 const result = { event: 'result', result: { conversation_id: session, status: scenario === 'non-success' ? 'WAITING' : 'SUCCESS',
   response: scenario === 'empty-final' ? '' : scenario === 'oversized-final' ? 'x'.repeat(2_000_001) : '你好 Antigravity',
   usage: { input_tokens: 99, output_tokens: 7 }, num_turns: 3 } };
 process.stdout.write(JSON.stringify(result));
 if (scenario === 'duplicate-final') { process.stdout.write('\n'); emit(result); }
}
