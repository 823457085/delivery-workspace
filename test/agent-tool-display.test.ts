import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToolDescription as agentToolDisplay } from '../shared/agent-tool-progress.js';

test('tool activity exposes the relevant command, path or search target and preserves existing messages', () => {
  assert.equal(agentToolDisplay('run_command', { CommandLine: 'npm test -- --runInBand' }), '执行命令：npm test -- --runInBand');
  assert.equal(agentToolDisplay('view_file', { AbsolutePath: '/work/src/index.ts', Content: 'PRIVATE_CONTENT' }), '读取文件：/work/src/index.ts');
  assert.equal(agentToolDisplay('grep_search', { Query: 'handleSubmit', SearchPath: '/work/src' }), '搜索代码：handleSubmit');
  assert.equal(agentToolDisplay('write_to_file'), '写入文件');
  assert.equal(agentToolDisplay('开始：执行命令：npm test'), '开始：执行命令：npm test');
  assert.equal(agentToolDisplay('unknown_tool'), 'unknown_tool');
});

test('tool activity excludes credentials, request bodies, inline scripts and command input', () => {
  const command = 'TOKEN=PRIVATE_ENV curl -H "Authorization: Bearer PRIVATE_HEADER" --data "PRIVATE_BODY" --token PRIVATE_FLAG https://user:PRIVATE_PASSWORD@example.com/a?token=PRIVATE_QUERY';
  const display = agentToolDisplay('run_command', { CommandLine: command, output: 'PRIVATE_OUTPUT', thinking: 'PRIVATE_THINKING' });
  assert.ok(!display.includes('PRIVATE_')); assert.match(display, /curl/); assert.match(display, /已隐藏/);
  assert.ok(!agentToolDisplay('run_command', { CommandLine: 'python -c "PRIVATE_SCRIPT"' }).includes('PRIVATE_SCRIPT'));
  assert.ok(!agentToolDisplay('run_command', { CommandLine: 'python <<EOF\nPRIVATE_SCRIPT\nEOF' }).includes('PRIVATE_SCRIPT'));
  for (const command of ['curl -u user:PRIVATE_BASIC https://example.com', 'curl -Uuser:PRIVATE_PROXY https://example.com',
    'curl --oauth2-bearer PRIVATE_OAUTH https://example.com', 'curl --proxy-user=user:PRIVATE_PROXY https://example.com',
    'node -p "PRIVATE_SCRIPT"', 'bash -lc "PRIVATE_SCRIPT"', "python -c'PRIVATE_SCRIPT'"]) {
    assert.doesNotMatch(agentToolDisplay('run_command', { CommandLine: command }), /PRIVATE_/, command);
  }
  assert.equal(agentToolDisplay('send_command_input', { Input: 'PRIVATE_PASSWORD' }), '发送命令输入');
  assert.equal(agentToolDisplay('read_url_content', { Url: 'https://user:PRIVATE_PASSWORD@example.com/a?token=PRIVATE_QUERY#secret' }), '读取网页：https://example.com/a');
});

test('tool activity bounds output and ignores arbitrary nested payloads', () => {
  assert.ok(agentToolDisplay('run_command', { CommandLine: 'npm test '.repeat(2000) }).length < 250);
  assert.equal(agentToolDisplay('view_file', { data: { bytes: [1, 2, 3], token: 'PRIVATE' } }), '读取文件');
  assert.equal(agentToolDisplay('view_file', ['PRIVATE']), '读取文件');
});

test('HTTP command progress hides all arguments, including standalone and attached body or cookie flags', () => {
  for (const [command, executable] of [
    ["curl -d 'PRIVATE_BODY' https://example.com/api", 'curl'],
    ["curl -d'PRIVATE_BODY' https://example.com/api", 'curl'],
    ["curl -b 'PRIVATE_COOKIE_VALUE' https://example.com/api", 'curl'],
    ["curl --json 'PRIVATE_BODY' https://example.com/api", 'curl'],
    ["curl -F'field=PRIVATE_FORM' https://example.com/api", 'curl'],
    ['wget --post-data=PRIVATE_BODY https://example.com/api', 'wget'],
    ['http POST https://example.com/api field=PRIVATE_BODY', 'http'],
    ['https POST https://example.com/api field=PRIVATE_BODY', 'https'],
    ['httpie POST https://example.com/api field=PRIVATE_BODY', 'httpie'],
    ['/usr/bin/curl https://example.com/PRIVATE_PATH', 'curl'],
    ['npm test && curl -dPRIVATE_BODY https://example.com/api', 'curl'],
    ["time curl -d 'PRIVATE_BODY' https://example.com/api", 'curl'],
    ["nohup curl -d 'PRIVATE_BODY' https://example.com/api", 'curl'],
    ["bash -c 'curl -dPRIVATE_BODY https://example.com/api'", 'curl'],
    ['"/usr/bin/curl" -dPRIVATE_BODY https://example.com/api', 'curl'],
  ]) {
    assert.equal(agentToolDisplay('run_command', { CommandLine: command }), `执行命令：${executable} [参数已隐藏]`, command);
  }
  assert.equal(agentToolDisplay('run_command', { CommandLine: 'npm test -- --runInBand' }), '执行命令：npm test -- --runInBand');
  assert.equal(agentToolDisplay('run_command', { CommandLine: 'cat /work/curl' }), '执行命令：cat /work/curl');
  assert.equal(agentToolDisplay('view_file', { AbsolutePath: '/work/curl' }), '读取文件：/work/curl');
});
