import type { AgentRunEvent } from '../../../shared/agent-runtime';
import { agentToolLabel } from '../../../shared/agent-tool-progress';

export interface ReadableToolEvent {
  id: string;
  createdAt: string;
  status: 'running' | 'finished' | 'failed' | 'recorded';
  title: string;
  target: string;
  events: AgentRunEvent[];
}

interface Action { title: string; targets: string[] }

// 仅拆分展示所需的 shell 单词，复杂展开和 here-document 保留为普通命令。
function shellCommands(source: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [], word = '', started = false, quote = '';
  const flushWord = () => { if (started) words.push(word); word = ''; started = false; };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quote === "'") {
      if (character === "'") quote = ''; else word += character;
    } else if (character === '\\') {
      if (index + 1 >= source.length) return undefined;
      const escaped = source[++index]!;
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(escaped)) word += '\\';
      if (escaped !== '\n') { word += escaped; started = true; }
    } else if (character === '`' || (character === '$' && source[index + 1] === '(')) {
      return undefined;
    } else if (quote === '"') {
      if (character === '"') quote = ''; else word += character;
    } else if (character === "'" || character === '"') {
      quote = character; started = true;
    } else if (character === '#' && !started) {
      while (index + 1 < source.length && source[index + 1] !== '\n') index++;
    } else if (character === '\n' || character === ';' || character === '&' || character === '|') {
      flushCommand();
      if (source[index + 1] === character) index++;
    } else if (/\s/.test(character)) {
      flushWord();
    } else {
      if (character === '<' && source[index + 1] === '<') return undefined;
      if (character === '>' || character === '<') { flushWord(); words.push(character); }
      else { word += character; started = true; }
    }
  }
  if (quote) return undefined;
  flushCommand();
  return commands;
}

function fileTarget(value: string) { return value.replace(/\/$/, '').split('/').at(-1) || value; }
function uniqueTargets(values: string[]) { return [...new Set(values.filter(value => value && !/[$`\n\r]/.test(value)))]; }

function positionalArguments(words: string[], valueOptions: string[] = []) {
  const values: string[] = [];
  let positional = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === '>' || word === '<') break;
    if (!positional && word === '--') { positional = true; continue; }
    if (!positional && valueOptions.includes(word)) { index++; continue; }
    if (positional || !word.startsWith('-')) values.push(word);
  }
  return values;
}

function commandAction(words: string[], depth = 0): Action[] {
  if (words[0] === 'exec') words = words.slice(1);
  const command = words[0]?.split('/').at(-1) || '';
  const args = words.slice(1);
  if (/^(?:zsh|bash|sh)$/.test(command) && depth < 2) {
    const option = args.findIndex(value => /^-[a-z]*c[a-z]*$/.test(value));
    const nested = option >= 0 ? shellCommands(args[option + 1] || '') : undefined;
    if (nested?.length) return nested.flatMap(value => commandAction(value, depth + 1));
  }
  if (['cat', 'head', 'tail', 'sed'].includes(command)) {
    if (command === 'sed' && args.some(value => /^-[^-]*i/.test(value) || /^--in-place(?:=|$)/.test(value))) {
      return [{ title: '执行命令', targets: ['sed'] }];
    }
    const options = command === 'sed' ? ['-e', '--expression', '-f', '--file'] : ['-n', '-c', '--lines', '--bytes'];
    const values = positionalArguments(args, options);
    if (command === 'sed' && !args.some(value => ['-e', '--expression', '-f', '--file'].includes(value))) values.shift();
    return [{ title: '读取文件', targets: values.map(fileTarget) }];
  }
  if (command === 'rg' || command === 'grep') {
    const options = ['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context', '--encoding'];
    const values = positionalArguments(args, options);
    return [{ title: '搜索代码', targets: values.map(value => /\.[a-z\d]+$/i.test(value) ? fileTarget(value) : value) }];
  }
  if (command === 'git') {
    let index = 0;
    while (args[index]?.startsWith('-')) {
      const option = args[index++]!;
      if (['-C', '-c', '--git-dir', '--work-tree'].includes(option)) index++;
    }
    const operation = args[index];
    const rest = args.slice(index + 1);
    const titles: Record<string, string> = { diff: '对比代码差异', 'rev-parse': '核对版本', status: '检查代码状态', log: '查看提交记录', show: '查看版本内容' };
    if (operation && Object.hasOwn(titles, operation)) {
      const separator = rest.indexOf('--');
      const refs = positionalArguments(separator < 0 ? rest : rest.slice(0, separator), ['--format', '--pretty', '--output']);
      const paths = separator < 0 ? [] : rest.slice(separator + 1).map(fileTarget);
      return [{ title: titles[operation]!, targets: [...refs, ...paths] }];
    }
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(command)) {
    const operation = args[0] === 'run' ? args[1] : args[0];
    if (operation === 'test' || operation === 'build') return [{ title: operation === 'test' ? '运行测试' : '构建项目', targets: [command, operation] }];
  }
  if (command === 'curl') {
    const url = args.find(value => /^https?:\/\//.test(value));
    let target = '';
    try { if (url) { const parsed = new URL(url); target = parsed.origin + parsed.pathname; } } catch { /* 目标不明确时只显示动作。 */ }
    return [{ title: '请求接口', targets: target ? [target] : [] }];
  }
  if (command === 'ls') return [{ title: '浏览目录', targets: positionalArguments(args) }];
  if (command === 'pwd') return [{ title: '核对工作目录', targets: [] }];
  return [{ title: '执行命令', targets: /^[\w.+-]+$/.test(command) ? [command] : [] }];
}

function describeTool(message: string) {
  let payload = message.trim();
  let status: ReadableToolEvent['status'] = 'recorded';
  const lifecycle = payload.match(/^(?:(?:Codex|Cursor|Claude Code) 正在(执行工作区命令|执行只读检查|调用工作区工具)|(工作区命令|只读检查)(已完成|未通过))$/);
  if (lifecycle) {
    const title = payload.includes('只读检查') ? '执行检查' : payload.includes('工作区工具') ? '调用工具' : '执行命令';
    return { status: lifecycle[1] ? 'running' as const : lifecycle[3] === '未通过' ? 'failed' as const : 'finished' as const,
      key: payload, title, target: '' };
  }
  const prefix = payload.match(/^(正在执行|执行完成|执行失败|执行未通过|开始|完成|失败)[:：]\s*/);
  if (prefix) {
    status = /失败|未通过/.test(prefix[1]!) ? 'failed' : /完成/.test(prefix[1]!) ? 'finished' : 'running';
    payload = payload.slice(prefix[0].length).trim();
  }
  const named = payload.match(/^([\w]+|执行命令|读取文件|搜索代码|搜索文本|浏览目录|修改文件|写入文件|读取网页|搜索网页)(?:[:：]\s*([\s\S]*))?$/);
  const name = named?.[1] || '';
  const label = agentToolLabel(name);
  const known = label !== name || /^(?:读取文件|搜索代码|搜索文本|浏览目录|修改文件|写入文件|读取网页|搜索网页)$/.test(name);
  if (name && name !== 'run_command' && name !== '执行命令' && (known || name.includes('_') || !prefix)) {
    const target = known ? named?.[2]?.trim() || '' : name;
    return { status, key: payload, title: known ? label : '调用工具',
      target: ['读取文件', '修改文件', '写入文件'].includes(label) ? fileTarget(target) : target };
  }
  const command = named && (name === 'run_command' || name === '执行命令') ? named[2] || '' : payload;
  const parsed = shellCommands(command);
  const actions = parsed?.length ? parsed.flatMap(words => commandAction(words)) : [{ title: '执行命令', targets: [] }];
  return { status, key: command ? `command:${command}` : '', title: [...new Set(actions.map(action => action.title))].join('、'),
    target: uniqueTargets(actions.flatMap(action => action.targets)).join('、') };
}

export function readableToolEvents(events: AgentRunEvent[]): ReadableToolEvent[] {
  const result: ReadableToolEvent[] = [];
  let previousKey = '';
  for (const event of events) {
    const description = describeTool(event.message);
    const previous = result.at(-1);
    if (previous && previous.status === 'running' && previousKey && ['finished', 'failed'].includes(description.status) && previousKey === description.key) {
      previous.status = description.status;
      previous.createdAt = event.createdAt;
      previous.events.push(event);
    } else {
      result.push({ id: event.id, createdAt: event.createdAt, status: description.status, title: description.title,
        target: description.target.length > 220 ? `${description.target.slice(0, 219)}…` : description.target, events: [event] });
    }
    previousKey = description.key;
  }
  return result;
}
