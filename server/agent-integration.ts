/** 使用 Git tree 和二进制补丁生成统一候选；不创建产品提交，也不修改来源 worktree。 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitTree } from './agent-workflow.js';
import { globToRegExp } from '../shared/agent-task-result.js';

const exec = promisify(execFile);
const commandOptions = { timeout: 120_000, maxBuffer: 50_000_000 };
export interface IntegrationLease { path: string; ownerRunId: string; fencingToken: number }
export interface IntegrationSource {
  runId: string; profileId: string; workspacePath: string; baseHead: string; snapshot: string; patchHash: string; patch: string; files: string[]; lease?: IntegrationLease;
}
export interface IntegrationOwnership { owner: string; paths: string[] }
export interface CandidateConflict { path: string; owner: string; resolvedByRunId?: string; reason?: string }
export interface CandidateManifest {
  id: string; workflowId: string; round: number; base: { head: string; tree: string };
  sources: IntegrationSource[];
  integration: { worktree: string; repositoryPath: string; appliedOrder: string[]; conflicts: CandidateConflict[]; pendingRunIds: string[] };
  final: { tree: string }; supersedes?: string;
}
export type AssertIntegrationLease = (lease: IntegrationLease) => Promise<unknown>;

async function git(workspace: string, args: string[], env?: NodeJS.ProcessEnv) {
  return (await exec('git', ['-C', workspace, ...args], { ...commandOptions, ...(env ? { env } : {}) })).stdout.trimEnd();
}
async function repositoryRoot(workspacePath: string) {
  try { return await fs.realpath(await git(workspacePath, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error('并行集成只支持 Git 项目，请使用串行 complex_delivery'); }
}
const workingTree = gitTree;
function validRef(ref: string) { if (!/^[a-f0-9]{40,64}$/i.test(ref)) throw new Error('候选版本必须使用完整 Git 对象标识'); return ref; }
const splitPaths = (value: string) => value.split('\0').filter(Boolean);
async function conflictPaths(workspacePath: string) {
  const records = splitPaths(await git(workspacePath, ['ls-files', '--unmerged', '-z']));
  return [...new Set(records.map(item => item.slice(item.indexOf('\t') + 1)))];
}
function ownerFor(file: string, ownership: IntegrationOwnership[], shared: { path: string; owner: string }[]) {
  const assigned = shared.find(item => item.path === file)?.owner;
  if (assigned) return assigned;
  const owners = [...new Set(ownership.filter(item => item.paths.some(pattern => globToRegExp(pattern).test(file))).map(item => item.owner))];
  return owners.length === 1 ? owners[0] : '';
}
function validateSource(source: IntegrationSource, baseHead: string) {
  if (source.baseHead !== baseHead) throw new Error('并行来源必须基于同一 base');
  if (createHash('sha256').update(source.patch).digest('hex') !== source.patchHash) throw new Error('来源补丁哈希不匹配');
  validRef(source.snapshot);
}
async function applySource(manifest: CandidateManifest, source: IntegrationSource, ownership: IntegrationOwnership[], shared: { path: string; owner: string }[], assertLease?: AssertIntegrationLease) {
  validateSource(source, manifest.base.head);
  if (source.lease && assertLease) await assertLease(source.lease);
  const temporary = path.join(os.tmpdir(), `delivery-source-${randomUUID()}.patch`);
  let failure: unknown;
  try {
    if (source.patch) {
      await fs.writeFile(temporary, source.patch, { mode: 0o600 });
      await git(manifest.integration.worktree, ['apply', '--3way', '--index', temporary]);
    }
  } catch (error) { failure = error; }
  finally { await fs.rm(temporary, { force: true }); }
  manifest.integration.appliedOrder.push(source.runId);
  manifest.integration.pendingRunIds = manifest.integration.pendingRunIds.filter(id => id !== source.runId);
  if (failure) {
    const unmerged = await conflictPaths(manifest.integration.worktree);
    const files = unmerged.length ? unmerged : source.files;
    if (!files.length) throw new Error('来源补丁应用失败，未找到可交接的冲突文件');
    for (const file of files) {
      const owner = ownerFor(file, ownership, shared);
      if (!owner) throw new Error(`冲突文件缺少唯一负责人：${file}`);
      manifest.integration.conflicts.push({ path: file, owner, reason: unmerged.length ? 'merge_conflict' : 'patch_not_applied' });
    }
  }
}
export async function captureIntegrationSource(input: {
  workspacePath: string; baseHead: string; runId: string; profileId: string; lease?: IntegrationLease; assertLease?: AssertIntegrationLease;
}): Promise<IntegrationSource> {
  const workspacePath = await repositoryRoot(input.workspacePath);
  const baseHead = validRef(input.baseHead);
  if (input.lease && input.assertLease) await input.assertLease(input.lease);
  const snapshot = await workingTree(workspacePath);
  const patch = (await exec('git', ['-C', workspacePath, 'diff', '--binary', '--full-index', baseHead, snapshot, '--', '.', ':(exclude).delivery-artifacts'], commandOptions)).stdout;
  const files = splitPaths(await git(workspacePath, ['diff', '--name-only', '-z', baseHead, snapshot, '--', '.', ':(exclude).delivery-artifacts']));
  return { runId: input.runId, profileId: input.profileId, workspacePath, baseHead, snapshot,
    patchHash: createHash('sha256').update(patch).digest('hex'), patch, files, ...(input.lease ? { lease: input.lease } : {}) };
}
export async function createAgentCandidate(input: {
  repositoryPath: string; targetPath: string; workflowId: string; round: number; baseHead: string; sources: IntegrationSource[];
  ownership: IntegrationOwnership[]; shared?: { path: string; owner: string }[]; assertLease?: AssertIntegrationLease; supersedes?: string; beforeApply?: (workspace: string) => Promise<void>;
}): Promise<CandidateManifest> {
  const repositoryPath = await repositoryRoot(input.repositoryPath);
  const baseHead = validRef(input.baseHead);
  if (!input.sources.length) throw new Error('候选集成缺少来源');
  for (const source of input.sources) { validateSource(source, baseHead); if (source.lease && input.assertLease) await input.assertLease(source.lease); }
  await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
  const targetPath = path.join(await fs.realpath(path.dirname(input.targetPath)), path.basename(input.targetPath));
  if (targetPath === repositoryPath || repositoryPath.startsWith(`${targetPath}${path.sep}`)) throw new Error('集成目录不能覆盖来源仓库');
  await git(repositoryPath, ['worktree', 'add', '--detach', targetPath, baseHead]);
  await input.beforeApply?.(targetPath);
  const manifest: CandidateManifest = { id: randomUUID(), workflowId: input.workflowId, round: input.round,
    base: { head: baseHead, tree: await git(repositoryPath, ['rev-parse', `${baseHead}^{tree}`]) }, sources: structuredClone(input.sources),
    integration: { worktree: targetPath, repositoryPath, appliedOrder: [], conflicts: [], pendingRunIds: input.sources.map(item => item.runId) },
    final: { tree: '' }, ...(input.supersedes ? { supersedes: input.supersedes } : {}) };
  for (const source of input.sources) {
    await applySource(manifest, source, input.ownership, input.shared || [], input.assertLease);
    if (manifest.integration.conflicts.some(item => !item.resolvedByRunId)) return manifest;
  }
  manifest.final.tree = await git(targetPath, ['write-tree']);
  return manifest;
}
export async function resolveCandidateConflict(manifest: CandidateManifest, input: { owner: string; runId: string; paths: string[] }): Promise<CandidateManifest> {
  const result = structuredClone(manifest);
  if (!input.paths.length) throw new Error('没有选择冲突文件');
  const selected = input.paths.map(file => {
    const conflict = result.integration.conflicts.find(item => item.path === file && !item.resolvedByRunId);
    if (!conflict || conflict.owner !== input.owner) throw new Error(`只有文件负责人可以处理冲突：${file}`);
    return conflict;
  });
  for (const conflict of selected) {
    const target = path.resolve(result.integration.worktree, conflict.path);
    if (!target.startsWith(`${result.integration.worktree}${path.sep}`)) throw new Error('冲突路径越出候选目录');
    const content = await fs.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(content)) throw new Error(`冲突标记尚未清除：${conflict.path}`);
  }
  await git(result.integration.worktree, ['add', '-A', '--', ...selected.map(item => item.path)]);
  const remaining = await conflictPaths(result.integration.worktree);
  for (const conflict of selected) {
    if (remaining.includes(conflict.path)) throw new Error(`文件仍有未解决的 Git 冲突：${conflict.path}`);
    conflict.resolvedByRunId = input.runId;
  }
  result.final.tree = '';
  return result;
}
export async function finalizeCandidate(manifest: CandidateManifest, options: {
  ownership: IntegrationOwnership[]; shared?: { path: string; owner: string }[]; assertLease?: AssertIntegrationLease;
}): Promise<CandidateManifest> {
  const result = structuredClone(manifest);
  if (result.integration.conflicts.some(item => !item.resolvedByRunId) || (await conflictPaths(result.integration.worktree)).length) throw new Error('候选仍有未解决冲突');
  for (const source of result.sources) if (source.lease && options.assertLease) await options.assertLease(source.lease);
  for (const runId of [...result.integration.pendingRunIds]) {
    const source = result.sources.find(item => item.runId === runId)!;
    await applySource(result, source, options.ownership, options.shared || [], options.assertLease);
    if (result.integration.conflicts.some(item => !item.resolvedByRunId)) return result;
  }
  const expected = new Set(result.sources.flatMap(item => item.files));
  const changed = [...splitPaths(await git(result.integration.worktree, ['diff', '--name-only', '-z', result.base.head])),
    ...splitPaths(await git(result.integration.worktree, ['ls-files', '--others', '--exclude-standard', '-z']))];
  const outside = changed.filter(file => !file.startsWith('.delivery-artifacts/') && !expected.has(file));
  if (outside.length) throw new Error(`冲突处理改动超出候选来源：${outside.join('、')}`);
  result.final.tree = await workingTree(result.integration.worktree);
  return result;
}
export async function removeAgentCandidate(manifest: CandidateManifest) {
  await git(manifest.integration.repositoryPath, ['worktree', 'remove', '--force', manifest.integration.worktree]);
}
