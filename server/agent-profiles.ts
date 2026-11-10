/** 岗位配置只有一份带版本的状态；派发流程保存其副本，后续设置不会改变进行中的流程。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentAccessMode, AgentProvider, AgentRuntimeHealth } from '../shared/agent-runtime.js';
import { defaultTeamProfileConfig, normalizeTeamAccessModes, profileConfigSchema, teamModelChoiceSchema, teamProfileIds, type TeamModelChoice, type TeamProfileConfig, type TeamProfileId } from '../shared/agent-team.js';

export const agentProfilesStatePath = 'agent-runtimes/agent-profiles.json';
export async function readTeamRolePrompt(id: TeamProfileId) {
  if (!teamProfileIds.includes(id)) throw new Error('未知团队岗位');
  const root = fileURLToPath(new URL('./agent-role-prompts/', import.meta.url));
  const [common, role] = await Promise.all([fs.readFile(path.join(root, 'common.md'), 'utf8'), fs.readFile(path.join(root, `${id}.md`), 'utf8')]);
  return `${common}\n${role}`;
}
export interface AgentProfileStoreOptions {
  readRuntime: (provider: AgentProvider, force?: boolean) => Promise<AgentRuntimeHealth>;
  readJson?: (relative: string) => Promise<unknown>;
  writeJson?: (relative: string, value: unknown) => Promise<void>;
}
export interface SaveAgentProfilesInput {
  expectedRevision: number;
  profiles: TeamProfileConfig['profiles'];
  reviewRouting: TeamProfileConfig['reviewRouting'];
  options: TeamProfileConfig['options'];
}
const aliases: Record<string, { id: string; label: string }> = {
  'claude-sonnet-5-5': { id: 'sonnet', label: 'Sonnet 5.5' }, 'claude-opus-5-5': { id: 'opus', label: 'Opus 5.5' },
  'claude-haiku-5-5': { id: 'haiku', label: 'Haiku 5.5' }, 'claude-fable-5-1': { id: 'fable', label: 'Fable 5.1' },
};
export function validateTeamModelChoice(choice: TeamModelChoice, health: AgentRuntimeHealth, mode: 'ask' | 'agent', accessMode: AgentAccessMode = mode === 'agent' ? 'full' : 'workspace') {
  teamModelChoiceSchema.parse({ provider: choice.provider, model: choice.model, reasoningEffort: choice.reasoningEffort,
    ...(choice.catalogAlias ? { catalogAlias: choice.catalogAlias } : {}) });
  if (health.provider !== choice.provider || !health.ready) throw new Error(`${choice.provider} 未就绪：${health.message}`);
  if (!health.modes.includes(mode)) throw new Error(`${choice.provider} 不支持岗位模式 ${mode}`);
  const requiredAccessMode = mode === 'agent' ? accessMode : 'workspace';
  if (health.accessModes && !health.accessModes.includes(requiredAccessMode)) throw new Error(`${choice.provider} 不支持${requiredAccessMode === 'full' ? '完全' : '工作区'}访问`);
  const alias = choice.provider === 'claude' ? aliases[choice.model] : undefined;
  const option = health.models.find(item => item.id === choice.model)
    || (alias && choice.catalogAlias?.id === alias.id && choice.catalogAlias.label === alias.label
      ? health.models.find(item => item.id === alias.id && item.label === alias.label) : undefined);
  if (!option) throw new Error(`${choice.provider} 模型目录没有 ${choice.model}，请检查模型或完整 ID 对应的别名`);
  if (choice.provider === 'claude' && option.efforts?.length && !choice.reasoningEffort) throw new Error(`${choice.model} 必须明确选择该模型支持的推理强度`);
  if (choice.reasoningEffort && !option.efforts?.includes(choice.reasoningEffort)) throw new Error(`${choice.model} 不支持推理强度 ${choice.reasoningEffort}`);
}

export async function createAgentProfileStore(directory: string, options: AgentProfileStoreOptions) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(await fs.realpath(directory), 'agent-profiles.json');
  if (await fs.lstat(file).then(info => info.isSymbolicLink(), () => false)) throw new Error('岗位配置文件不能是符号链接');
  const load = async () => {
    try { return profileConfigSchema.parse(normalizeTeamAccessModes(options.readJson ? await options.readJson(agentProfilesStatePath) : JSON.parse(await fs.readFile(file, 'utf8')))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultTeamProfileConfig(); throw error; }
  };
  const instructions = Object.fromEntries(await Promise.all(teamProfileIds.map(async id => [id, await readTeamRolePrompt(id)]))) as Record<TeamProfileId, string>;
  let current = await load();
  let writes: Promise<unknown> = Promise.resolve();
  function exclusive<T>(action: () => Promise<T>) { const result = writes.then(action); writes = result.catch(() => {}); return result; }
  const read = () => structuredClone(current);
  async function validate(value: unknown) {
    const config = profileConfigSchema.parse(normalizeTeamAccessModes(value));
    const pending = new Map<AgentProvider, Promise<AgentRuntimeHealth>>();
    const health = (provider: AgentProvider) => {
      if (!pending.has(provider)) pending.set(provider, options.readRuntime(provider, true));
      return pending.get(provider)!;
    };
    for (const profile of config.profiles) {
      validateTeamModelChoice(profile, await health(profile.provider), profile.mode);
      if (profile.escalation) validateTeamModelChoice(profile.escalation, await health(profile.escalation.provider), profile.mode);
    }
    for (const choice of Object.values(config.reviewRouting)) validateTeamModelChoice(choice, await health(choice.provider), 'agent');
    return config;
  }
  async function persist(config: TeamProfileConfig) {
    if (options.writeJson) await options.writeJson(agentProfilesStatePath, config);
    else {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    current = config;
    return read();
  }
  async function saveUnlocked(input: SaveAgentProfilesInput) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('岗位配置版本无效');
    const latest = await load();
    if (input.expectedRevision !== latest.revision) { current = latest; throw new Error('岗位配置已更新，请重新读取后保存'); }
    const next = await validate({ revision: latest.revision + 1, profiles: input.profiles, reviewRouting: input.reviewRouting, options: input.options });
    return persist(next);
  }
  return {
    read,
    /** 保存独立副本，不暴露内部引用；调用者将其写进任务记录。 */
    freeze: read,
    validate,
    save: (input: SaveAgentProfilesInput) => exclusive(() => saveUnlocked(input)),
    reset: (expectedRevision: number) => exclusive(() => { const defaults = defaultTeamProfileConfig();
      return saveUnlocked({ ...defaults, expectedRevision }); }),
    instruction: async (id: TeamProfileId) => instructions[id],
  };
}
