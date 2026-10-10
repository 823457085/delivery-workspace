import { execFile } from "node:child_process";
import { catchupDataRoot, gitBinary, readOptionalJson } from "./config.mjs";
import path from "node:path";
import { promisify } from "node:util";
import { catchupAdminExclusionReason, catchupAdminScopeReviewReason } from "./catchup-admin-scope.mjs";

/**
 * 设计说明：合入计划是交付编排元数据，不属于 Jira 事实，也不代表 Codex 执行完成。
 * 本模块只读 Git 引用判断分支是否已进入统一目标分支，并把既有追平事实中的功能范围与验收点拼成自测说明。
 * 所有已有独立交付分支和 MR 的需求均进入逐项审计；缺少业务数据或外部服务只允许局部 N/A，
 * 页面接线、交互和可由冻结 Demo 证明的业务规则缺口仍须修复。不使用 GitLab 写接口、不修改工作树。
 */

const execFileAsync = promisify(execFile);

export const CATCHUP_MERGE_TARGET_BRANCH = process.env.APEX_CATCHUP_MERGE_TARGET_BRANCH || "";
export const CATCHUP_GITLAB_PROJECT_URL = (process.env.APEX_CATCHUP_GITLAB_PROJECT_URL || "").replace(/\/+$/, "");
export const DEFAULT_CATCHUP_MERGE_REPOSITORY = process.env.APEX_CATCHUP_MERGE_REPOSITORY || "";

const configuredPlan = readOptionalJson(process.env.APEX_CATCHUP_MERGE_PLAN_FILE || path.join(catchupDataRoot, "merge-plan.json"), []);
if (!Array.isArray(configuredPlan)) throw new Error("合入计划必须是 JSON 数组");
export const CATCHUP_MERGE_PLAN = Object.freeze(configuredPlan.map(item => {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("合入计划条目必须是 JSON 对象");
  const exclusionReason = catchupAdminExclusionReason(item.requirementId);
  return {
    ...item,
    decision: exclusionReason ? "HOLD" : item.decision || "READY",
    sourceBranch: item.sourceBranch || (item.jiraKey && item.slug ? `feature/${item.jiraKey}/${item.slug}` : ""),
    testPages: Array.isArray(item.testPages) ? item.testPages : [],
    testFocus: item.testFocus || "",
    conflictArea: item.conflictArea || "",
    verificationMode: item.verificationMode || "browser",
    decisionNote: exclusionReason || item.decisionNote || "按计划顺序合入；自测证据经审核后再交付。"
  };
}));

export function validateCatchupMergePlan(plan = CATCHUP_MERGE_PLAN) {
  const requirementIds = new Set(plan.map((item) => item.requirementId));
  const jiraKeys = new Set(plan.map((item) => item.jiraKey));
  const mrItems = plan.filter(item => item.mrIid != null);
  const mrIids = new Set(mrItems.map((item) => item.mrIid));
  const orders = plan.filter((item) => item.order != null).map((item) => item.order).sort((a, b) => a - b);
  const expectedOrders = Array.from({ length: orders.length }, (_, index) => index + 1);
  return {
    valid: plan.every(item => /^REQ-(?:CU-)?\d{3}$/.test(item.requirementId)
      && /^[A-Z][A-Z0-9_]*-\d+$/.test(item.jiraKey)
      && typeof item.sourceBranch === "string" && item.sourceBranch.trim() && !/[\s\u0000-\u001f]/.test(item.sourceBranch)
      && Number.isInteger(item.order) && item.order > 0 && ["READY", "HOLD"].includes(item.decision))
      && requirementIds.size === plan.length
      && jiraKeys.size === plan.length
      && mrIids.size === mrItems.length
      && JSON.stringify(orders) === JSON.stringify(expectedOrders),
    total: plan.length,
    ready: plan.filter((item) => item.decision === "READY").length,
    hold: plan.filter((item) => item.decision === "HOLD").length,
    orders
  };
}

function parseRefLines(output) {
  return new Map(String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/, 2);
      return [ref, sha];
    })
    .filter(([ref, sha]) => ref && sha));
}

async function runGit(repositoryPath, args, { allowExitCodeOne = false, timeout = 15_000 } = {}) {
  try {
    const result = await execFileAsync(gitBinary, ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout
    });
    return { ok: true, output: String(result.stdout || "").trim() };
  } catch (error) {
    if (allowExitCodeOne && error.code === 1) return { ok: false, output: "" };
    throw error;
  }
}

let cachedGitEvidence = null;
let cachedGitEvidenceAt = 0;

async function readGitEvidence(repositoryPath, { force = false } = {}) {
  const now = Date.now();
  if (!force && cachedGitEvidence && now - cachedGitEvidenceAt < 60_000) return cachedGitEvidence;

  const [localRefsResult, remoteRefsResult] = await Promise.all([
    runGit(repositoryPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin"]),
    runGit(repositoryPath, ["ls-remote", "--heads", "origin"], { timeout: 20_000 }).catch(() => ({ ok: false, output: "" }))
  ]);
  const localRefs = parseRefLines(localRefsResult.output);
  const remoteRefs = parseRefLines(remoteRefsResult.output);
  const targetRef = `refs/remotes/origin/${CATCHUP_MERGE_TARGET_BRANCH}`;
  const remoteTargetRef = `refs/heads/${CATCHUP_MERGE_TARGET_BRANCH}`;
  const targetLocalSha = localRefs.get(targetRef) || "";
  const targetRemoteSha = remoteRefs.get(remoteTargetRef) || "";

  const mergedBranches = new Set();
  await Promise.all(CATCHUP_MERGE_PLAN.map(async (item) => {
    const sourceRef = `refs/remotes/origin/${item.sourceBranch}`;
    const sourceSha = localRefs.get(sourceRef);
    if (!sourceSha || !targetLocalSha) return;
    const result = await runGit(
      repositoryPath,
      ["merge-base", "--is-ancestor", sourceSha, targetLocalSha],
      { allowExitCodeOne: true }
    );
    if (result.ok) mergedBranches.add(item.sourceBranch);
  }));

  cachedGitEvidence = {
    checkedAt: new Date().toISOString(),
    localRefs,
    remoteRefs,
    remoteChecked: Boolean(targetRemoteSha),
    targetLocalSha,
    targetRemoteSha,
    targetFresh: Boolean(targetRemoteSha) && targetRemoteSha === targetLocalSha,
    mergedBranches
  };
  cachedGitEvidenceAt = now;
  return cachedGitEvidence;
}

export function buildCatchupMergeDashboard(board, evidence) {
  const requirements = new Map((board?.requirements || []).map((item) => [item.id, item]));
  const items = CATCHUP_MERGE_PLAN.map((planItem) => {
    const requirement = requirements.get(planItem.requirementId) || {};
    const jiraUrl = requirement.session?.jiraUrl || "";
    const localSourceRef = `refs/remotes/origin/${planItem.sourceBranch}`;
    const remoteSourceRef = `refs/heads/${planItem.sourceBranch}`;
    const merged = planItem.alreadyMerged === true || evidence.mergedBranches.has(planItem.sourceBranch);
    const sourceRemotePresent = evidence.remoteRefs.has(remoteSourceRef);
    let status = planItem.decision === "HOLD" ? "HOLD" : "READY";
    if (planItem.decision !== "HOLD") {
      if (merged) status = "MERGED";
      else if (evidence.remoteChecked && !sourceRemotePresent) status = "VERIFY";
    }

    return {
      ...planItem,
      scopeReviewNote: planItem.alreadyMerged ? "" : catchupAdminScopeReviewReason(planItem.requirementId),
      title: requirement.title || planItem.jiraKey,
      functionSummary: [requirement.goal || requirement.title || "待补充功能范围", planItem.alreadyMerged ? "" : catchupAdminScopeReviewReason(planItem.requirementId)].filter(Boolean).join("；"),
      sessionWorkspacePath: requirement.session?.workspacePath || "",
      deliveryWorkspacePath: requirement.session?.workspacePath
        ? path.join(path.dirname(requirement.session.workspacePath), "delivery-admin")
        : "",
      acceptanceCriteria: (requirement.acceptanceCriteria || []).map((item) => ({
        id: item.id,
        text: item.text,
        url: item.url || jiraUrl
      })),
      factPages: requirement.architecturePlacement?.pages || [],
      status,
      merged,
      sourceLocalSha: evidence.localRefs.get(localSourceRef) || "",
      sourceRemoteSha: evidence.remoteRefs.get(remoteSourceRef) || "",
      mrUrl: planItem.mrUrl || (CATCHUP_GITLAB_PROJECT_URL && planItem.mrIid != null ? `${CATCHUP_GITLAB_PROJECT_URL}/-/merge_requests/${planItem.mrIid}` : ""),
      jiraUrl,
      sourceBranchUrl: sourceRemotePresent && CATCHUP_GITLAB_PROJECT_URL
        ? `${CATCHUP_GITLAB_PROJECT_URL}/-/commits/${encodeURIComponent(planItem.sourceBranch)}`
        : ""
    };
  });
  const merged = items.filter((item) => item.status === "MERGED").length;
  const holdCount = items.filter((item) => item.status === "HOLD").length;
  const readyCount = items.filter((item) => item.status === "READY").length;
  const verifyCount = items.filter((item) => item.status === "VERIFY").length;

  return {
    source: {
      checkedAt: evidence.checkedAt,
      remoteChecked: evidence.remoteChecked,
      targetFresh: evidence.targetFresh
    },
    target: {
      branch: CATCHUP_MERGE_TARGET_BRANCH,
      url: CATCHUP_GITLAB_PROJECT_URL && CATCHUP_MERGE_TARGET_BRANCH ? `${CATCHUP_GITLAB_PROJECT_URL}/-/commits/${encodeURIComponent(CATCHUP_MERGE_TARGET_BRANCH)}` : "",
      localSha: evidence.targetLocalSha,
      remoteSha: evidence.targetRemoteSha
    },
    summary: {
      total: items.length,
      merged,
      ready: readyCount,
      hold: holdCount,
      verify: verifyCount,
      progressPercent: items.length ? Math.round((merged / items.length) * 100) : 0
    },
    mergeRules: [
      "所有需求只合入使用者明确配置的目标分支。",
      "严格按序号逐项处理；每项完成自动检查、可验证的功能逻辑与样式自测和 Chrome 截图。缺少业务数据、无法安全触发失败场景或外部 API/CORS/网络失败，可逐项说明理由并标记 N/A；登录/认证截图、页面不可达或交付分支缺少页面接线不能算功能证据，须恢复登录态或修复代码后重测。单项阻塞不占并发名额，也不得阻塞其他需求。",
      "每轮最多并行 8 个独立需求 task；正常流程须先自测并由用户审核截图、点击“确认通过”，才进入合入/提交/推送阶段。特殊环境无法自测时，用户可填写原因并二次确认“例外直接合入”，仅授权指定源 SHA，保留失败与未验证记录，不计自测通过，也不自动完成 Jira；Git 冲突与远端交付校验仍须完成。Git 已包含提交、Codex turn 结束或一次测试命令成功都不等于审核通过。",
      "有冲突时先把最新目标分支合入源分支，保留目标分支已有语义，再重放本需求增量；禁止整文件覆盖。",
      "保留已配置需求的 Git、自测、审核与范围撤销历史。冻结来源可证明的页面、交互和业务规则缺口必须修复；缺少业务数据、外部服务或其他责任端运行证据时，可对对应局部用例说明理由并标记 N/A。"
    ],
    items
  };
}

export async function readCatchupMergeDashboard(board, {
  repositoryPath = process.env.APEX_CATCHUP_MERGE_REPOSITORY || DEFAULT_CATCHUP_MERGE_REPOSITORY,
  force = false
} = {}) {
  const validation = validateCatchupMergePlan();
  if (!validation.valid) {
    throw new Error("INVALID_CATCHUP_MERGE_PLAN");
  }
  if (CATCHUP_MERGE_PLAN.length && (!repositoryPath || !CATCHUP_MERGE_TARGET_BRANCH)) {
    throw new Error("请配置 APEX_CATCHUP_MERGE_REPOSITORY 和 APEX_CATCHUP_MERGE_TARGET_BRANCH");
  }
  const evidence = CATCHUP_MERGE_PLAN.length ? await readGitEvidence(repositoryPath, { force }) : {
    checkedAt: new Date().toISOString(), localRefs: new Map(), remoteRefs: new Map(), mergedBranches: new Set(),
    remoteChecked: false, targetFresh: false, targetLocalSha: "", targetRemoteSha: ""
  };
  return buildCatchupMergeDashboard(board, evidence);
}
