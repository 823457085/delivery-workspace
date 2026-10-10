import fs from "node:fs/promises";
import { catchupAdminExclusionReason } from "./catchup-admin-scope.mjs";
import { sourceDataRoot, gitBinary } from "./config.mjs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { mutateCatchupDispatchRegistryFile } from "./catchup-dispatch.mjs";

/**
 * 设计说明：页面“开启”必须把一个冻结需求变成可调度的独立执行现场，但不能读取或
 * 复制主工作区的未提交改动。本模块只在固定根目录、固定基线和确定性分支名下创建
 * worktree、最小交接包与会话登记；已有登记只校验并复用，外部 Jira 与执行状态由
 * 上层分别处理。所有 registry 写入与 dispatcher 共用同一把锁，避免丢失线程状态。
 */

export const DEFAULT_CATCHUP_SOURCE_REPOSITORY = process.env.APEX_CATCHUP_SOURCE_REPOSITORY || "";
export const DEFAULT_CATCHUP_REQUIREMENTS_ROOT = path.join(sourceDataRoot, "workspaces", "requirements");
export const DEFAULT_CATCHUP_SESSIONS_ROOT = path.join(sourceDataRoot, "sessions");
export const DEFAULT_CATCHUP_BASE_SHA = process.env.APEX_CATCHUP_BASE_SHA || "";
export const DEFAULT_CATCHUP_RUNTIME_SUPPORT_SOURCE = "";
export const CATCHUP_RUNTIME_SUPPORT_FILES = Object.freeze([
  ".env.dev",
  ".env.development",
  "env.d.ts",
  "vite.config.ts"
]);

const execFileAsync = promisify(execFileCallback);
const requirementIdPattern = /^REQ-(?:CU-)?\d{3}$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const domainDirectories = new Map([
  ["支付、订单与财务", "01-支付订单与财务"],
  ["设备、算法与监控", "02-设备算法与监控"],
  ["商户、会员与平台配置", "03-商户会员与平台配置"],
  ["内容、活动与工单", "04-内容活动与工单"],
  ["跨系统业务能力", "05-跨系统业务能力"]
]);

export class CatchupProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatchupProvisioningError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatchupProvisioningError(code, message);
}

async function defaultRunGit(args, { cwd }) {
  const { stdout } = await execFileAsync(gitBinary, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000
  });
  return String(stdout || "").trim();
}

async function exists(filename) {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncRuntimeSupportFiles(workspacePath, sourcePath) {
  const syncedFiles = [];
  for (const filename of CATCHUP_RUNTIME_SUPPORT_FILES) {
    const sourceFile = path.join(sourcePath, filename);
    const targetFile = path.join(workspacePath, filename);
    if (!(await exists(sourceFile))) continue;
    await fs.copyFile(sourceFile, targetFile);
    syncedFiles.push(filename);
  }
  return syncedFiles;
}

async function markRuntimeSupportFilesLocalOnly(workspacePath, runGit, filenames) {
  if (!filenames.length) return;
  try {
    await runGit(["update-index", "--assume-unchanged", "--", ...filenames], { cwd: workspacePath });
  } catch {
    // Runtime files may be ignored or untracked in a freshly provisioned worktree.
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveGitPath(cwd, value) {
  return path.resolve(cwd, String(value || "").trim());
}

function cleanFailure(error) {
  return {
    code: error?.code || "PROVISION_FAILED",
    message: String(error?.message || "追平执行现场准备失败").slice(0, 500)
  };
}

export function catchupProvisioningTarget(requirement, {
  requirementsRoot = DEFAULT_CATCHUP_REQUIREMENTS_ROOT,
  sessionsRoot = DEFAULT_CATCHUP_SESSIONS_ROOT,
  baseSha = DEFAULT_CATCHUP_BASE_SHA
} = {}) {
  const requirementId = String(requirement?.id || "");
  const exclusionReason = catchupAdminExclusionReason(requirementId);
  if (exclusionReason) fail("ADMIN_DELIVERY_EXCLUDED", exclusionReason);
  const slug = String(requirement?.slug || "");
  if (!requirementIdPattern.test(requirementId)) {
    fail("INVALID_REQUIREMENT_ID", "追平需求 ID 无效");
  }
  if (!slugPattern.test(slug)) {
    fail("INVALID_REQUIREMENT_SLUG", `${requirementId} 的冻结 slug 无效`);
  }
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    fail("INVALID_BASE_SHA", "追平固定基线无效");
  }

  const name = `${requirementId}-${slug}`;
  const workspacePath = path.resolve(requirementsRoot, name, "admin");
  const sessionDirectory = path.resolve(sessionsRoot, requirementId);
  if (!isInside(path.resolve(requirementsRoot), workspacePath)) {
    fail("WORKSPACE_OUTSIDE_ROOT", "追平工作区超出固定根目录");
  }
  if (!isInside(path.resolve(sessionsRoot), sessionDirectory)) {
    fail("SESSION_OUTSIDE_ROOT", "追平交接包超出固定根目录");
  }
  return {
    requirementId,
    workspacePath,
    branch: `feature/catchup-${requirementId.toLowerCase()}-${slug}`,
    baseSha,
    sessionDirectory,
    handoffPath: path.join(sessionDirectory, "current-task.md")
  };
}

async function validateSourceRepository(sourceRepository, baseSha, runGit, realpath) {
  const sourcePath = await realpath(sourceRepository).catch(() => {
    fail("SOURCE_REPOSITORY_UNAVAILABLE", "追平源码仓库不可用");
  });
  let topLevel;
  try {
    topLevel = await realpath(await runGit(["rev-parse", "--show-toplevel"], { cwd: sourcePath }));
    await runGit(["cat-file", "-e", `${baseSha}^{commit}`], { cwd: sourcePath });
  } catch (error) {
    if (error instanceof CatchupProvisioningError) throw error;
    fail("SOURCE_REPOSITORY_INVALID", "追平源码仓库或固定基线不可用");
  }
  if (topLevel !== sourcePath) {
    fail("SOURCE_REPOSITORY_TOP_LEVEL_MISMATCH", "追平源码路径不是 Git 顶层目录");
  }
  return sourcePath;
}

async function validateWorkspace({
  workspacePath,
  branch,
  baseSha,
  sourceRepository,
  requirementsRoot,
  runGit,
  realpath
}) {
  const [realRoot, realWorkspace, realSource] = await Promise.all([
    realpath(requirementsRoot),
    realpath(workspacePath).catch(() => fail("WORKSPACE_NOT_FOUND", "追平工作区不存在")),
    realpath(sourceRepository)
  ]);
  if (!isInside(realRoot, realWorkspace)) {
    fail("WORKSPACE_OUTSIDE_ROOT", "追平工作区不在固定根目录下");
  }

  try {
    const topLevel = await realpath(await runGit(["rev-parse", "--show-toplevel"], { cwd: realWorkspace }));
    if (topLevel !== realWorkspace) fail("WORKSPACE_TOP_LEVEL_MISMATCH", "追平工作区不是 Git 顶层目录");
    const actualBranch = await runGit(["branch", "--show-current"], { cwd: realWorkspace });
    if (actualBranch !== branch) fail("WORKSPACE_BRANCH_MISMATCH", "追平工作区分支与登记不一致");
    await runGit(["merge-base", "--is-ancestor", baseSha, "HEAD"], { cwd: realWorkspace });
    const [sourceCommon, workspaceCommon] = await Promise.all([
      runGit(["rev-parse", "--git-common-dir"], { cwd: realSource }),
      runGit(["rev-parse", "--git-common-dir"], { cwd: realWorkspace })
    ]);
    const [realSourceCommon, realWorkspaceCommon] = await Promise.all([
      realpath(resolveGitPath(realSource, sourceCommon)),
      realpath(resolveGitPath(realWorkspace, workspaceCommon))
    ]);
    if (realSourceCommon !== realWorkspaceCommon) {
      fail("WORKSPACE_REPOSITORY_MISMATCH", "追平工作区不属于固定源码仓库");
    }
  } catch (error) {
    if (error instanceof CatchupProvisioningError) throw error;
    fail("WORKSPACE_VALIDATION_FAILED", "追平工作区 Git 事实校验失败");
  }
}

function requirementDocumentPath(catchupDataRoot, requirement) {
  const directory = domainDirectories.get(requirement.businessDomain);
  if (!directory) return "";
  return path.resolve(
    catchupDataRoot,
    "..",
    "..",
    "APEX功能追平",
    "01-需求明细",
    directory,
    `${requirement.id}.md`
  );
}

function acceptanceLines(requirement) {
  const criteria = Array.isArray(requirement.acceptanceCriteria)
    ? requirement.acceptanceCriteria
    : [];
  if (!criteria.length) return "- [ ] 对照冻结 Demo 与需求文档完成行为还原和自测。";
  return criteria.map((item) => `- [ ] ${item.id || "AC"}：${item.text || "待核对"}`).join("\n");
}

function featureLines(requirement) {
  const features = Array.isArray(requirement.architecturePlacement?.features)
    ? requirement.architecturePlacement.features
    : [];
  return features.length
    ? features.map((item) => `- \`src/features/${item}\``).join("\n")
    : "- 先依据业务归属与仓库 L-FSD 规则定位 Feature；不得按页面名称猜测落位。";
}

function handoffPayloads(requirement, target, catchupDataRoot) {
  const requirementPath = requirementDocumentPath(catchupDataRoot, requirement);
  const currentTask = `# ${requirement.id}｜${requirement.title}\n\n## 自动创建的执行边界\n\n- 工作区：\`${target.workspacePath}\`\n- 分支：\`${target.branch}\`\n- 固定基线：\`${target.baseSha}\`\n- 需求事实：\`${requirementPath}\`\n- Jira：页面会尽力创建并回填；Jira 暂缺不得阻塞功能还原。\n\n## 本期目标\n\n${requirement.goal || requirement.nextAction || "按冻结 Demo 完成功能还原。"}\n\n## 验收标准\n\n${acceptanceLines(requirement)}\n\n## 预期业务落位\n\n${featureLines(requirement)}\n\n## 实施约束\n\n- 先读取工作区根目录 \`AGENTS.md\`，按其中要求加载对应技术栈 Skill。\n- 以冻结 Demo 最终代码和需求事实为准，还原页面、交互和业务规则；运行时不得 import \`demo/\`。\n- 正式接口契约、真实联调、Jira 完整字段、MR/Gate 与验收签字是后续待补项，不阻塞本轮编码，也不得伪报完成。\n- 只修改本需求直接涉及的文件；保持未提交、未推送，交由 Codex 复核。\n\n## 开始顺序\n\n1. 逐项核对需求 AC、Demo 路径和当前 Vue 3 实现差距。\n2. 按 L-FSD 完成功能还原并补业务规则/Mutation 副作用测试。\n3. 执行定向 Vitest、typecheck、lint、格式和构建检查，记录已证实结果与非阻塞待补项。\n`;
  const checklist = `# ${requirement.id} 验收检查表\n\n## 功能还原与静态证据\n\n${acceptanceLines(requirement)}\n- [ ] 相关业务规则或 Mutation 副作用已有 Vitest 证据。\n- [ ] typecheck、lint、格式检查、定向测试与构建结果已如实记录。\n- [ ] 已确认没有运行时 import \`demo/\`，没有复制旧 Store/EventBus。\n\n## 后续交付项（不阻塞当前功能开发）\n\n- [ ] 正式接口契约与真实 API 联调证据。\n- [ ] 已登录浏览器运行态验收。\n- [ ] Jira 交付字段、MR/CI、正式 Gate 与产品/研发/测试签字。\n`;
  const sessionState = `# ${requirement.id} 会话状态\n\n- 工作台状态：\`NOT_STARTED\`（页面开启后更新）\n- 调度 Job：\`catchup:${requirement.id}\`\n- 工作区：\`${target.workspacePath}\`\n- 分支：\`${target.branch}\`\n- 下一步：读取 \`current-task.md\` 与 \`acceptance-checklist.md\` 后开始功能还原。\n`;
  const nextThread = `# ${requirement.id} 新任务入口\n\n请先读取 \`${target.handoffPath}\` 和 \`${path.join(target.sessionDirectory, "acceptance-checklist.md")}\`，然后仅在登记的既有 worktree 继续执行。\n\n- 工作台生命周期是控制事实；功能还原、接口联调和正式验收状态必须分开报告。\n- 冻结 Demo 最终代码优先；没有代码证据时不得发明接口、权限码或业务规则。\n- 不提交、不推送；完成后由工作台回写并交给 Codex 独立复核。\n`;
  return {
    "current-task.md": currentTask,
    "acceptance-checklist.md": checklist,
    "session-state.md": sessionState,
    "next-thread-brief.md": nextThread
  };
}

async function writeMissingHandoffFiles(
  requirement,
  target,
  catchupDataRoot,
  sessionsRoot,
  realpath
) {
  const directoryExisted = await exists(target.sessionDirectory);
  await fs.mkdir(target.sessionDirectory, { recursive: true });
  const [realSessionsRoot, realSessionDirectory] = await Promise.all([
    realpath(sessionsRoot),
    realpath(target.sessionDirectory)
  ]);
  if (!isInside(realSessionsRoot, realSessionDirectory)) {
    fail("SESSION_OUTSIDE_ROOT", `${requirement.id} 的交接包真实路径超出固定根目录`);
  }
  const createdFiles = [];
  try {
    for (const [filename, content] of Object.entries(handoffPayloads(requirement, target, catchupDataRoot))) {
      const filePath = path.join(target.sessionDirectory, filename);
      try {
        await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
        createdFiles.push(filePath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
  } catch (error) {
    await removeCreatedHandoffFiles({
      directoryExisted,
      createdFiles,
      sessionDirectory: target.sessionDirectory
    });
    throw error;
  }
  return { directoryExisted, createdFiles };
}

async function removeCreatedHandoffFiles(record) {
  for (const filename of [...record.createdFiles].reverse()) {
    await fs.rm(filename, { force: true }).catch(() => {});
  }
  if (!record.directoryExisted) {
    await fs.rmdir(record.sessionDirectory).catch(() => {});
  }
}

async function rollbackCreatedProvision(record, sourceRepository, runGit) {
  if (record.createdWorktree) {
    await runGit(["worktree", "remove", "--force", record.workspacePath], {
      cwd: sourceRepository
    }).catch(() => {});
    await runGit(["branch", "-D", record.branch], { cwd: sourceRepository }).catch(() => {});
  }
  await removeCreatedHandoffFiles(record);
}

async function branchExists(sourceRepository, branch, runGit) {
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: sourceRepository
    });
    return true;
  } catch (error) {
    if (Number(error.code) === 1) return false;
    throw error;
  }
}

export async function provisionCatchupSessions({
  requirements,
  requirementIds,
  sessionRegistryFile,
  catchupDataRoot,
  sourceRepository = DEFAULT_CATCHUP_SOURCE_REPOSITORY,
  requirementsRoot = DEFAULT_CATCHUP_REQUIREMENTS_ROOT,
  sessionsRoot = DEFAULT_CATCHUP_SESSIONS_ROOT,
  baseSha = DEFAULT_CATCHUP_BASE_SHA,
  runtimeSupportSource = DEFAULT_CATCHUP_RUNTIME_SUPPORT_SOURCE,
  now = new Date().toISOString(),
  runGit = defaultRunGit,
  realpath = fs.realpath,
  mutateRegistry = mutateCatchupDispatchRegistryFile
}) {
  const requirementsById = new Map((requirements || []).map((item) => [item.id, item]));
  const requested = [...new Set(requirementIds || [])];
  const excluded = requested.find(catchupAdminExclusionReason);
  if (excluded) fail("ADMIN_DELIVERY_EXCLUDED", catchupAdminExclusionReason(excluded));
  if (!sourceRepository || !/^[0-9a-f]{40}$/i.test(baseSha)) fail("SOURCE_REPOSITORY_UNCONFIGURED", "请配置 APEX_CATCHUP_SOURCE_REPOSITORY 和完整的 APEX_CATCHUP_BASE_SHA");
  const createdRecords = [];
  await fs.mkdir(requirementsRoot, { recursive: true });
  await fs.mkdir(sessionsRoot, { recursive: true });
  const sourcePath = await validateSourceRepository(sourceRepository, baseSha, runGit, realpath);

  try {
    return await mutateRegistry({
      sessionRegistryFile,
      update: async (registry) => {
        const prepared = [];
        const reused = [];
        const failures = [];
        let changed = false;

        for (const requirementId of requested) {
          const requirement = requirementsById.get(requirementId);
          let record = null;
          try {
            if (!requirement) fail("REQUIREMENT_NOT_FOUND", `${requirementId} 不在冻结需求中`);
            const expectedTarget = catchupProvisioningTarget(requirement, {
              requirementsRoot,
              sessionsRoot,
              baseSha
            });
            const existing = registry.requirements[requirementId];
            const target = existing?.workspacePath
              ? {
                  ...expectedTarget,
                  workspacePath: existing.workspacePath,
                  branch: existing.branch,
                  baseSha: existing.baseSha,
                  handoffPath: existing.handoffPath || expectedTarget.handoffPath,
                  sessionDirectory: path.dirname(existing.handoffPath || expectedTarget.handoffPath)
                }
              : expectedTarget;
            if (target.baseSha !== baseSha) {
              fail("SESSION_BASE_MISMATCH", `${requirementId} 的登记基线与固定基线不一致`);
            }
            if (!isInside(path.resolve(sessionsRoot), path.resolve(target.sessionDirectory))) {
              fail("SESSION_OUTSIDE_ROOT", `${requirementId} 的交接包不在固定根目录下`);
            }

            let createdWorktree = false;
            if (await exists(target.workspacePath)) {
              await validateWorkspace({
                ...target,
                sourceRepository: sourcePath,
                requirementsRoot,
                runGit,
                realpath
              });
            } else {
              if (existing?.workspacePath) {
                fail("REGISTERED_WORKSPACE_MISSING", `${requirementId} 的已登记工作区不存在`);
              }
              if (await branchExists(sourcePath, target.branch, runGit)) {
                fail("BRANCH_CONFLICT", `${requirementId} 的目标分支已存在但未登记工作区`);
              }
              await fs.mkdir(path.dirname(target.workspacePath), { recursive: true });
              const [realRequirementsRoot, realWorkspaceParent] = await Promise.all([
                realpath(requirementsRoot),
                realpath(path.dirname(target.workspacePath))
              ]);
              if (!isInside(realRequirementsRoot, realWorkspaceParent)) {
                fail("WORKSPACE_OUTSIDE_ROOT", `${requirementId} 的工作区真实路径超出固定根目录`);
              }
              record = {
                ...target,
                createdWorktree: false,
                directoryExisted: true,
                createdFiles: []
              };
              await runGit([
                "worktree",
                "add",
                "-b",
                target.branch,
                target.workspacePath,
                baseSha
              ], { cwd: sourcePath });
              createdWorktree = true;
              record.createdWorktree = true;
            }

            const runtimeSupportFiles = await syncRuntimeSupportFiles(
              target.workspacePath,
              runtimeSupportSource
            );
            await markRuntimeSupportFilesLocalOnly(target.workspacePath, runGit, runtimeSupportFiles);

            const handoff = await writeMissingHandoffFiles(
              requirement,
              target,
              catchupDataRoot,
              sessionsRoot,
              realpath
            );
            record = {
              ...target,
              createdWorktree,
              directoryExisted: handoff.directoryExisted,
              createdFiles: handoff.createdFiles
            };

            if (existing?.workspacePath) {
              reused.push(requirementId);
            } else {
              registry.requirements[requirementId] = {
                ...existing,
                workspacePath: target.workspacePath,
                branch: target.branch,
                baseSha: target.baseSha,
                provider: existing?.provider || "Codex",
                status: existing?.status || "queued",
                jobId: existing?.jobId || `catchup:${requirementId}`,
                sessionId: existing?.sessionId || `catchup:${requirementId}`,
                handoffPath: target.handoffPath,
                jiraKey: existing?.jiraKey || "",
                jiraUrl: existing?.jiraUrl || "",
                jiraStatus: existing?.jiraStatus || "pending",
                jiraError: existing?.jiraError || "",
                createdAt: existing?.createdAt || now,
                updatedAt: now
              };
              prepared.push(requirementId);
              changed = true;
            }
            createdRecords.push(record);
          } catch (error) {
            if (record) await rollbackCreatedProvision(record, sourcePath, runGit);
            const failure = cleanFailure(error);
            failures.push({ requirementId, ...failure });
          }
        }

        if (changed) {
          registry.revision += 1;
          registry.updatedAt = now;
        }
        return {
          registry,
          write: changed,
          prepared,
          reused,
          failures
        };
      }
    });
  } catch (error) {
    for (const record of [...createdRecords].reverse()) {
      await rollbackCreatedProvision(record, sourcePath, runGit);
    }
    throw error;
  }
}
