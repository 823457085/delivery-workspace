/**
 * 设计说明：Codex Skill 候选必须与当前工作区和本机已启用插件保持一致。
 * 本模块只读取 Skill 元数据；不读取正文、不修改 Codex 配置，也不安装或启用插件。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentSkillOption } from '../shared/agent-runtime.js';
import { cliBinary, codexHome } from './cli-runtime.js';

const exec = promisify(execFile);
let pluginRootsCache: { expiresAt: number; roots: SkillRoot[] } | undefined;
let pluginRootsRequest: Promise<SkillRoot[]> | undefined;

const skillDescriptionsZh: Record<string, string> = {
  'bff-api-openapi-generation': '根据前端、旧接口、RPC Proto 和 Apex 规范设计或更新 BFF API 与 OpenAPI 契约。',
  'apex-frontend-tech-design-delivery': '基于 Jira、PRD、原型和仓库证据生成 Apex 前端技术方案，并按需交付到 Confluence 或 Jira。',
  'apex-jira-feature-development': '从 Jira 需求开始实现或继续 Apex 前端开发，包含工作区、分支和验证流程。',
  'hardcode-i18n-scanner': '扫描并改造前端硬编码中文与国际化问题，支持位置码规范化、校验和 Excel 导出。',
};

export function skillDisplayDescription(name: string, fallback: string) {
  return skillDescriptionsZh[name] || fallback;
}

interface InstalledPlugin {
  name?: unknown;
  marketplaceName?: unknown;
  version?: unknown;
  enabled?: unknown;
  source?: { source?: unknown; path?: unknown };
}

interface SkillRoot {
  path: string;
  source: AgentSkillOption['source'];
  sourceLabel: string;
  namespace?: string;
}

interface SkillCandidate extends AgentSkillOption {
  searchDescription: string;
}

async function exists(target: string) {
  try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}

async function skillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const direct = entries.find((entry) => entry.isFile() && entry.name === 'SKILL.md');
  if (direct) return [path.join(root, direct.name)];
  const nested = await Promise.all(entries.filter((entry) => entry.isDirectory())
    .map((entry) => skillFiles(path.join(root, entry.name), depth + 1)));
  return nested.flat();
}

function frontmatter(text: string, key: string) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return '';
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return '';
  const initial = lines[index].slice(key.length + 1).trim();
  if (!['>', '>-', '|', '|-'].includes(initial)) return initial.replace(/^['"]|['"]$/g, '').trim();
  const collected: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    if (line.trim()) collected.push(line.trim());
  }
  return collected.join(' ').trim();
}

async function readSkill(file: string, root: SkillRoot): Promise<SkillCandidate | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8');
    const fallback = path.basename(path.dirname(file));
    const name = frontmatter(text, 'name') || fallback;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return undefined;
    const originalDescription = frontmatter(text, 'description').replace(/\s+/g, ' ').slice(0, 240);
    return {
      name,
      invocation: root.namespace ? `${root.namespace}:${name}` : name,
      description: skillDisplayDescription(name, originalDescription),
      searchDescription: originalDescription,
      source: root.source,
      sourceLabel: root.sourceLabel,
    };
  } catch { return undefined; }
}

async function installedPluginRoots(): Promise<SkillRoot[]> {
  if (pluginRootsCache && pluginRootsCache.expiresAt > Date.now()) return pluginRootsCache.roots;
  if (pluginRootsRequest) return pluginRootsRequest;
  pluginRootsRequest = (async () => {
    try {
      const output = await exec(cliBinary, ['plugin', 'list', '--json'], { timeout: 10_000, maxBuffer: 2_000_000 });
      const parsed = JSON.parse(output.stdout) as { installed?: InstalledPlugin[] };
      const roots = await Promise.all((parsed.installed || []).filter((plugin) => plugin.enabled === true)
        .map(async (plugin): Promise<SkillRoot | undefined> => {
          const name = typeof plugin.name === 'string' ? plugin.name : '';
          const marketplace = typeof plugin.marketplaceName === 'string' ? plugin.marketplaceName : '';
          const version = typeof plugin.version === 'string' ? plugin.version : '';
          if (!name) return undefined;
          const local = plugin.source?.source === 'local' && typeof plugin.source.path === 'string' ? plugin.source.path : '';
          const cached = marketplace && version ? path.join(codexHome, 'plugins', 'cache', marketplace, name, version) : '';
          const pluginRoot = local && await exists(local) ? local : cached && await exists(cached) ? cached : '';
          if (!pluginRoot || !await exists(path.join(pluginRoot, 'skills'))) return undefined;
          return { path: path.join(pluginRoot, 'skills'), source: 'plugin', sourceLabel: `插件 ${name}`, namespace: name };
        }));
      const available = roots.filter((root): root is SkillRoot => !!root);
      pluginRootsCache = { expiresAt: Date.now() + 30_000, roots: available };
      return available;
    } catch { return []; }
    finally { pluginRootsRequest = undefined; }
  })();
  return pluginRootsRequest;
}

export async function listCodexSkills(workspacePath: string, query = ''): Promise<AgentSkillOption[]> {
  const bundledSkills = process.env.DELIVERY_SKILLS_ROOT;
  const roots: SkillRoot[] = [
    { path: path.join(workspacePath, '.agents', 'skills'), source: 'project', sourceLabel: '当前项目' },
    { path: path.join(workspacePath, '.codex', 'skills'), source: 'project', sourceLabel: '当前项目' },
    ...(bundledSkills ? [{ path: path.resolve(bundledSkills), source: 'project' as const, sourceLabel: '工作台配套 Skill' }] : []),
    { path: path.join(codexHome, 'skills'), source: 'personal', sourceLabel: '个人 Skill' },
    ...await installedPluginRoots(),
  ];
  const candidates = (await Promise.all(roots.map(async (root) => {
    const files = await skillFiles(root.path);
    return Promise.all(files.map(async (file) => {
      const system = root.source === 'personal' && file.startsWith(`${path.join(codexHome, 'skills', '.system')}${path.sep}`);
      return readSkill(file, system ? { ...root, source: 'system', sourceLabel: 'Codex 内置' } : root);
    }));
  }))).flat().filter((skill): skill is SkillCandidate => !!skill);
  const unique = new Map<string, SkillCandidate>();
  for (const skill of candidates) if (!unique.has(skill.invocation)) unique.set(skill.invocation, skill);
  const term = query.trim().toLowerCase();
  const sourceOrder: Record<AgentSkillOption['source'], number> = { project: 0, personal: 1, system: 2, plugin: 3 };
  return [...unique.values()]
    .filter((skill) => !term || `${skill.invocation} ${skill.name} ${skill.description} ${skill.searchDescription} ${skill.sourceLabel}`.toLowerCase().includes(term))
    .sort((left, right) => sourceOrder[left.source] - sourceOrder[right.source] || left.invocation.localeCompare(right.invocation))
    .map(({ searchDescription: _searchDescription, ...skill }) => skill);
}
