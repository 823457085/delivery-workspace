/** Use agy's native agent inheritance controls to avoid starting ambient MCP servers or hooks. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRun } from '../shared/agent-runtime.js';

export async function prepareAntigravityAgentProfile(run: Pick<AgentRun, 'mode' | 'accessMode' | 'team'>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-antigravity-agent-'));
  const name = `delivery-${randomUUID()}`;
  const commandExecutionPolicy = run.mode === 'agent' && run.accessMode === 'workspace' ? 'sandbox' : 'eager';
  const tools = ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'read_url_content', 'search_web'];
  // Group runs are dispatched with a fixed role. Ordinary native conversations
  // retain their initial tool catalog so their mode can change on a later turn.
  const readonlyGroup = run.team?.interactionMode === 'group' && run.mode !== 'agent';
  if (!readonlyGroup) {
    tools.push('write_to_file', 'replace_file_content', 'multi_replace_file_content', 'notebook_edit',
      'run_command', 'command_status', 'send_command_input');
  }
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.chmod(directory, 0o700);
    const agents = path.join(directory, '.agents', 'agents');
    await fs.mkdir(agents, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(agents, `${name}.md`), [
      '---', `name: ${name}`, 'description: Delivery workbench invocation', 'mainAgent: true', 'subagent: false',
      'inheritMcp: false', 'inheritCustomizations: false',
      `commandExecutionPolicy: ${commandExecutionPolicy}`, 'tools:', ...tools.map(tool => `  - ${tool}`), '---',
      readonlyGroup
        ? 'This group role is read-only. Use native file, directory and search tools for the task materials. Leave shell checks and edits to the roles that have those permissions.'
        : 'Follow the user request using the native tools permitted for this invocation.', '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    return { directory: await fs.realpath(directory), name, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
