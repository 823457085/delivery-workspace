import path from "node:path";
import { isJiraSubtask } from "../../shared/automation-policy.mjs";

import { skillsRoot as codexSkillsRoot } from "./config.mjs";

export const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
  enabled: false,
  dailyTime: "09:00",
  dailyTimes: Object.freeze(["09:00", "19:00"]),
  autoSplitLongTasks: false,
  maxTaskSpanDays: 3,
  autoCloseDueSplitTasks: false,
  autoCreateCodex: false,
  autoTransitionJira: false,
  autoCreateMergeRequest: false,
  maxDispatchPerRun: 0,
  startStatus: "进行中",
  completedStatus: "已完成",
  runtimeEnvironment: process.env.DELIVERY_RUNTIME_ENVIRONMENT || "development",
  runtimeCommand: process.env.DELIVERY_RUNTIME_COMMAND || "pnpm dev",
  browser: "Chrome",
  loginKeychainService: process.env.DELIVERY_LOGIN_KEYCHAIN_SERVICE || "",
  loginKeychainAccount: process.env.DELIVERY_LOGIN_KEYCHAIN_ACCOUNT || "",
  targetBranch: process.env.DELIVERY_TARGET_BRANCH || "main",
  reviewer: process.env.DELIVERY_REVIEWER || "",
  repositoryUrl: process.env.DELIVERY_REPOSITORY_URL || ""
});

const terminalJobStatuses = new Set(["completed", "review", "skipped"]);

export function localDateIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function sanitizeAutomationSettings(value = {}, current = DEFAULT_AUTOMATION_SETTINGS) {
  const validTime = (item) => /^([01]\d|2[0-3]):[0-5]\d$/.test(item || "");
  const currentDailyTimes = Array.isArray(current.dailyTimes) && current.dailyTimes.some(validTime)
    ? current.dailyTimes.filter(validTime)
    : [current.dailyTime || DEFAULT_AUTOMATION_SETTINGS.dailyTime].filter(validTime);
  const requestedDailyTimes = Array.isArray(value.dailyTimes)
    ? value.dailyTimes
    : [validTime(value.dailyTime) ? value.dailyTime : currentDailyTimes[0], ...currentDailyTimes.slice(1)];
  const dailyTimes = [...new Set(requestedDailyTimes.filter(validTime))].sort();
  if (dailyTimes.length === 0) dailyTimes.push(...currentDailyTimes);
  const dailyTime = dailyTimes[0];
  const textValue = (key, fallback, maxLength = 80) => {
    if (typeof value[key] !== "string") return fallback;
    return value[key].replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength) || fallback;
  };

  const rawDispatchLimit = Object.hasOwn(value, "maxDispatchPerRun")
    ? Number(value.maxDispatchPerRun)
    : Number(current.maxDispatchPerRun);
  const maxDispatchPerRun = Number.isFinite(rawDispatchLimit) && rawDispatchLimit >= 0
    ? Math.floor(rawDispatchLimit)
    : current.maxDispatchPerRun;
  const rawTaskSpanDays = Object.hasOwn(value, "maxTaskSpanDays")
    ? Number(value.maxTaskSpanDays)
    : Number(current.maxTaskSpanDays || DEFAULT_AUTOMATION_SETTINGS.maxTaskSpanDays);
  const maxTaskSpanDays = Number.isFinite(rawTaskSpanDays) && rawTaskSpanDays >= 1
    ? Math.min(Math.floor(rawTaskSpanDays), 30)
    : current.maxTaskSpanDays || DEFAULT_AUTOMATION_SETTINGS.maxTaskSpanDays;

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
    dailyTime,
    dailyTimes,
    autoSplitLongTasks: typeof value.autoSplitLongTasks === "boolean"
      ? value.autoSplitLongTasks
      : Boolean(current.autoSplitLongTasks),
    maxTaskSpanDays,
    autoCloseDueSplitTasks: typeof value.autoCloseDueSplitTasks === "boolean"
      ? value.autoCloseDueSplitTasks
      : Boolean(current.autoCloseDueSplitTasks),
    autoCreateCodex: typeof value.autoCreateCodex === "boolean"
      ? value.autoCreateCodex
      : current.autoCreateCodex,
    autoTransitionJira: typeof value.autoTransitionJira === "boolean"
      ? value.autoTransitionJira
      : current.autoTransitionJira,
    autoCreateMergeRequest: typeof value.autoCreateMergeRequest === "boolean"
      ? value.autoCreateMergeRequest
      : current.autoCreateMergeRequest,
    maxDispatchPerRun,
    startStatus: textValue("startStatus", current.startStatus, 40),
    completedStatus: textValue("completedStatus", current.completedStatus, 40),
    runtimeEnvironment: textValue("runtimeEnvironment", current.runtimeEnvironment, 40),
    runtimeCommand: textValue("runtimeCommand", current.runtimeCommand, 120),
    browser: textValue("browser", current.browser, 40),
    loginKeychainService: textValue("loginKeychainService", current.loginKeychainService, 160),
    loginKeychainAccount: textValue("loginKeychainAccount", current.loginKeychainAccount, 80),
    targetBranch: textValue("targetBranch", current.targetBranch, 100),
    reviewer: textValue("reviewer", current.reviewer, 80),
    repositoryUrl: textValue("repositoryUrl", current.repositoryUrl, 300)
  };
}

export function getNextAutomationRun(settings, now = new Date()) {
  if (!settings.enabled) return null;
  const times = settings.dailyTimes || [settings.dailyTime];
  for (let offset = 0; offset < 14; offset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    if ([0, 6].includes(day.getDay())) continue;
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number);
      const candidate = new Date(day);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate > now) return candidate.toISOString();
    }
  }
  return null;
}

export function getDueAutomationSlot(settings, lastScheduledSlot = "", now = new Date()) {
  if (!settings.enabled) return "";
  if ([0, 6].includes(now.getDay())) return "";
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const dueTime = (settings.dailyTimes || [settings.dailyTime])
    .filter((time) => time <= currentTime)
    .at(-1);
  if (!dueTime) return "";

  const slot = `${localDateIso(now)} ${dueTime}`;
  return slot > lastScheduledSlot ? slot : "";
}

export function resolveDispatchLimit(requestedLimit, configuredLimit) {
  const normalize = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  };
  const requested = normalize(requestedLimit);
  const configured = normalize(configuredLimit);

  if (requested && configured) return Math.min(requested, configured);
  return requested || configured;
}

export function isIssueDone(issue) {
  const text = `${issue?.status || ""} ${issue?.statusCategory || ""}`.toLowerCase();
  return /已完成|完成|关闭|done|closed/.test(text);
}

export function isIssueTodo(issue) {
  const text = `${issue?.status || ""} ${issue?.statusCategory || ""}`.toLowerCase();
  return /待开始|待办|open|to do|todo/.test(text);
}

export const THREE_DAY_SPLIT_LABEL = "delivery-3-day-split";

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateIso(value) {
  return value.toISOString().slice(0, 10);
}

export function buildTaskDateSegments(issue, maxDays = 3) {
  if (!issue || issue.parent?.key || isIssueDone(issue)) return [];
  if (!/^(?:任务|task)$/i.test(String(issue.issueType || "").trim())) return [];

  const start = parseIsoDate(issue.startDate);
  const end = parseIsoDate(issue.endDate || issue.dueDate);
  const span = Math.max(1, Math.min(Math.floor(Number(maxDays) || 3), 30));
  if (!start || !end || end < start) return [];

  const segments = [];
  let cursor = new Date(start);
  let workdayCount = 0;
  while (cursor <= end) {
    if ([0, 6].includes(cursor.getUTCDay())) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      continue;
    }
    const segmentStart = new Date(cursor);
    let segmentEnd = new Date(cursor);
    let segmentDays = 1;
    workdayCount += 1;
    while (segmentDays < span) {
      const next = new Date(segmentEnd);
      next.setUTCDate(next.getUTCDate() + 1);
      if (next > end || [0, 6].includes(next.getUTCDay())) break;
      segmentEnd = next;
      segmentDays += 1;
      workdayCount += 1;
    }
    segments.push({
      index: segments.length + 1,
      total: 0,
      startDate: dateIso(segmentStart),
      endDate: dateIso(segmentEnd)
    });
    cursor = new Date(segmentEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (workdayCount <= span) return [];
  return segments.map((segment) => ({ ...segment, total: segments.length }));
}

export function buildRequirementSegmentTitles(issue, total) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (count === 0) return [];

  const summary = String(issue?.summary || "").trim();
  const modulePrefix = summary.match(/^【[^】]+】/)?.[0] || "";
  const object = summary
    .replace(/^【[^】]+】/, "")
    .replace(/^(?:完成|实现|编写|开发)\s*/, "")
    .replace(/(?:前端)?开发交付$/, "")
    .trim() || "需求";
  const description = String(issue?.description || "");
  const scopeBlock = description.match(/h2\.\s*前端范围([\s\S]*?)(?=\nh2\.|$)/)?.[1] || "";
  const scopeItems = scopeBlock
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:#|\*|\d+[.、])\s*(.+?)\s*$/)?.[1] || "")
    .map((line) => line.replace(/[。；;]+$/, "").trim())
    .filter(Boolean);
  const withModule = (text) => `${modulePrefix}${text}`.slice(0, 240);
  const withObjectSuffix = (suffix) => `${object}${/[A-Za-z0-9]$/.test(object) ? " " : ""}${suffix}`;

  if (count === 1) return [withModule(`完成 ${object}`)];
  const titles = [withModule(`编写 ${withObjectSuffix("技术方案")}`)];
  const functionalCount = Math.max(0, count - 2);
  for (let index = 0; index < functionalCount; index += 1) {
    const scope = scopeItems[index];
    if (scope) {
      titles.push(withModule(/^(?:实现|完成|接入|迁移|移除|验证|支持|补齐)/.test(scope) ? scope : `完成 ${scope}`));
    } else {
      titles.push(withModule(`实现 ${object}第 ${index + 1} 项功能`));
    }
  }
  titles.push(withModule(`完成 ${withObjectSuffix("联调自测")}`));
  return titles;
}

export function isThreeDaySplitTask(issue) {
  return (Array.isArray(issue?.labels) && issue.labels.includes(THREE_DAY_SPLIT_LABEL))
    || /^【\d+天进度切片 \d+\/\d+】/.test(String(issue?.summary || ""))
    || String(issue?.description || "").includes(`${THREE_DAY_SPLIT_LABEL}/delivery-segment-`);
}

/**
 * 设计说明：schedule-group 是人工确认的跨日排期边界，schedule-slice 是其中可按日流转的子任务。
 * 只识别这两个显式标识，避免把普通 Jira 或仅有日期的任务误归为自动排期。
 */
export function isScheduledIssue(issue) {
  return /^schedule-group:\s*\S+/m.test(String(issue?.description || ""));
}

export function isScheduledSliceIssue(issue) {
  const description = String(issue?.description || "");
  return isScheduledIssue(issue) && /^schedule-slice:\s*\d+/m.test(description);
}

export function shouldCompleteScheduledSlice(issue, now = new Date()) {
  if (!isScheduledSliceIssue(issue) || isIssueDone(issue)) return false;
  const endDate = issue?.endDate || issue?.dueDate;
  const today = localDateIso(now);
  if (!dateReached(endDate, today)) return false;
  return endDate < today || now.getHours() >= 18;
}

export function classifyAutomationTask(issue) {
  const summary = String(issue?.summary || "");
  const issueType = String(issue?.issueType || "");

  if (/^(?:【后端】|\[后端\])|\bbackend\b/i.test(summary)) {
    return { category: "unsupported", label: "非前端任务", model: "", phase: 9 };
  }
  if (/技术方案|方案设计|设计文档|技术设计|编写[^\n]{0,24}方案/.test(summary)) {
    return { category: "design", label: "方案设计", model: "gpt-5.6-sol", phase: 1 };
  }
  if (/联调|自测|验证|测试交付/.test(summary)) {
    return { category: "verification", label: "联调自测", model: "gpt-5.6-sol", phase: 3 };
  }
  if (/故障|缺陷|bug/i.test(issueType) || /实现|开发|修复|功能|交付|优化|改造|支持/.test(summary)) {
    return { category: "implementation", label: "代码实现", model: "gpt-5.6-sol", phase: 2 };
  }
  return { category: "compliance", label: "任务核查", model: "gpt-5.6-sol", phase: 1 };
}

export function getIgnoredAutomationIssueKeys(issues = []) {
  const refactorTaskPattern = /生成\s*BFF\s*接口文档|APEX\s*重构|重构\s*APEX/i;
  const functionalSlicingParents = new Set(issues
    .filter((issue) => String(issue?.description || "").includes("delivery-functional-slicing-enabled"))
    .map((issue) => issue.key));
  const scheduledIssues = new Set(issues.filter(isScheduledIssue).map((issue) => issue.key));
  const refactorTasks = issues.filter((issue) => (
    refactorTaskPattern.test(String(issue?.summary || ""))
    && !functionalSlicingParents.has(issue.key)
    && !functionalSlicingParents.has(issue.parent?.key)
    && !scheduledIssues.has(issue.key)
    && !scheduledIssues.has(issue.parent?.key)
  ));
  const refactorChildren = issues.filter((issue) => (
    refactorTaskPattern.test(String(issue?.parent?.summary || ""))
    && !functionalSlicingParents.has(issue.parent?.key)
    && !scheduledIssues.has(issue.key)
    && !scheduledIssues.has(issue.parent?.key)
  ));
  const refactorParentKeys = new Set(refactorTasks.map((issue) => issue.parent?.key).filter(Boolean));

  return new Set([
    ...refactorTasks.map((issue) => issue.key),
    ...refactorChildren.map((issue) => issue.key),
    ...refactorParentKeys,
    ...issues
      .filter((issue) => refactorParentKeys.has(issue.parent?.key))
      .map((issue) => issue.key)
  ]);
}

export function getAutomationJobId(issueKey, category) {
  return `${String(issueKey || "").toUpperCase()}:${category}`;
}

function workspaceScore(issueKey, project) {
  const key = String(issueKey || "").toLowerCase();
  const branch = String(project.branch || "").toLowerCase();
  const folder = String(project.folderName || "").toLowerCase();
  const segments = String(project.path || "").toLowerCase().split(path.sep);
  let score = 0;

  if (folder === key) score += 120;
  if (segments.includes(key)) score += 100;
  if (branch === `feature/${key}`) score += 100;
  else if (branch.includes(key)) score += 70;
  return score;
}

export function matchIssueWorkspace(issue, projects = []) {
  return projects
    .map((project) => {
      const issueScore = workspaceScore(issue?.key, project);
      const parentScore = issue?.parent?.key ? workspaceScore(issue.parent.key, project) - 10 : 0;
      return { project, score: Math.max(issueScore, parentScore) };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.project || null;
}

function branchMatchesIssue(issue, branch) {
  const normalizedBranch = String(branch || "").toUpperCase();
  const keys = [issue?.key, issue?.parent?.key]
    .filter(Boolean)
    .map((key) => String(key).toUpperCase());

  return keys.some((key) => (
    normalizedBranch === key
    || normalizedBranch.endsWith(`/${key}`)
    || normalizedBranch.includes(`/${key}-`)
    || normalizedBranch.startsWith(`${key}-`)
  ));
}

function getCommitMessageStatus(message, issue) {
  const text = String(message || "").trim();
  if (!text) return "unknown";
  const [subject = "", ...bodyLines] = text.split(/\r?\n/);
  const body = bodyLines.join("\n");
  const keys = [issue?.key, issue?.parent?.key].filter(Boolean);
  const hasIssueKey = keys.some((key) => subject.includes(key) || body.includes(key));
  const hasChineseSubject = /[\u3400-\u9fff]/.test(subject);
  const hasDetailedBody = ["关联 Jira", "改动内容", "验证结果"]
    .every((heading) => body.includes(heading));

  return hasIssueKey && hasChineseSubject && hasDetailedBody ? "passed" : "failed";
}

export function getWorkspaceEvidence(workspace, issue = null, targetBranch = DEFAULT_AUTOMATION_SETTINGS.targetBranch) {
  if (!workspace) {
    return {
      state: "missing",
      label: "未找到工作区",
      codePresent: false,
      alreadyDone: false,
      pushedToRemote: false
    };
  }

  const commitsAheadTarget = Number(workspace.commitsAheadTarget || 0);
  const diffFileCount = Number(workspace.diffFileCount || 0);
  const codePresent = commitsAheadTarget > 0 || diffFileCount > 0;
  const matchesIssue = issue ? branchMatchesIssue(issue, workspace.branch) : false;
  const targetRef = `origin/${targetBranch}`;
  const remoteBranchesContainingHead = Array.isArray(workspace.remoteBranchesContainingHead)
    ? workspace.remoteBranchesContainingHead
    : [];
  const headCommitMessage = String(workspace.headCommitMessage || "");
  const headCommitMatchesIssue = [issue?.key, issue?.parent?.key]
    .filter(Boolean)
    .some((key) => headCommitMessage.includes(key));
  const alreadyDone = Boolean(
    workspace.clean
    && matchesIssue
    && remoteBranchesContainingHead.includes(targetRef)
  );
  const pushedToRemote = Boolean(
    workspace.clean
    && matchesIssue
    && codePresent
    && workspace.upstream
    && Number(workspace.ahead || 0) === 0
    && headCommitMatchesIssue
    && !alreadyDone
  );
  const commitMessageStatus = issue && pushedToRemote
    ? getCommitMessageStatus(workspace.headCommitMessage, issue)
    : "unknown";
  let state = "workspace-ready";
  let label = "工作区已创建";

  if (alreadyDone) {
    state = "already-done";
    label = `已合入 ${targetBranch}`;
  } else if (!workspace.clean) {
    state = "working";
    label = `${workspace.changed || 0} 项本地改动`;
  } else if (pushedToRemote) {
    state = "delivery-ready";
    label = commitMessageStatus === "failed"
      ? "代码已推送，中文提交说明待修正"
      : "代码已推送，待核查交付";
  } else if (codePresent) {
    state = "code-ready";
    label = `${diffFileCount} 个差异文件`;
  }

  return {
    state,
    label,
    codePresent,
    alreadyDone,
    pushedToRemote,
    branchMatchesIssue: matchesIssue,
    headCommitMatchesIssue,
    commitMessageStatus,
    path: workspace.path,
    displayPath: workspace.displayPath,
    branch: workspace.branch,
    clean: workspace.clean,
    changed: workspace.changed || 0,
    commitsAheadTarget,
    diffFileCount,
    upstream: workspace.upstream || "",
    ahead: Number(workspace.ahead || 0),
    remoteBranchesContainingHead
  };
}

function jobSatisfiesDependency(job) {
  return job && (terminalJobStatuses.has(job.status) || job.status === "review");
}

function planAction(issue, classification, hasChildren, dependencyKeys, job, workspaceEvidence, deliveryOnly) {
  if (isIssueDone(issue)) return "Jira 已完成";
  if (isJiraSubtask(issue)) return "子任务不参与自动派发";
  if (workspaceEvidence.alreadyDone) return "本地分支已合入，跳过重复执行";
  if (job?.status === "skipped") return "已识别做过，不再执行";
  if (hasChildren) return "等待子任务汇总完成";
  if (classification.category === "unsupported") return "仅展示，不进入前端执行队列";
  if (dependencyKeys.length > 0) return "等待前置任务完成";
  if (!job) return deliveryOnly ? "代码已推送，仅核查交付" : "待创建 Codex 会话";
  if (job.status === "pending") return deliveryOnly ? "等待交付核查" : "等待 Codex 调度";
  if (job.status === "dispatching") return "正在创建 Codex 会话";
  if (job.status === "dispatched" || job.status === "running") return "Codex 执行中";
  if (job.status === "review") return "等待 MR 审核";
  if (job.status === "completed") return "完成证据已回传";
  if (job.status === "blocked") return deliveryOnly ? "代码已推送，仅处理交付阻塞" : "需要处理阻塞";
  if (job.status === "cancelled") return "已停止自动执行";
  return "待处理";
}

export function buildAutomationPlan(issues = [], projects = [], jobs = [], settings = DEFAULT_AUTOMATION_SETTINGS) {
  const ignoredIssueKeys = getIgnoredAutomationIssueKeys(issues);
  const automationIssues = issues.filter((issue) => !ignoredIssueKeys.has(issue.key));
  const issueByKey = new Map(automationIssues.map((issue) => [issue.key, issue]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const childKeysByParent = new Map();

  automationIssues.forEach((issue) => {
    if (!issue.parent?.key) return;
    const childKeys = childKeysByParent.get(issue.parent.key) || [];
    childKeys.push(issue.key);
    childKeysByParent.set(issue.parent.key, childKeys);
  });
  automationIssues.forEach((issue) => {
    const declared = (issue.subtasks || []).map((item) => item.key).filter(Boolean);
    if (declared.length > 0) {
      childKeysByParent.set(issue.key, [...new Set([...(childKeysByParent.get(issue.key) || []), ...declared])]);
    }
  });

  const workspaceByIssueKey = new Map();
  const evidenceByIssueKey = new Map();
  automationIssues.forEach((issue) => {
    const workspace = matchIssueWorkspace(issue, projects);
    workspaceByIssueKey.set(issue.key, workspace);
    evidenceByIssueKey.set(
      issue.key,
      getWorkspaceEvidence(workspace, issue, settings.targetBranch)
    );
  });

  const plan = automationIssues.map((issue) => {
    const classification = classifyAutomationTask(issue);
    const jobId = getAutomationJobId(issue.key, classification.category);
    const job = jobById.get(jobId) || null;
    const childKeys = childKeysByParent.get(issue.key) || [];
    const siblings = issue.parent?.key
      ? (childKeysByParent.get(issue.parent.key) || []).map((key) => issueByKey.get(key)).filter(Boolean)
      : [];
    const dependencyCategories = classification.category === "implementation"
      ? new Set(["design"])
      : classification.category === "verification"
        ? new Set(["implementation"])
        : new Set();
    const dependencyKeys = siblings
      .filter((sibling) => dependencyCategories.has(classifyAutomationTask(sibling).category))
      .filter((sibling) => {
        const category = classifyAutomationTask(sibling).category;
        return !isIssueDone(sibling)
          && !evidenceByIssueKey.get(sibling.key)?.alreadyDone
          && !jobSatisfiesDependency(jobById.get(getAutomationJobId(sibling.key, category)));
      })
      .map((sibling) => sibling.key);
    const workspace = workspaceByIssueKey.get(issue.key);
    const workspaceEvidence = evidenceByIssueKey.get(issue.key);
    const hasChildren = childKeys.length > 0;
    const localAlreadyDone = workspaceEvidence.alreadyDone;
    const deliveryOnly = ["implementation", "verification"].includes(classification.category)
      && workspaceEvidence.pushedToRemote;
    const dispatchable = !isIssueDone(issue)
      && !isJiraSubtask(issue)
      && !localAlreadyDone
      && !hasChildren
      && classification.category !== "unsupported"
      && dependencyKeys.length === 0
      && !jobSatisfiesDependency(job);

    return {
      issue,
      jobId,
      job,
      category: classification.category,
      categoryLabel: classification.label,
      model: classification.model,
      phase: classification.phase,
      hasChildren,
      childKeys,
      dependencyKeys,
      dispatchable,
      localAlreadyDone,
      deliveryOnly,
      workspace: workspace ? {
        path: workspace.path,
        displayPath: workspace.displayPath,
        branch: workspace.branch,
        projectId: workspace.projectId
      } : null,
      workspaceEvidence,
      action: planAction(
        issue,
        classification,
        hasChildren,
        dependencyKeys,
        job,
        workspaceEvidence,
        deliveryOnly
      ),
      targetBranch: settings.targetBranch
    };
  });

  return plan.sort((left, right) => {
    const leftDate = left.issue.endDate || left.issue.dueDate || "9999-12-31";
    const rightDate = right.issue.endDate || right.issue.dueDate || "9999-12-31";
    return leftDate.localeCompare(rightDate)
      || left.phase - right.phase
      || left.issue.key.localeCompare(right.issue.key);
  });
}

function callbackInstructions(jobId, successStatus, fields) {
  const fieldList = fields.map((field) => `\`${field}\``).join("、");
  return [
    `完成后向 Delivery Workspace 回传：POST http://127.0.0.1:${process.env.DELIVERY_PORT || process.env.PORT || 5199}/api/automation/jobs/update，任务 id 为 \`${jobId}\`，状态为 \`${successStatus}\`，并填写 ${fieldList}。`,
    "遇到无法继续的问题时，将状态回传为 `blocked`，在 `result` 中写清阻塞原因；不要伪造完成证据。"
  ].join("\n");
}

export function buildCodexPrompt(planItem, settings = DEFAULT_AUTOMATION_SETTINGS) {
  const { issue, category, jobId } = planItem;
  const jiraLine = `[${issue.key}](${issue.url}) ${issue.summary}`;

  if (category === "design") {
    const workspaceLine = planItem.workspace?.path
      ? `优先读取已匹配的需求工作区 \`${planItem.workspace.path}\`，当前分支 \`${planItem.workspace.branch}\`；保持工作区现有改动，不要修改产品代码。`
      : "从本地 Apex 工作区中定位与父任务或 Jira Key 对应的仓库证据；找不到时明确标记，不要猜测代码现状。";
    return [
      `处理 Jira 技术方案任务：${jiraLine}`,
      `使用 [$apex-frontend-tech-design-delivery](${path.join(codexSkillsRoot, "apex-frontend-tech-design-delivery", "SKILL.md")}) 和 [$jira-task-compliance](${path.join(codexSkillsRoot, "jira-task-compliance", "SKILL.md")})。`,
      workspaceLine,
      "这是现有技术方案事项：读取父任务、兄弟子任务、PRD、原型和当前 Apex 仓库，产出并发布可评审的前端技术方案；校验 Jira 层级与字段，但不要重复创建已有任务，也不要修改产品代码。",
      "给出需求覆盖矩阵，逐项对应 Jira/PRD 的范围、验收标准、异常场景和测试点，不能用概括性结论代替逐项核对。",
      "技术方案、覆盖矩阵以及本地生成的 Markdown、图片等只发布到 Confluence/Jira 或保留为本地交付证据，不得写入、暂存、提交或推送到产品代码仓库。",
      callbackInstructions(jobId, "completed", ["artifactUrl", "coverage=passed", "result"])
    ].join("\n\n");
  }

  if (category === "implementation" || category === "verification") {
    const workspaceLine = planItem.workspace?.path
      ? `优先复用已匹配工作区 \`${planItem.workspace.path}\`，当前分支 \`${planItem.workspace.branch}\`。`
      : "按使用者项目目录与 Skill 约定创建或复用隔离工作区和 `feature/<JIRA-KEY>` 分支。";
    const delivery = settings.autoCreateMergeRequest
      ? `开发与验证全部通过后，用户已明确授权提交并推送当前需求分支，在 ${settings.repositoryUrl} 创建目标分支为 \`${settings.targetBranch}\` 的合并请求，指定 ${settings.reviewer} 审核；只创建 MR，不要自动合并。`
      : "完成实现与验证，但不要提交、推送或创建合并请求。";
    const existingWork = planItem.deliveryOnly
      ? `本地扫描已确认该需求分支代码已推送但尚未合入 \`${settings.targetBranch}\`。本次不要从头实现、不要重复创建工作区或分支；先逐项核对现有 diff 与需求覆盖，只修复确实存在的遗漏，然后完成测试和 MR 交付。`
      : "先识别并复用分支中已经完成的需求项，禁止对已有实现做重复开发或无关重写；只有覆盖清单确认存在真实缺口时才修改代码。";
    const detectedCommitProblem = planItem.deliveryOnly
      && planItem.workspaceEvidence?.commitMessageStatus === "failed"
      ? "巡检已发现当前分支 HEAD 的提交信息不符合中文详细格式；交付前必须处理。若该提交已经推送，不得擅自强推，回传 `blocked` 并写明需要用户确认改写历史。"
      : "";
    const commitPolicy = [
      "本次新建的每个 Git 提交必须使用详细中文提交信息，不得使用 `update`、`fix`、`wip` 等笼统描述。",
      `标题格式：\`${issue.key}: 中文改动摘要\`；正文必须包含“关联 Jira”“改动内容”“验证结果”三段和具体条目。`,
      "推送前检查本次新增提交的信息；本地未推送的不合规提交应修正。已推送的历史提交不要擅自强推改写，无法满足时回传 `blocked` 并说明原因。",
      detectedCommitProblem
    ].filter(Boolean).join("\n");
    const reviewArtifacts = [
      `使用 [$hardcode-i18n-scanner](${path.join(codexSkillsRoot, "hardcode-i18n-scanner", "SKILL.md")}) 完成多语言门禁：先检查仓库现有扫描脚本和 locale 配置，再扫描本需求 diff 中的用户可见硬编码，按项目既有规则改造并校验新增/变更 key 的 Vue I18n 消息语法。`,
      `将本需求涉及的多语言 key 导出为 \`tempdocs/${issue.key}-i18n.xlsx\`。必须使用批量导入模板、补齐英文原文与 en_text，并用 openpyxl 核验表头和代表行；即使没有新增 key，也要保留标准表头并在结果中明确记录 0 行。`,
      `根据 Jira、PRD、原型和技术方案的验收项建立截图清单，使用 [@Chrome](plugin://chrome@openai-bundled) 在真实本地页面逐项自测，将截图保存到 \`tempdocs/${issue.key}-self-test/AC-xx-场景.png\`。截图必须覆盖本需求相关的正常、空态、异常或权限场景，不能用占位图；同时生成 \`tempdocs/${issue.key}-self-test.md\`，逐项写明 PRD 验收点、页面、操作、预期、结果和截图文件。`,
      "提交 MR 前确认 Excel 可以打开、截图文件真实存在且内容可辨识，并确保截图不包含密码、Token 或其他敏感信息。",
      "上述 Excel、截图、自测 Markdown、技术方案和覆盖矩阵只作为本地或平台交付证据，不属于代码提交范围；禁止加入 Git 暂存区、提交、推送或 MR diff。"
    ].join("\n");
    const commitScopePolicy = [
      "Git 提交和 MR 只允许包含实现需求所需的业务源代码、运行必需的配置或数据库迁移、自动化测试，以及因真实依赖变更而必须更新的依赖清单/锁文件。",
      "禁止提交与代码实现无关的文件，包括但不限于：`tempdocs/**`、任何目录下的 `zh-CN.json`、技术方案、PRD/原型副本、自测截图、Excel、Markdown/PDF 报告、覆盖率文件、日志、录屏、构建产物、编辑器文件和本地环境配置。`zh-CN.json` 只允许用于本地联调，不得暂存、提交、推送或进入 MR diff。",
      "不得使用 `git add .`、`git add -A` 等全量暂存命令；必须逐个指定代码文件。提交前执行 `git status --short` 和 `git diff --cached --name-only` 检查暂存清单，发现非代码交付物时立即取消暂存并保留为本地证据。",
      "不得为了让工作区看起来干净而删除交付证据，也不要通过修改产品仓库 `.gitignore` 来掩盖这些文件；MR 描述只引用 Jira、Confluence 或本地日历中的证据结果。"
    ].join("\n");
    const runtimePolicy = [
      `本地运行和真实页面自测默认使用 \`${settings.runtimeEnvironment}\` 环境；仓库存在对应脚本时执行 \`${settings.runtimeCommand}\`。若脚本名称不同，先读取 package.json，使用等价的 ${settings.runtimeEnvironment} 开发服务命令，不得改用仅构建命令或其他环境。`,
      `浏览器操作统一使用 [@${settings.browser}](plugin://chrome@openai-bundled)，不要切换到其他浏览器或无登录态的浏览器会话。`,
      `优先复用 Chrome 中已有的 ${settings.runtimeEnvironment} 登录态。登录账号为 \`${settings.loginKeychainAccount}\`，密码保存在 macOS 钥匙串服务 \`${settings.loginKeychainService}\`；确需登录时，在取得用户针对该登录动作的确认后，只允许在同一次浏览器工具调用中把钥匙串结果保存在局部内存变量并直接填入 Chrome 密码框，调用结束前立即清除变量。`,
      "禁止通过 pbcopy、系统剪贴板、shell stdout、日志、截图、文件、提示词、提交或回调传递、打印或回显密码；原任务范围内的安全本地命令、已配置的本地服务和 tempdocs 证据操作不得主动请求 require_escalated。仅当登录请求被实际服务拒绝时才可按登录失败回传 blocked；工具调用、标签占用或剪贴板问题必须单列为运行环境问题，不得冒充业务 blocked。"
    ].join("\n");

    return [
      `处理 Jira ${category === "verification" ? "联调自测" : "代码实现"}任务：${jiraLine}`,
      `使用 [$apex-jira-feature-development](${path.join(codexSkillsRoot, "apex-jira-feature-development", "SKILL.md")}) 和 [$jira-task-compliance](${path.join(codexSkillsRoot, "jira-task-compliance", "SKILL.md")})。`,
      workspaceLine,
      existingWork,
      "先读取该 Jira 的父任务、全部子任务、描述、评论、附件、PRD/原型/技术方案，再扫描本地分支及相对基线的完整 diff。建立“需求/验收项 -> 代码位置 -> 测试证据”覆盖清单，修复所有范围内遗漏后才能声称完成。",
      "遵循仓库现有 AGENTS.md、架构、i18n、请求封装和测试规则；运行聚焦测试、项目静态门禁、`git diff --check`，并检查 loading、empty、error、长文本和重复操作等相关状态。",
      runtimePolicy,
      reviewArtifacts,
      commitScopePolicy,
      commitPolicy,
      delivery,
      callbackInstructions(jobId, settings.autoCreateMergeRequest ? "review" : "completed", [
        "mrUrl",
        "coverage=passed",
        "tests=passed",
        "commitMessage=passed",
        "i18n=passed",
        "i18nXlsxPath",
        "selfTestScreenshots=[绝对路径...]",
        "selfTestReportPath",
        "result"
      ])
    ].join("\n\n");
  }

  return [
    `核查 Jira 任务：${jiraLine}`,
    `使用 [$jira-task-compliance](${path.join(codexSkillsRoot, "jira-task-compliance", "SKILL.md")})。`,
    "读取完整 Jira 及关联材料，检查标题、类型、描述必填项、父子层级、Fix Version 和交付物链接；只报告缺口，不要擅自创建重复任务或修改产品代码。",
    callbackInstructions(jobId, "completed", ["coverage=passed", "result"])
  ].join("\n\n");
}

export function buildCodexPromptFromJob(job, settings = DEFAULT_AUTOMATION_SETTINGS) {
  return buildCodexPrompt({
    issue: {
      key: job.issueKey,
      url: job.issueUrl,
      summary: job.summary,
      parent: job.parentKey ? { key: job.parentKey } : null
    },
    category: job.category,
    jobId: job.id,
    workspace: job.workspacePath
      ? { path: job.workspacePath, branch: job.branch || `feature/${job.issueKey}` }
      : null,
    workspaceEvidence: job.workspaceEvidence || null,
    deliveryOnly: Boolean(job.deliveryOnly)
  }, settings);
}

export function isCompletionEvidenceReady(job, category, settings = DEFAULT_AUTOMATION_SETTINGS) {
  if (!job || !["completed", "review"].includes(job.status)) return false;
  if (job.coverage !== "passed") return false;
  if (category === "design") return Boolean(job.artifactUrl);
  if (category === "implementation" || category === "verification") {
    if (job.tests !== "passed") return false;
    if (job.commitMessage !== "passed") return false;
    if (job.i18n !== "passed" || !job.i18nXlsxPath) return false;
    if (!Array.isArray(job.selfTestScreenshots) || job.selfTestScreenshots.length === 0) return false;
    if (!job.selfTestReportPath) return false;
    return !settings.autoCreateMergeRequest || Boolean(job.mrUrl);
  }
  return Boolean(job.result);
}

export function dateReached(value, today = localDateIso()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && value <= today;
}

export function getFixVersionReleaseDate(issue, fallbackIssue = null) {
  const versionDetails = issue?.fixVersionDetails || [];
  const releaseDates = versionDetails
    .map((version) => version.releaseDate || "")
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));

  if (releaseDates.length > 0) return releaseDates.sort().at(-1);
  if (versionDetails.length === 0 && fallbackIssue && fallbackIssue !== issue) {
    return getFixVersionReleaseDate(fallbackIssue);
  }
  return "";
}

export function getVersionDateAction(issue, today = localDateIso(), fallbackIssue = null) {
  if (!issue || isIssueDone(issue)) return { action: "none", releaseDate: "" };

  const endDate = issue.endDate || issue.dueDate;
  const versionDetails = issue.fixVersionDetails?.length > 0
    ? issue.fixVersionDetails
    : fallbackIssue?.fixVersionDetails || [];
  const releaseDate = getFixVersionReleaseDate(issue, fallbackIssue);
  if (!dateReached(endDate, today)) {
    return { action: "none", releaseDate };
  }
  if (versionDetails.length === 0) return { action: "complete", releaseDate: "" };
  if (!releaseDate) return { action: "complete", releaseDate: "" };

  return dateReached(releaseDate, today)
    ? { action: "complete", releaseDate }
    : { action: "align-end-date", releaseDate };
}

export function shouldStartIssue(issue, today = localDateIso()) {
  return isIssueTodo(issue) && dateReached(issue.startDate, today);
}

export function shouldCompleteIssue(planItem, settings = DEFAULT_AUTOMATION_SETTINGS, today = localDateIso()) {
  if (isIssueDone(planItem.issue) || planItem.hasChildren) return false;
  const endDate = planItem.issue.endDate || planItem.issue.dueDate;
  return dateReached(endDate, today)
    && isCompletionEvidenceReady(planItem.job, planItem.category, settings);
}
