import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readCatchupBoard } from "./catchup-board.mjs";
import { catchupAdminExclusionReason } from "./catchup-admin-scope.mjs";
import {
  CATCHUP_EXECUTION_ACTIONS,
  normalizeCatchupExecutionState,
  readCatchupExecutionState
} from "./catchup-execution.mjs";
import {
  makeDefaultCatchupSessionRegistry,
  normalizeCatchupSessionRegistry,
  validateCatchupSessionWorkspace
} from "./catchup-sessions.mjs";

/**
 * 设计说明：追平生命周期只表达用户控制意图，本模块把每次新意图投影为可恢复的
 * Codex 控制任务。派发游标和线程标识只写入独立 Session Registry；事实源与生命
 * 周期保持只读。文件领取与回调共用进程内串行锁并原子替换 JSON，避免重复领取。
 */

export const CATCHUP_DISPATCH_JOB_STATUSES = Object.freeze([
  "dispatched",
  "running",
  "paused",
  "completed",
  "blocked",
  "cancelled"
]);

export const CATCHUP_DELIVERY_REPOSITORY_URL =
  process.env.APEX_CATCHUP_GITLAB_PROJECT_URL || "";
export const CATCHUP_DELIVERY_TARGET_BRANCH = process.env.APEX_CATCHUP_MERGE_TARGET_BRANCH || "";

const defaultCallbackUrl = `http://127.0.0.1:${process.env.DELIVERY_PORT || process.env.PORT || 5199}/api/automation/catchup/jobs/update`;
const requirementIdPattern = /^REQ-(?:CU-)?\d{3}$/;
const jobIdPattern = /^catchup:(REQ-(?:CU-)?\d{3})$/;
const jiraKeyPattern = /^[A-Z][A-Z0-9]*-\d+$/;
const englishRequirementNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const activeImplementationStatuses = new Set(["dispatching", "dispatched", "running"]);
const terminalJobStatuses = new Set(["paused", "completed", "blocked", "cancelled"]);
const controlActions = new Set(["pause", "finish"]);
const callbackStatusesByAction = Object.freeze({
  start: new Set(["dispatched", "running", "completed", "blocked", "cancelled"]),
  resume: new Set(["dispatched", "running", "completed", "blocked", "cancelled"]),
  pause: new Set(["paused", "blocked", "cancelled"]),
  finish: new Set(["completed", "blocked", "cancelled"])
});
const staleClaimMilliseconds = 2 * 60 * 60 * 1000;
const staleClientResolutionMilliseconds = 10 * 60 * 1000;
const staleRunningMilliseconds = 60 * 60 * 1000;
let registryMutationLock = Promise.resolve();

export class CatchupDispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatchupDispatchError";
    this.code = code;
  }
}

function cleanText(value, maxLength = 200) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength)
    : "";
}

function extensionSource(value = {}) {
  return value?.session && typeof value.session === "object" ? value.session : value;
}

export function normalizeCatchupDispatchRegistry(value = {}) {
  const base = normalizeCatchupSessionRegistry(value);
  const originalRequirements = value?.requirements && typeof value.requirements === "object"
    && !Array.isArray(value.requirements)
    ? value.requirements
    : {};
  base.requirements = Object.fromEntries(
    Object.entries(base.requirements).map(([requirementId, session]) => {
      const source = extensionSource(originalRequirements[requirementId]);
      return [requirementId, {
        ...session,
        claimedAction: CATCHUP_EXECUTION_ACTIONS.includes(source.claimedAction)
          ? source.claimedAction
          : "",
        claimToken: cleanText(source.claimToken, 200),
        claimedAt: cleanText(source.claimedAt, 80),
        lastDispatchedExecutionUpdatedAt: cleanText(
          source.lastDispatchedExecutionUpdatedAt,
          80
        ),
        lastDispatchedExecutionSequence: Number.isInteger(
          source.lastDispatchedExecutionSequence
        ) && source.lastDispatchedExecutionSequence >= 0
          ? source.lastDispatchedExecutionSequence
          : 0,
        result: cleanText(source.result, 4000),
        error: cleanText(source.error, 1000)
      }];
    })
  );
  return base;
}

export async function readCatchupDispatchRegistry(filename) {
  try {
    return normalizeCatchupDispatchRegistry(JSON.parse(await fs.readFile(filename, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return makeDefaultCatchupSessionRegistry();
    throw new CatchupDispatchError("SESSION_REGISTRY_UNAVAILABLE", "追平会话登记不可用");
  }
}

export async function writeCatchupDispatchRegistry(filename, registry) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporaryFile = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temporaryFile,
    JSON.stringify(normalizeCatchupDispatchRegistry(registry), null, 2),
    "utf8"
  );
  await fs.rename(temporaryFile, filename);
}

function normalizeLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 8) : 8;
}

function normalizeMaxConcurrent(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 8) : 8;
}

function isStaleDispatchClaim(session, now) {
  if (session.status !== "dispatching") return false;
  const claimedAt = Date.parse(session.claimedAt || "");
  const currentTime = Date.parse(now || "");
  return Number.isFinite(claimedAt)
    && Number.isFinite(currentTime)
    && currentTime - claimedAt > staleClaimMilliseconds;
}

function isStaleClientThreadResolution(session, now) {
  if (session.status !== "dispatched" || !session.clientThreadId || session.threadId) return false;
  const currentTime = Date.parse(now || "");
  const activityTimes = [session.updatedAt, session.claimedAt]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return Number.isFinite(currentTime)
    && activityTimes.length > 0
    && currentTime - Math.max(...activityTimes) > staleClientResolutionMilliseconds;
}

function isStaleRunningLease(session, now) {
  if (session.status !== "running" || !session.threadId) return false;
  const currentTime = Date.parse(now || "");
  const activityTime = Date.parse(session.updatedAt || session.claimedAt || "");
  return Number.isFinite(currentTime)
    && Number.isFinite(activityTime)
    && currentTime - activityTime > staleRunningMilliseconds;
}

function isStaleSameEventClaim(session, now) {
  return isStaleDispatchClaim(session, now)
    || isStaleClientThreadResolution(session, now);
}

function isClaimableExecutionEvent(execution, session, now) {
  if (!CATCHUP_EXECUTION_ACTIONS.includes(execution.lastAction)) return false;
  if (session.status === "dispatching" && !isStaleDispatchClaim(session, now)) return false;
  if (execution.sequence > 0) {
    if (execution.sequence > session.lastDispatchedExecutionSequence) return true;
    if (execution.sequence < session.lastDispatchedExecutionSequence) return false;
    return isStaleSameEventClaim(session, now);
  }
  if (!execution.updatedAt) return false;
  if (!session.lastDispatchedExecutionUpdatedAt) return true;
  const executionTime = Date.parse(execution.updatedAt);
  const dispatchedTime = Date.parse(session.lastDispatchedExecutionUpdatedAt);
  if (Number.isFinite(executionTime) && Number.isFinite(dispatchedTime)) {
    return executionTime > dispatchedTime
      || (executionTime === dispatchedTime && isStaleSameEventClaim(session, now));
  }
  return execution.updatedAt > session.lastDispatchedExecutionUpdatedAt
    || (
      execution.updatedAt === session.lastDispatchedExecutionUpdatedAt
      && isStaleSameEventClaim(session, now)
    );
}

function callbackInstruction(jobId, claimToken, status, callbackUrl) {
  return [
    "回调是本轮最后一个必做操作，必须在给出最终回复前执行并确认响应成功。",
    `完成本次控制动作后，POST \`${callbackUrl}\`。`,
    `JSON 至少包含 \`{"id":"${jobId}","claimToken":"${claimToken}","status":"${status}"}\`；`,
    "result 使用简洁字符串；失败或仍有功能 AC、代码、业务规则测试未完成时使用 status=blocked 并填写 error，不能仅因本轮 Codex turn 结束就回 completed；",
    "若当前回调能取得会话标识，同时回传 threadId、hostId、clientThreadId。"
  ].join("");
}

/**
 * 设计说明：内部追平分支服务于长期 worktree，不能直接改名或作为 MR 源分支；
 * 交付规格只从已登记 Jira 与内部英文 slug 派生，并要求目标 task 在隔离 worktree
 * 中生成干净交付分支，避免基线文档和其他需求进入 MR。
 */
export function makeCatchupDeliverySpec(requirement, session) {
  const jiraKey = cleanText(session.jiraKey, 100).toUpperCase();
  const internalBranch = cleanText(session.branch, 300);
  const prefix = `feature/catchup-${String(requirement.id || "").toLowerCase()}-`;
  const englishName = internalBranch.startsWith(prefix)
    ? internalBranch.slice(prefix.length)
    : "";
  const errors = [];
  if (!jiraKeyPattern.test(jiraKey)) errors.push("Jira 号未登记或格式无效");
  if (!englishRequirementNamePattern.test(englishName)) {
    errors.push("内部追平分支未包含有效英文需求名称");
  }
  const branch = errors.length === 0 ? `feature/${jiraKey}/${englishName}` : "";
  return {
    ready: errors.length === 0,
    error: errors.join("；"),
    repositoryUrl: CATCHUP_DELIVERY_REPOSITORY_URL,
    targetBranch: CATCHUP_DELIVERY_TARGET_BRANCH,
    branch,
    englishName,
    workspacePath: path.join(path.dirname(session.workspacePath), "delivery-admin")
  };
}

function deliveryInstruction(requirement, session) {
  const delivery = makeCatchupDeliverySpec(requirement, session);
  if (!delivery.ready) {
    return `交付配置校验失败：${delivery.error}。不得猜测分支名、提交、来源作者或 MR；功能检查完成后必须回调 blocked 并写明该错误。`;
  }
  const commitTitle = `feat(${session.jiraKey}): ${requirement.title || "实现 APEX 追平需求"}`;
  const mrTitle = `[${session.jiraKey}][APEX 重构追平] ${requirement.title || "未命名需求"}`;
  return [
    "提交代码、推送分支和创建/复用 MR 必须由本 job.id 对应的同一个长期 Codex task 在当前会话中完成；调度器只负责原样投递本 prompt 和记录回调，禁止另建交付 task，也禁止由调度器进程代执行 Git/GitLab 交付。",
    "本阶段的交付目标是完成代码层面的重构还原，并把 APEX 最新基线 master / 冻结 Demo 中对应的接口与交互链路接入当前代码；达到该代码目标后必须形成独立远端提交和 MR，供用户后续在合并阶段统一验证。不得只做核查、报告、自测或建议后停止。",
    "自动化测试、全量静态检查、浏览器自测、真实后端联调或验收尚未完成，均不得作为拒绝提交、推送或创建 MR 的理由；能执行的检查仍应执行并如实记录，失败或未执行项写入提交正文和 MR 的已知限制/待验证项。只有代码重构或 Demo 接口链路本身尚未完成时，才因功能缺口回调 blocked。",
    "同一需求若只有部分子范围能由 APEX 最新基线 master / 冻结 Demo 真实证明，必须先完成并交付这些可证明子范围；其余缺少契约或责任端证据的 AC 写入提交正文和 MR 的待验证项/已知限制，不得因此阻止已完成代码的提交、推送与 MR。只有完全没有任何可核验的代码落点或现有实现时，才可不生成提交并回调 blocked。",
    "若核心业务动作属于外部 App/BFF/POS，但事实源明确当前 Admin 接口契约应保持不变，必须优先交付可核验的 Admin 契约子范围，例如补齐接口类型、mapper 或围绕现有 URL、参数、编码、payload、返回结构与缓存失效的窄回归测试；这属于真实代码交付，MR 中必须明确外部 AC 尚未完成。禁止新增占位页面、空提交，或凭空发明接口、字段和业务状态。",
    "公共组件复用规则：实现前必须先检查本仓库、同业务域 `_shared/` 和 `src/shared` 的既有公共组件；存在满足需求的组件时必须优先复用，禁止重复实现同类基础 UI、交互或工具。仅当能力已经稳定服务于同域多个 Feature 时才下沉到 `_shared/`，或稳定跨业务域复用时才下沉到 `shared/`；单一需求或单 Feature 的实现必须留在 Feature 内，不得为了形式上的“公共组件”强行抽象。",
    `交付仓库固定为 \`${delivery.repositoryUrl}\`，目标分支固定为 \`${delivery.targetBranch}\`，交付分支固定为 \`${delivery.branch}\`；需求名称使用英文 kebab-case。先核对 origin 与远端目标分支真实存在，禁止推送到其他仓库或目标分支。`,
    `既有追平 worktree 和内部分支 \`${session.branch}\` 必须保留。完成代码目标后，只暂存本需求代码、运行必需配置和自动化测试，禁止使用 git add . 或 git add -A；\`.env.dev\`、\`.env.development\`、\`env.d.ts\`、\`vite.config.ts\` 由调度器同步用于本地运行，属于不提交的运行支持文件，不得因其状态阻塞自测，也不得提交。禁止提交需求文档、截图、报告、Excel、日志、构建产物、临时文件或 zh-CN.json。`,
    `提交标题使用 \`${commitTitle}\`，正文必须写清需求目标、原 APEX 来源、变更点、影响范围、已执行检查和待验证项。原 APEX 仓库分支、提交 SHA 和提交人应从 Git 历史或追平证据中尽量核验；无法核验时明确写“未核验”且不得编造，但不因此阻止本次代码交付。`,
    `从最新 \`origin/${delivery.targetBranch}\` 创建或唯一复用隔离交付 worktree \`${delivery.workspacePath}\` 及分支 \`${delivery.branch}\`，只迁移本需求提交；不得切换登记 worktree 的内部分支，不得让内部追平基线、Demo、需求资料或其他需求差异进入 MR。分支或 worktree 已存在但无法唯一证明属于本 Jira 时回调 blocked，不得覆盖或删除。`,
    "在交付 worktree 复核最终 diff，尽量执行 git diff --check、定向测试和仓库要求的静态检查；按实际结果记录。检查失败或环境不具备时继续提交并在 MR 标明待验证，不得把检查结果伪造为通过。",
    `推送后核验远端分支 SHA 与本地 HEAD 一致，再创建或唯一复用源分支 \`${delivery.branch}\` → 目标分支 \`${delivery.targetBranch}\` 的 GitLab MR；MR 标题使用 \`${mrTitle}\`，不得自动合并。`,
    "MR 描述必须详细写清：原 APEX 需求与业务背景；可核验的原 APEX 分支、提交 SHA、提交人；本次实现目标；改动文件与行为；Demo 接口/交互追平情况；影响范围；已执行检查；待验证项；已知限制/依赖。存在需求文档时写明文档名称、来源及关键 AC，没有需求文档属于正常场景并省略该段。",
    "只有远端 SHA 回读成功且 MR URL、源分支、目标分支、标题和描述均核验无误，才可回调 completed；推送、GitLab 鉴权、MR 创建或回读失败时保留现场并回调 blocked，禁止把尝试过当作已完成。"
  ].join("\n");
}

function implementationPrompt(requirement, session, action, claimToken, callbackUrl) {
  const jobId = `catchup:${requirement.id}`;
  const jira = session.jiraKey || session.jiraUrl
    ? `${session.jiraKey || "Jira"}${session.jiraUrl ? ` ${session.jiraUrl}` : ""}`
    : "未登记 Jira（不阻塞功能还原）";
  const actionInstruction = action === "resume"
    ? "继续此前暂停的功能还原；先检查当前未提交改动和已有结果，不覆盖或丢弃它们。"
    : "开始本需求的功能还原，严格按任务包和验收清单逐项实现。";
  const clientResolutionInstruction = session.status === "dispatched"
    && session.clientThreadId
    && !session.threadId
    ? `这是 clientThreadId \`${session.clientThreadId}\` 的解析重领；必须先通过 list_threads 唯一匹配并续跑既有 Codex task，绝不创建新 task。`
    : "";
  return [
    `执行 APEX 重构追平需求 \`${requirement.id}\`：${requirement.title || "未命名需求"}。`,
    `控制动作：${action}。${actionInstruction}`,
    ...(clientResolutionInstruction ? [clientResolutionInstruction] : []),
    `必须在既有 worktree \`${session.workspacePath}\` 开发；当前分支必须保持 \`${session.branch}\`，基线提交为 \`${session.baseSha}\`。开发阶段不得切换或删除该登记 worktree/分支。`,
    `先完整读取交接任务包 \`${session.handoffPath || "未登记"}\` 及同目录验收清单。Jira：${jira}。`,
    "读取并遵守该工作区中的 AGENTS.md，按任务涉及的技术栈加载对应 skills；只处理本需求范围。",
    "用户已授权在本需求范围内执行常规本地读写、依赖安装、测试、构建、本地服务以及下述条件式 GitLab 交付，无需再次等待批准；不得修改 Jira、自动合并 MR 或扩大到其他需求。",
    deliveryInstruction(requirement, session),
    callbackInstruction(jobId, claimToken, "completed", callbackUrl)
  ].join("\n\n");
}

function controlPrompt(requirement, session, action, claimToken, callbackUrl) {
  const jobId = `catchup:${requirement.id}`;
  const taskInstruction = session.threadId || session.clientThreadId
    ? "此控制 job 只允许续跑其携带的既有 Codex task，绝不授权创建新 task。"
    : "此控制 job 未携带 task 标识：必须先通过 list_threads 按需求、job 和 workspace 唯一匹配既有 Codex task；无法唯一匹配时回调 blocked，绝不创建新 task。";
  if (action === "pause") {
    return [
      `暂停控制：追平需求 \`${requirement.id}\`（${requirement.title || "未命名需求"}）。`,
      taskInstruction,
      `在既有 worktree \`${session.workspacePath}\` 的安全边界停止后续实现步骤；保留当前改动和上下文，不回滚、不提交、不推送。`,
      "这只是暂停后续执行，不声称强制终止正在运行的工具，也不代表功能验收完成。",
      callbackInstruction(jobId, claimToken, "paused", callbackUrl)
    ].join("\n\n");
  }
  return [
    `结束控制：追平需求 \`${requirement.id}\`（${requirement.title || "未命名需求"}）。`,
    taskInstruction,
    `停止在既有 worktree \`${session.workspacePath}\` 中扩大功能范围，保留当前文件和会话上下文；先核对既有完成证据，再按交付门禁决定执行或阻断。`,
    deliveryInstruction(requirement, session),
    callbackInstruction(jobId, claimToken, "completed", callbackUrl)
  ].join("\n\n");
}

function makeJob(requirement, execution, session, claimToken, callbackUrl) {
  const action = execution.lastAction;
  const id = `catchup:${requirement.id}`;
  const delivery = makeCatchupDeliverySpec(requirement, session);
  return {
    id,
    source: "catchup",
    requirementId: requirement.id,
    issueKey: session.jiraKey || requirement.id,
    issueUrl: session.jiraUrl || "",
    title: `${requirement.id} 重构追平 · ${requirement.title || "未命名需求"}`.slice(0, 140),
    summary: requirement.title || "",
    category: "catchup",
    categoryLabel: "重构追平",
    status: "dispatching",
    action,
    claimToken,
    workspacePath: session.workspacePath,
    branch: session.branch,
    baseSha: session.baseSha,
    handoffPath: session.handoffPath,
    jiraKey: session.jiraKey,
    jiraUrl: session.jiraUrl,
    threadId: session.threadId,
    hostId: session.hostId,
    clientThreadId: session.clientThreadId,
    delivery,
    prompt: ["start", "resume"].includes(action)
      ? implementationPrompt(requirement, session, action, claimToken, callbackUrl)
      : controlPrompt(requirement, session, action, claimToken, callbackUrl)
  };
}

function dispatchCandidates(board, execution, registry, now) {
  return (board?.requirements || [])
    .map((requirement, index) => ({
      requirement,
      index,
      session: registry.requirements[requirement.id],
      event: execution.requirements[requirement.id]
    }))
    .filter(({ requirement, session, event }) => (
      requirementIdPattern.test(requirement.id || "")
      && !catchupAdminExclusionReason(requirement.id)
      && session?.workspacePath
      && event
      && isClaimableExecutionEvent(event, session, now)
    ))
    .sort((left, right) => (
      Number(!controlActions.has(left.event.lastAction))
      - Number(!controlActions.has(right.event.lastAction))
      || left.index - right.index
    ));
}

export function claimCatchupDispatchJob(
  board,
  executionState,
  registry,
  {
    limit = 8,
    maxConcurrent = 8,
    now = new Date().toISOString(),
    callbackUrl = defaultCallbackUrl,
    createClaimToken = randomUUID,
    excludedRequirementIds = new Set()
  } = {}
) {
  const execution = normalizeCatchupExecutionState(executionState);
  const nextRegistry = normalizeCatchupDispatchRegistry(registry);
  const jobs = [];
  const batchLimit = normalizeLimit(limit);
  const concurrencyLimit = normalizeMaxConcurrent(maxConcurrent);
  let activeImplementations = Object.entries(nextRegistry.requirements)
    .filter(([requirementId, session]) => (
      !catchupAdminExclusionReason(requirementId)
      && activeImplementationStatuses.has(session.status) && !isStaleRunningLease(session, now)
    ))
    .length;

  for (const { requirement, session, event } of dispatchCandidates(
    board,
    execution,
    nextRegistry,
    now
  )) {
    if (jobs.length >= batchLimit) break;
    if (excludedRequirementIds.has(requirement.id)) continue;
    const isControl = controlActions.has(event.lastAction);
    const alreadyActive = activeImplementationStatuses.has(session.status)
      && !isStaleRunningLease(session, now);
    if (!isControl && !alreadyActive && activeImplementations >= concurrencyLimit) continue;

    const claimToken = cleanText(createClaimToken(), 200);
    if (!claimToken) throw new CatchupDispatchError("CLAIM_TOKEN_UNAVAILABLE", "无法生成追平领取令牌");
    const job = makeJob(
      requirement,
      event,
      session,
      claimToken,
      cleanText(callbackUrl, 1000)
    );
    nextRegistry.requirements[requirement.id] = {
      ...session,
      jobId: job.id,
      status: "dispatching",
      claimedAction: event.lastAction,
      claimToken,
      claimedAt: now,
      lastDispatchedExecutionUpdatedAt: event.updatedAt,
      lastDispatchedExecutionSequence: event.sequence,
      updatedAt: now,
      error: ""
    };
    jobs.push(job);
    if (!isControl && !alreadyActive) activeImplementations += 1;
  }

  if (jobs.length > 0) {
    nextRegistry.revision += 1;
    nextRegistry.updatedAt = now;
  }
  return { jobs, registry: nextRegistry };
}

function withRegistryMutation(operation) {
  const result = registryMutationLock.then(operation);
  registryMutationLock = result.catch(() => {});
  return result;
}

export function mutateCatchupDispatchRegistryFile({
  sessionRegistryFile,
  update
}) {
  return withRegistryMutation(async () => {
    const registry = await readCatchupDispatchRegistry(sessionRegistryFile);
    const result = await update(registry);
    if (result.write !== false) {
      await writeCatchupDispatchRegistry(sessionRegistryFile, result.registry);
    }
    return result;
  });
}

export function claimCatchupDispatchJobFromFiles({
  catchupDataRoot,
  executionStateFile,
  sessionRegistryFile,
  limit = 8,
  maxConcurrent = 8,
  now = new Date().toISOString(),
  callbackUrl = defaultCallbackUrl,
  readBoard = readCatchupBoard,
  readExecution = readCatchupExecutionState,
  validateWorkspace = validateCatchupSessionWorkspace,
  createClaimToken = randomUUID
}) {
  return withRegistryMutation(async () => {
    const [board, executionState, registry] = await Promise.all([
      readBoard(catchupDataRoot),
      readExecution(executionStateFile),
      readCatchupDispatchRegistry(sessionRegistryFile)
    ]);
    const normalizedExecution = normalizeCatchupExecutionState(executionState);
    const validatedRegistry = normalizeCatchupDispatchRegistry(registry);
    const excludedRequirementIds = new Set();
    const blocked = [];
    let validationChanged = false;
    let validatedCandidateCount = 0;
    const validationLimit = normalizeLimit(limit);

    for (const { requirement } of dispatchCandidates(
      board,
      normalizedExecution,
      validatedRegistry,
      now
    )) {
      if (validatedCandidateCount >= validationLimit) break;
      try {
        await validateWorkspace(validatedRegistry, requirement.id);
        validatedCandidateCount += 1;
      } catch (error) {
        const session = validatedRegistry.requirements[requirement.id];
        const message = cleanText(error?.message || "追平需求工作区校验失败", 1000);
        validatedRegistry.requirements[requirement.id] = {
          ...session,
          status: "blocked",
          error: message,
          updatedAt: now
        };
        excludedRequirementIds.add(requirement.id);
        blocked.push({ requirementId: requirement.id, error: message });
        validationChanged = true;
      }
    }

    const result = claimCatchupDispatchJob(board, normalizedExecution, validatedRegistry, {
      limit,
      maxConcurrent,
      now,
      callbackUrl,
      createClaimToken,
      excludedRequirementIds
    });
    if (validationChanged && result.jobs.length === 0) {
      result.registry.revision += 1;
      result.registry.updatedAt = now;
    }
    if (result.jobs.length > 0 || validationChanged) {
      await writeCatchupDispatchRegistry(sessionRegistryFile, result.registry);
    }
    return { jobs: result.jobs, blocked, revision: result.registry.revision };
  });
}

function fail(code, message) {
  throw new CatchupDispatchError(code, message);
}

export function applyCatchupDispatchCallback(
  registry,
  body,
  now = new Date().toISOString()
) {
  const match = jobIdPattern.exec(String(body?.id || ""));
  if (!match) fail("INVALID_CATCHUP_JOB_ID", "追平调度任务 ID 无效");
  if (!CATCHUP_DISPATCH_JOB_STATUSES.includes(body.status)) {
    fail("INVALID_CATCHUP_JOB_STATUS", "追平调度任务状态无效");
  }

  const nextRegistry = normalizeCatchupDispatchRegistry(registry);
  const requirementId = match[1];
  const exclusionReason = catchupAdminExclusionReason(requirementId);
  if (exclusionReason) fail("CATCHUP_JOB_ADMIN_EXCLUDED", exclusionReason);
  const session = nextRegistry.requirements[requirementId];
  if (!session || session.jobId !== body.id) {
    fail("CATCHUP_JOB_NOT_FOUND", "追平调度任务不存在");
  }
  if (!body.claimToken || body.claimToken !== session.claimToken) {
    fail("CATCHUP_JOB_CLAIM_MISMATCH", "追平调度任务领取令牌已失效");
  }
  if (terminalJobStatuses.has(session.status) && body.status !== session.status) {
    fail("CATCHUP_JOB_ALREADY_TERMINAL", "追平调度任务已进入终态");
  }
  if (!callbackStatusesByAction[session.claimedAction]?.has(body.status)) {
    fail("CATCHUP_JOB_ACTION_STATUS_MISMATCH", "追平调度任务状态与控制动作不匹配");
  }

  const callbackThreadId = cleanText(body.threadId, 200);
  const callbackClientThreadId = cleanText(body.clientThreadId, 200);
  if (session.threadId && callbackThreadId && callbackThreadId !== session.threadId) {
    fail("CATCHUP_JOB_THREAD_MISMATCH", "追平调度任务线程不可重新绑定");
  }
  if (
    session.clientThreadId
    && callbackClientThreadId
    && callbackClientThreadId !== session.clientThreadId
  ) {
    fail("CATCHUP_JOB_CLIENT_THREAD_MISMATCH", "追平调度任务客户端线程不可重新绑定");
  }
  if (body.status === "dispatched" && !(callbackClientThreadId || session.clientThreadId)) {
    fail("CATCHUP_JOB_CLIENT_THREAD_REQUIRED", "dispatched 状态必须提供客户端线程标识");
  }
  if (body.status === "running" && !(callbackThreadId || session.threadId)) {
    fail("CATCHUP_JOB_THREAD_REQUIRED", "running 状态必须提供线程标识");
  }

  const nextSession = {
    ...session,
    status: body.status,
    result: typeof body.result === "string"
      ? cleanText(body.result, 4000)
      : (body.result && typeof body.result === "object"
        ? cleanText(JSON.stringify(body.result), 4000)
        : session.result),
    error: typeof body.error === "string" ? cleanText(body.error, 1000) : session.error,
    updatedAt: now
  };
  for (const [field, value] of [
    ["threadId", callbackThreadId],
    ["hostId", cleanText(body.hostId, 200)],
    ["clientThreadId", callbackClientThreadId]
  ]) {
    if (value) nextSession[field] = value;
  }
  nextRegistry.requirements[requirementId] = nextSession;
  nextRegistry.revision += 1;
  nextRegistry.updatedAt = now;
  return {
    job: {
      id: body.id,
      requirementId,
      action: nextSession.claimedAction,
      claimToken: nextSession.claimToken,
      status: nextSession.status,
      threadId: nextSession.threadId,
      hostId: nextSession.hostId,
      clientThreadId: nextSession.clientThreadId,
      result: nextSession.result,
      error: nextSession.error,
      updatedAt: now
    },
    registry: nextRegistry
  };
}

export function updateCatchupDispatchJobFile({
  sessionRegistryFile,
  body,
  now = new Date().toISOString()
}) {
  return withRegistryMutation(async () => {
    const registry = await readCatchupDispatchRegistry(sessionRegistryFile);
    const result = applyCatchupDispatchCallback(registry, body, now);
    await writeCatchupDispatchRegistry(sessionRegistryFile, result.registry);
    return { job: result.job, revision: result.registry.revision };
  });
}
