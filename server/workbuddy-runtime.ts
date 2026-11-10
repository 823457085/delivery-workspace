/** Discovery is not an execution grant: the installed CLI still needs a verified host-tool boundary. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeAdapter } from './agent-runtime.js';
import { workbuddyMcpNames } from './agent-mcp-bridge.js';

/** Candidate argv only. Runtime remains blocked until entitlement and OS control-process isolation are verified. */
export function workbuddyBridgeArguments(configPath: string, objective: string, model: string) {
  if (!path.isAbsolute(configPath) || !objective.trim() || !model.trim()) throw new Error('WorkBuddy 桥参数不完整');
  return ['--print', '--output-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--mcp-config', configPath,
    '--setting-sources', 'none', '--no-plugin-management', '--permission-mode', 'dontAsk',
    '--allowedTools', workbuddyMcpNames.join(','), '--no-session-persistence', '--model', model, '--', objective];
}

export function createWorkbuddyAdapter(applications = [path.join(os.homedir(), 'Applications'), '/Applications']): AgentRuntimeAdapter {
  return {
    id: 'workbuddy',
    async health() {
      let binary = '', version = '';
      for (const directory of applications) {
        const resources = path.join(directory, 'WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli');
        try {
          const info = JSON.parse(await fs.readFile(path.join(resources, 'package.json'), 'utf8'));
          const candidate = path.join(resources, 'dist/codebuddy-lite-wb.mjs');
          if (info.name !== '@genie/agent-cli' || typeof info.version !== 'string' || !(await fs.stat(candidate)).isFile()) continue;
          binary = candidate; version = info.version; break;
        } catch { /* An absent/incomplete bundle does not become a generic CodeBuddy executor. */ }
      }
      return { provider: 'workbuddy', label: '腾讯 WorkBuddy', binary, version,
        authenticated: false, ready: false, writable: false, modes: ['agent', 'ask', 'plan'], accessModes: ['workspace'],
        models: [], defaultModel: '', checkedAt: new Date().toISOString(),
        message: binary ? `已发现 WorkBuddy 内置 CLI ${version}；体验版套餐未包含 CLI 访问，账号权益、宿主工具隔离和执行协议尚未验收，执行保持禁用`
          : '未找到 WorkBuddy 内置 CLI；请安装腾讯官方 WorkBuddy，未将独立 CodeBuddy 视为 WorkBuddy' };
    },
    async execute() { throw new Error('WorkBuddy 认证与宿主工具隔离尚未验收，未启动原生工具'); },
  };
}
