#!/usr/bin/env node
// Local protocol peer; never contacts Claude or reads account credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const variant = path.basename(process.argv[1]);
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args.includes('--version')) {
  process.stdout.write('2.1.81 (Claude Code fixture)\n');
} else if (args[0] === 'auth') {
  output({ loggedIn: !variant.includes('logged-out'), authMethod: 'claude.ai', apiProvider: 'firstParty' });
} else if (args.includes('--help')) {
  process.stdout.write(variant.includes('old-cli') ? '--output-format' : '--restricted --safe-mode --permission-prompts --strict-mcp-config'
    + (variant.includes('workspace-only') ? '' : ' --permission-mode bypassPermissions'));
} else if (args.includes('--no-session-persistence')) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.type !== 'control_request' || request.request?.subtype !== 'initialize') process.exit(9);
    if (args[args.indexOf('--tools') + 1] !== '' || !JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks) process.exit(10);
    if (variant.includes('catalog-exit')) process.exit(0);
    if (variant.includes('catalog-timeout')) continue;
    output({ type: 'control_response', response: { request_id: request.request_id,
      subtype: variant.includes('catalog-error') ? 'error' : 'success', response: {
        account: { private: 'must-not-be-exposed' },
        models: variant.includes('catalog-empty') ? [] : [
          { value: 'default', displayName: 'Default (recommended)' },
          { value: 'opus', displayName: 'Opus fixture-version', resolvedModel: 'claude-opus-fixture',
            supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { value: 'custom-model', displayName: 'L123456' },
        ],
      } } });
  }
} else {
  fs.writeFileSync('claude-fixture-started.json', JSON.stringify({ pid: process.pid, args }));
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const messages = stdin.trim().split('\n').map(line => JSON.parse(line));
  if (messages.length !== 1 || messages[0].type !== 'user' || messages[0].message?.role !== 'user') process.exit(9);
  const prompt = messages[0].message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  fs.writeFileSync('claude-fixture-started.json', JSON.stringify({ pid: process.pid, args, messages }));
  const resume = args.indexOf('--resume');
  if (!prompt.includes('missing-session')) output({ type: 'system', subtype: 'init',
    session_id: prompt.includes('session-mismatch') ? 'claude-mismatched-session' : resume < 0 ? 'claude-fixture-session' : args[resume + 1] });
  output({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'fixture-private-thinking' },
    { type: 'text', text: 'fixture-progress' },
    { type: 'tool_use', name: 'Read', id: 'fixture-tool', input: { file_path: 'AGENTS.md' } },
  ] } });
  if (prompt.includes('exit-seven')) process.exit(7);
  if (prompt.includes('hold-open')) setInterval(() => {}, 1000);
  else if (!prompt.includes('missing-result')) output({ type: 'result', subtype: prompt.includes('error-result') || prompt.includes('quota-errors') ? 'error_during_execution' : 'success',
    is_error: prompt.includes('error-result') || prompt.includes('quota-errors'), result: prompt.includes('quota-errors') ? '' : 'fixture-final',
    errors: prompt.includes('quota-errors') ? ['usage limit reached: fixture-private-quota-detail'] : [],
    permission_denials: prompt.includes('permission-denied') ? [{ tool_name: 'Write', tool_use_id: 'denied' }] : [] });
}
