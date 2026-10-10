import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { repositoryRoot, sourceDataRoot, catchupDataRoot as configuredCatchupDataRoot, gitBinary } from "./config.mjs";
import { promisify } from "node:util";
import { automationSubtaskKeys, isAutomationSubtaskJob, isJiraSubtask } from "../../shared/automation-policy.mjs";
import {
  DEFAULT_AUTOMATION_SETTINGS,
  THREE_DAY_SPLIT_LABEL,
  buildAutomationPlan,
  buildCodexPrompt,
  buildCodexPromptFromJob,
  buildRequirementSegmentTitles,
  buildTaskDateSegments,
  classifyAutomationTask,
  dateReached,
  getNextAutomationRun,
  getVersionDateAction,
  getIgnoredAutomationIssueKeys,
  isIssueDone,
  isScheduledSliceIssue,
  isThreeDaySplitTask,
  localDateIso,
  resolveDispatchLimit,
  sanitizeAutomationSettings,
  shouldCompleteIssue,
  shouldCompleteScheduledSlice,
  shouldStartIssue
} from "./automation-core.mjs";
import { expectedMeetingTitle } from "./meeting-snapshot.mjs";
import { createAutomationSchedulerTick } from "./automation-scheduler.mjs";
import {
  createWeeklyReportRun,
  getNextWeeklyReportRun,
  makeDefaultWeeklyReportState,
  sanitizeWeeklyReportState
} from "./weekly-report.mjs";
import { readCatchupBoard, readCatchupDocument } from "./catchup-board.mjs";
import { catchupAdminExclusionReason, catchupAdminScopeReviewReason } from "./catchup-admin-scope.mjs";
import { readCatchupMergeDashboard } from "./catchup-merge-plan.mjs";
import {
  CATCHUP_MERGE_JOB_ID,
  applyCatchupMergeActionFile,
  attachCatchupMergePipeline,
  claimCatchupMergeJobFile,
  listCatchupMergeEvidenceScreenshots,
  readCatchupMergeEvidence,
  readCatchupMergePipelineState,
  updateCatchupMergeHandshakeFile,
  updateCatchupMergeResultFile
} from "./catchup-merge-pipeline.mjs";
import {
  CATCHUP_EXECUTION_ACTIONS,
  applyCatchupExecutionAction,
  attachCatchupExecution,
  readCatchupExecutionState,
  writeCatchupExecutionState
} from "./catchup-execution.mjs";
import {
  attachCatchupSessions,
  openCatchupSessionInCursor,
  readCatchupSessionRegistry
} from "./catchup-sessions.mjs";
import {
  CATCHUP_DISPATCH_JOB_STATUSES,
  claimCatchupDispatchJobFromFiles,
  mutateCatchupDispatchRegistryFile,
  updateCatchupDispatchJobFile
} from "./catchup-dispatch.mjs";
import {
  DEFAULT_CATCHUP_BASE_SHA,
  DEFAULT_CATCHUP_REQUIREMENTS_ROOT,
  DEFAULT_CATCHUP_SESSIONS_ROOT,
  DEFAULT_CATCHUP_SOURCE_REPOSITORY,
  provisionCatchupSessions
} from "./catchup-provisioning.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const execFileAsync = promisify(execFile);

const port = Number(process.env.DELIVERY_PORT || process.env.PORT || 5199);
const jiraBaseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
const runtimeRoot = sourceDataRoot;
const localProjectLabelsFile = process.env.LOCAL_PROJECT_LABELS_FILE
  || path.join(runtimeRoot, "local-project-labels.json");
const automationStateFile = process.env.AUTOMATION_STATE_FILE
  || path.join(runtimeRoot, "automation-state.json");
const catchupExecutionStateFile = process.env.CATCHUP_EXECUTION_STATE_FILE
  || path.join(runtimeRoot, "catchup-execution-state.json");
const catchupSessionsFile = process.env.CATCHUP_SESSIONS_FILE
  || path.join(runtimeRoot, "catchup-sessions.json");
const catchupDispatcherStateFile = process.env.CATCHUP_DISPATCHER_STATE_FILE
  || path.join(runtimeRoot, "catchup-dispatcher-state.json");
const catchupMergePipelineStateFile = process.env.CATCHUP_MERGE_PIPELINE_STATE_FILE
  || path.join(runtimeRoot, "catchup-merge-pipeline-state.json");
const catchupMergeEvidenceRoot = process.env.CATCHUP_MERGE_EVIDENCE_ROOT
  || path.join(runtimeRoot, "catchup-merge-evidence");
const catchupDataRoot = configuredCatchupDataRoot;
const catchupSourceRepository = process.env.APEX_CATCHUP_SOURCE_REPOSITORY
  || DEFAULT_CATCHUP_SOURCE_REPOSITORY;
const catchupRequirementsRoot = process.env.APEX_CATCHUP_REQUIREMENTS_ROOT
  || DEFAULT_CATCHUP_REQUIREMENTS_ROOT;
const catchupRuntimeSupportSource = process.env.APEX_CATCHUP_RUNTIME_SUPPORT_SOURCE
  || "";
const catchupSessionsRoot = process.env.APEX_CATCHUP_SESSIONS_ROOT
  || DEFAULT_CATCHUP_SESSIONS_ROOT;
const catchupBaseSha = process.env.APEX_CATCHUP_BASE_SHA || DEFAULT_CATCHUP_BASE_SHA;
const catchupJiraParentKey = process.env.APEX_CATCHUP_JIRA_PARENT_KEY || "";
const catchupJiraProjectKey = process.env.APEX_CATCHUP_JIRA_PROJECT_KEY || "";
const catchupJiraSubtaskTypeId = process.env.APEX_CATCHUP_JIRA_SUBTASK_TYPE_ID || "";
const catchupJiraAssignee = process.env.APEX_CATCHUP_JIRA_ASSIGNEE || "";
const catchupJiraStartDate = process.env.APEX_CATCHUP_JIRA_START_DATE || "";
const catchupJiraEndDate = process.env.APEX_CATCHUP_JIRA_END_DATE || "";
const catchupJiraDisabled = process.env.APEX_CATCHUP_JIRA_DISABLED !== "0";
const catchupJiraRequestTimeoutMs = Math.min(
  Math.max(Number(process.env.APEX_CATCHUP_JIRA_TIMEOUT_MS || 10_000), 1000),
  30_000
);
let cachedKeychainAuthorization = "";
let cachedConfluenceAuthorization = "";
let cachedLocalProjects = null;
let localProjectScanPromise = null;
let automationStateLock = Promise.resolve();
let catchupExecutionStateLock = Promise.resolve();
let catchupDispatcherStateLock = Promise.resolve();
let catchupJiraReconcilePromise = null;
let catchupJiraCompletionPromise = null;
const catchupJiraReconcileRequirementIds = new Set();
let automationScanPromise = null;
let weeklyReportPromise = null;
const jiraProjectVersionsCache = new Map();

const localProjectSkipDirectories = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".venv",
  "Pods",
  "build",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv"
]);

const suggestedLocalProjectNames = new Map();

const issueFields = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "project",
  "components",
  "description",
  "assignee",
  "reporter",
  "fixVersions",
  "created",
  "updated",
  "duedate",
  "resolutiondate",
  "labels",
  "customfield_10109",
  "customfield_10110",
  "parent",
  "subtasks"
];

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);
const automationSpreadsheetExtensions = new Set([".xlsx"]);
const automationScreenshotExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const automationReportExtensions = new Set([".md"]);

// 配置存在不等于凭据可读；只说明恢复入口，不回显钥匙串内容或底层命令输出。
export function jiraAuthUnavailableMessage(keychainService = process.env.JIRA_KEYCHAIN_SERVICE) {
  if (!jiraBaseUrl) return "Jira 未配置 JIRA_BASE_URL";
  return keychainService
    ? "Jira 鉴权已配置，但当前进程无法读取 macOS 钥匙串凭据。请确认“登录”钥匙串已解锁，并检查现有 Jira 条目的访问权限后重试。"
    : "Jira 未配置鉴权";
}

function getAuthHeaders() {
  if (!jiraBaseUrl) return null;
  if (process.env.JIRA_AUTH_HEADER) {
    return { Authorization: process.env.JIRA_AUTH_HEADER };
  }

  const keychainAuthorization = getKeychainAuthorization();
  if (keychainAuthorization) {
    return { Authorization: keychainAuthorization };
  }

  if (process.env.JIRA_USERNAME && process.env.JIRA_API_TOKEN) {
    const token = Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  if (process.env.JIRA_COOKIE) {
    return { Cookie: process.env.JIRA_COOKIE };
  }

  return null;
}

function getConfluenceAuthHeaders() {
  if (process.env.CONFLUENCE_AUTH_HEADER) {
    return { Authorization: process.env.CONFLUENCE_AUTH_HEADER };
  }
  if (process.env.CONFLUENCE_USERNAME && process.env.CONFLUENCE_API_TOKEN) {
    const token = Buffer.from(`${process.env.CONFLUENCE_USERNAME}:${process.env.CONFLUENCE_API_TOKEN}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  if (process.env.CONFLUENCE_COOKIE) return { Cookie: process.env.CONFLUENCE_COOKIE };
  const keychainAuthorization = getConfluenceKeychainAuthorization();
  if (keychainAuthorization) return { Authorization: keychainAuthorization };
  return null;
}

function getConfluenceKeychainAuthorization() {
  const service = process.env.CONFLUENCE_KEYCHAIN_SERVICE;
  if (!service) return null;
  if (cachedConfluenceAuthorization) return cachedConfluenceAuthorization;
  const account = process.env.CONFLUENCE_KEYCHAIN_ACCOUNT || process.env.USER;
  const args = ["find-generic-password"];
  if (account) args.push("-a", account);
  args.push("-s", service, "-w");
  try {
    const token = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    }).trim();
    if (!token) return null;
    cachedConfluenceAuthorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
    return cachedConfluenceAuthorization;
  } catch {
    return null;
  }
}

async function getCatchupJiraAuthHeaders() {
  if (!jiraBaseUrl) return null;
  if (process.env.JIRA_AUTH_HEADER) {
    return { Authorization: process.env.JIRA_AUTH_HEADER };
  }
  if (cachedKeychainAuthorization) {
    return { Authorization: cachedKeychainAuthorization };
  }
  const service = process.env.JIRA_KEYCHAIN_SERVICE;
  if (service) {
    const account = process.env.JIRA_KEYCHAIN_ACCOUNT || process.env.USER;
    const args = ["find-generic-password"];
    if (account) args.push("-a", account);
    args.push("-s", service, "-w");
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", args, {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 64 * 1024
      });
      const token = String(stdout || "").trim();
      if (token) {
        cachedKeychainAuthorization = `Bearer ${token}`;
        return { Authorization: cachedKeychainAuthorization };
      }
    } catch {}
  }
  if (process.env.JIRA_USERNAME && process.env.JIRA_API_TOKEN) {
    const token = Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  if (process.env.JIRA_COOKIE) {
    return { Cookie: process.env.JIRA_COOKIE };
  }
  return null;
}

function getKeychainAuthorization() {
  const service = process.env.JIRA_KEYCHAIN_SERVICE;
  if (!service) return null;
  if (cachedKeychainAuthorization) return cachedKeychainAuthorization;

  const account = process.env.JIRA_KEYCHAIN_ACCOUNT || process.env.USER;
  const args = ["find-generic-password"];
  if (account) args.push("-a", account);
  args.push("-s", service, "-w");

  try {
    const token = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    }).trim();

    if (!token) return null;
    cachedKeychainAuthorization = `Bearer ${token}`;
    return cachedKeychainAuthorization;
  } catch {
    return null;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendError(response, statusCode, message, details) {
  sendJson(response, statusCode, {
    error: message,
    details: details || null
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeStorageText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br />");
}

function replaceConfluenceTask(storageHtml, taskId, text) {
  const pattern = new RegExp(
    `(<li\\b[^>]*data-uuid=["']${escapeRegExp(taskId)}["'][^>]*>)[\\s\\S]*?(</li>)`,
    "i"
  );
  if (!pattern.test(storageHtml)) {
    const error = new Error("Confluence 中未找到对应例会任务");
    error.code = "MEETING_TASK_NOT_FOUND";
    throw error;
  }
  return String(storageHtml).replace(pattern, `$1${escapeStorageText(text)}$2`);
}

async function syncMeetingTaskToConfluence({ pageId, taskId, text }) {
  if (!/^\d+$/.test(String(pageId || ""))) throw new Error("例会页面 ID 无效");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(String(taskId || ""))) throw new Error("例会任务 ID 无效");
  if (!String(text || "").trim()) throw new Error("例会任务内容不能为空");

  const authHeaders = getConfluenceAuthHeaders();
  if (!authHeaders) throw new Error("未配置可用于 Confluence 的鉴权");
  const baseUrl = (process.env.CONFLUENCE_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Confluence 未配置 CONFLUENCE_BASE_URL");
  const pageResponse = await fetch(
    `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version`,
    { headers: { ...authHeaders, Accept: "application/json" } }
  );
  if (!pageResponse.ok) {
    const error = new Error(`读取 Confluence 页面失败：HTTP ${pageResponse.status}`);
    if ([401, 403].includes(pageResponse.status)) error.code = "CONFLUENCE_AUTH_REQUIRED";
    throw error;
  }
  const page = await pageResponse.json();
  if (page.title !== expectedMeetingTitle()) throw new Error("Confluence 页面不是当前月份例会");
  const storageHtml = page.body?.storage?.value;
  const version = Number(page.version?.number);
  if (typeof storageHtml !== "string" || !Number.isInteger(version)) throw new Error("Confluence 页面内容或版本不可用");

  const updateResponse = await fetch(
    `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`,
    {
      method: "PUT",
      headers: {
        ...authHeaders,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id: String(pageId),
        type: "page",
        title: page.title,
        version: { number: version + 1 },
        body: { storage: { value: replaceConfluenceTask(storageHtml, taskId, text), representation: "storage" } }
      })
    }
  );
  if (!updateResponse.ok) {
    const responseText = await updateResponse.text();
    throw new Error(`更新 Confluence 页面失败：HTTP ${updateResponse.status} ${responseText.slice(0, 180)}`);
  }
  return { pageId: String(pageId), taskId: String(taskId), version: version + 1 };
}

async function readJsonBody(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sanitizeAssignee(value) {
  const assignee = (value || "currentUser()").trim();
  if (assignee === "currentUser()") return assignee;
  if (/^[A-Za-z0-9_.@-]+$/.test(assignee)) return assignee;
  return "currentUser()";
}

function sanitizeUserQuery(value) {
  return String(value || "")
    .trim()
    .replace(/[<>"'`]/g, "")
    .slice(0, 80);
}

function sanitizeDateField(value) {
  const allowed = new Set(["updated", "created", "duedate", "resolutiondate"]);
  return allowed.has(value) ? value : "updated";
}

function sanitizeSortOrder(value) {
  const allowed = new Set(["default", "end-asc", "end-desc"]);
  return allowed.has(value) ? value : "default";
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function quoteJql(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseProjectFilter(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^[A-Z][A-Z0-9_-]*$/.test(item));
}

function parseVersionFilter(value) {
  const versions = String(value || "")
    .split(",")
    .map((item) => item.replace(/[\r\n]+/g, " ").trim().slice(0, 100))
    .filter(Boolean);

  return [...new Set(versions)].slice(0, 20);
}

function buildJql(params) {
  const dateField = sanitizeDateField(params.get("dateField"));
  const sortOrder = sanitizeSortOrder(params.get("sortOrder"));
  const start = params.get("start");
  const end = params.get("end");
  const assignee = sanitizeAssignee(params.get("assignee"));
  const projects = parseProjectFilter(params.get("projects"));
  const versions = parseVersionFilter(params.get("versions"));
  const keyword = (params.get("keyword") || "").trim();
  const includeDone = params.get("includeDone") === "true";
  const includeSubtasks = params.get("includeSubtasks") !== "false";
  const allTime = params.get("allTime") === "true";
  const maxResults = Math.min(Math.max(Number(params.get("maxResults") || (allTime ? 2000 : 500)), 1), 5000);

  const parts = [`assignee = ${assignee}`];

  if (!allTime && isDate(start)) {
    parts.push(`${dateField} >= "${start}"`);
  }

  if (!allTime && isDate(end)) {
    const endValue = dateField === "duedate" ? end : `${end} 23:59`;
    parts.push(`${dateField} <= "${endValue}"`);
  }

  if (projects.length > 0) {
    parts.push(`project in (${projects.join(",")})`);
  }

  if (versions.length > 0) {
    const versionValues = versions.map((version) => `"${quoteJql(version)}"`);
    parts.push(`fixVersion in (${versionValues.join(", ")})`);
  }

  if (keyword) {
    parts.push(`text ~ "${quoteJql(keyword)}"`);
  }

  if (!includeSubtasks) {
    parts.push("issuetype not in subTaskIssueTypes()");
  }

  if (!includeDone) {
    parts.push("statusCategory != Done");
  }

  return {
    jql: `${parts.join(" AND ")} ORDER BY ${buildOrderBy(dateField, allTime, sortOrder)}`,
    dateField,
    sortOrder,
    start: allTime ? "" : start,
    end: allTime ? "" : end,
    assignee,
    projects,
    versions,
    keyword,
    includeDone,
    includeSubtasks,
    allTime,
    maxResults
  };
}

function buildOrderBy(dateField, allTime, sortOrder = "default") {
  if (sortOrder === "end-asc") {
    return "cf[10110] ASC, priority DESC, updated DESC";
  }

  if (sortOrder === "end-desc") {
    return "cf[10110] DESC, priority DESC, updated DESC";
  }

  if (allTime) return "updated DESC";

  const sortFields = [
    `${dateField} ASC`,
    "priority DESC"
  ];

  if (dateField !== "updated") {
    sortFields.push("updated DESC");
  }

  return sortFields.join(", ");
}

function normalizeIssue(issue) {
  const fields = issue.fields || {};
  const fixVersionDetails = Array.isArray(fields.fixVersions)
    ? fields.fixVersions.map((item) => ({
        id: String(item.id || ""),
        name: item.name || "",
        releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(item.releaseDate || "") ? item.releaseDate : "",
        released: Boolean(item.released)
      })).filter((item) => item.name)
    : [];
  const fixVersions = fixVersionDetails.map((item) => item.name);

  return {
    key: issue.key,
    url: `${jiraBaseUrl}/browse/${issue.key}`,
    summary: fields.summary || "",
    status: fields.status?.name || "-",
    statusCategory: fields.status?.statusCategory?.name || "",
    issueType: fields.issuetype?.name || "-",
    priority: fields.priority?.name || "-",
    project: fields.project?.key || "",
    projectName: fields.project?.name || "",
    components: Array.isArray(fields.components)
      ? fields.components.map((item) => ({ id: String(item.id || ""), name: item.name || "" }))
        .filter((item) => item.id || item.name)
      : [],
    assignee: fields.assignee?.displayName || fields.assignee?.name || "",
    assigneeName: fields.assignee?.name || fields.assignee?.accountId || "",
    reporter: fields.reporter?.displayName || fields.reporter?.name || "",
    fixVersions,
    fixVersionDetails,
    created: fields.created || null,
    updated: fields.updated || null,
    dueDate: fields.duedate || null,
    startDate: fields.customfield_10109 || null,
    endDate: fields.customfield_10110 || null,
    resolutionDate: fields.resolutiondate || null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    description: fields.description || "",
    parent: fields.parent
      ? {
          key: fields.parent.key,
          summary: fields.parent.fields?.summary || ""
        }
      : null,
    subtasks: Array.isArray(fields.subtasks)
      ? fields.subtasks.map((item) => ({
          key: item.key,
          summary: item.fields?.summary || "",
          status: item.fields?.status?.name || "",
          statusCategory: item.fields?.status?.statusCategory?.name || ""
        }))
      : []
  };
}

function normalizeUser(user) {
  const name = user.name || user.key || user.accountId || "";
  const displayName = stripHtml(user.displayName || user.display_name || user.html || name);

  return {
    name,
    key: user.key || "",
    accountId: user.accountId || "",
    displayName,
    emailAddress: user.emailAddress || user.email || "",
    avatarUrl: user.avatarUrl || user.avatar_url || user.avatarUrls?.["48x48"] || "",
    queryValue: name
  };
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJiraUsers(query) {
  const authHeaders = getAuthHeaders();
  const cleanQuery = sanitizeUserQuery(query);

  if (!authHeaders) {
    return {
      source: "mock",
      users: makeMockUsers(cleanQuery),
      warning: `${jiraAuthUnavailableMessage()}；当前展示 mock 用户。`
    };
  }

  if (!cleanQuery) {
    return {
      source: "jira",
      users: [
        {
          name: "currentUser()",
          key: "",
          accountId: "",
          displayName: "当前登录用户",
          emailAddress: "",
          avatarUrl: "",
          queryValue: "currentUser()"
        }
      ]
    };
  }

  const users = await tryUserPicker(authHeaders, cleanQuery);
  if (users.length > 0) {
    return { source: "jira", users };
  }

  return {
    source: "jira",
    users: await tryUserSearch(authHeaders, cleanQuery)
  };
}

async function tryUserPicker(authHeaders, query) {
  const url = `${jiraBaseUrl}/rest/api/2/user/picker?query=${encodeURIComponent(query)}&maxResults=20&showAvatar=true`;
  const response = await fetch(url, {
    headers: {
      ...authHeaders,
      Accept: "application/json"
    }
  });

  if (!response.ok) return [];

  const payload = await response.json();
  const users = Array.isArray(payload.users) ? payload.users : [];
  return users.map(normalizeUser).filter((user) => user.queryValue);
}

async function tryUserSearch(authHeaders, query) {
  const url = `${jiraBaseUrl}/rest/api/2/user/search?username=${encodeURIComponent(query)}&maxResults=20`;
  const response = await fetch(url, {
    headers: {
      ...authHeaders,
      Accept: "application/json"
    }
  });

  if (!response.ok) return [];

  const payload = await response.json();
  const users = Array.isArray(payload) ? payload : [];
  return users.map(normalizeUser).filter((user) => user.queryValue);
}

async function fetchJiraProjectVersions(projectKey, authHeaders) {
  const cached = jiraProjectVersionsCache.get(projectKey);
  if (cached && cached.expiresAt > Date.now()) return cached.versions;

  const response = await fetch(
    `${jiraBaseUrl}/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`,
    { headers: { ...authHeaders, Accept: "application/json" } }
  );
  if (!response.ok) {
    throw new Error(`读取 Jira 项目 ${projectKey} 的版本日期失败：HTTP ${response.status}`);
  }

  const payload = await response.json();
  const versions = Array.isArray(payload) ? payload : payload.values || [];
  jiraProjectVersionsCache.set(projectKey, {
    versions,
    expiresAt: Date.now() + 5 * 60_000
  });
  return versions;
}

async function hydrateIssueFixVersionDetails(issues, authHeaders) {
  const projectKeys = [...new Set(
    issues
      .filter((issue) => issue.fixVersionDetails.length > 0)
      .map((issue) => issue.project)
      .filter(Boolean)
  )];
  const projectVersions = await Promise.all(
    projectKeys.map((projectKey) => fetchJiraProjectVersions(projectKey, authHeaders))
  );
  const versionsById = new Map(
    projectVersions.flat().map((version) => [String(version.id || ""), version])
  );

  issues.forEach((issue) => {
    issue.fixVersionDetails = issue.fixVersionDetails.map((version) => {
      const hydrated = versionsById.get(version.id);
      if (!hydrated) return version;
      return {
        ...version,
        releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(hydrated.releaseDate || "")
          ? hydrated.releaseDate
          : "",
        released: Boolean(hydrated.released)
      };
    });
  });
}

async function fetchJiraIssues(query) {
  const authHeaders = getAuthHeaders();
  if (!authHeaders) {
    const error = new Error(jiraAuthUnavailableMessage());
    error.code = "JIRA_AUTH_UNAVAILABLE";
    throw error;
  }

  const maxResults = query.maxResults;
  const issues = [];
  let startAt = 0;
  let total = 0;

  while (issues.length < maxResults) {
    const pageSize = Math.min(50, maxResults - issues.length);
    const response = await fetch(`${jiraBaseUrl}/rest/api/2/search`, {
      method: "POST",
      headers: {
        ...authHeaders,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jql: query.jql,
        startAt,
        maxResults: pageSize,
        fields: issueFields
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jira search failed: HTTP ${response.status} ${body.slice(0, 500)}`);
    }

    const payload = await response.json();
    total = payload.total || 0;
    const pageIssues = Array.isArray(payload.issues) ? payload.issues : [];
    issues.push(...pageIssues.map(normalizeIssue));

    if (pageIssues.length === 0 || issues.length >= total) break;
    startAt += pageIssues.length;
  }

  await hydrateIssueFixVersionDetails(issues, authHeaders);

  return {
    source: "jira",
    baseUrl: jiraBaseUrl,
    jql: query.jql,
    sortOrder: query.sortOrder,
    total,
    issues
  };
}

// 交接读取允许一次短暂网络故障恢复；评论、流转和指派绝不自动重放。
async function fetchJiraHandoff(url, options) {
  const method = options.method || 'GET';
  const signal = AbortSignal.timeout(30_000);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...options, signal });
    } catch (cause) {
      const code = cause?.cause?.code || cause?.code;
      const transient = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
      if (method === 'GET' && attempt === 0 && transient && !signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      const diagnostic = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? `（${code}）` : '';
      const reason = signal.aborted || cause?.name === 'TimeoutError' ? '网络请求超时'
        : /CERT|TLS|SSL|SELF_SIGNED/.test(code || '') ? '证书校验失败' : '网络连接失败';
      const action = method === 'GET' ? '读取' : '写入';
      throw new Error(`${action} Jira 失败：${reason}${diagnostic}，请检查 Jira 网络连接后重新核对。`, { cause });
    }
  }
}

// 专用修复入口只读取已配置 Jira，绝不向输入链接的任意主机转发凭据。
export async function jiraFixHandoffRequest(key, suffix, method = 'GET', body) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)
    || !(method === 'GET' && (suffix === '?fields=summary,status,reporter,assignee' || suffix === '/transitions' || suffix === '/transitions?expand=transitions.fields' || suffix === '/workflow-statuses' || /^\/comment\/\d+$/.test(suffix))
      || method === 'POST' && ['/comment', '/transitions'].includes(suffix)
      || method === 'PUT' && suffix === '/assignee')) throw new Error('不支持的 Jira 交接请求');
  const authHeaders = getAuthHeaders();
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());
  // 本地只读聚合：按当前事项的项目 + 类型取完整状态，不能将状态 ID 当成 transition ID。
  if (suffix === '/workflow-statuses') {
    const read = async (pathname) => {
      const result = await fetchJiraHandoff(`${jiraBaseUrl}/rest/api/2/${pathname}`, {
        headers: { ...authHeaders, Accept: 'application/json' },
      });
      if (!result.ok) throw new Error(`读取 Jira 完整状态失败：HTTP ${result.status}`);
      return result.json();
    };
    const issue = await read(`issue/${encodeURIComponent(key)}?fields=project,issuetype`);
    const projectId = issue.fields?.project?.id, typeId = issue.fields?.issuetype?.id;
    if (!projectId || !typeId) throw new Error('Jira 未返回项目或事项类型');
    const types = await read(`project/${encodeURIComponent(projectId)}/statuses`);
    const type = Array.isArray(types) && types.find(item => String(item.id) === String(typeId));
    if (!type || !Array.isArray(type.statuses)) throw new Error('Jira 未返回该事项类型的完整状态');
    return type.statuses.map(({ id, name }) => ({ id: String(id), name }));
  }
  const response = await fetchJiraHandoff(`${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(key)}${suffix}`, {
    method, headers: { ...authHeaders, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // 保留 Jira 的工作流校验原因；非 JSON 网关页面不直接显示到用户界面。
    const payload = await response.json().catch(() => null);
    const messages = [
      ...(Array.isArray(payload?.errorMessages) ? payload.errorMessages : []),
      ...(payload?.errors && typeof payload.errors === 'object' && !Array.isArray(payload.errors)
        ? Object.values(payload.errors) : []),
    ].filter(message => typeof message === 'string' && message.trim());
    const detail = [...new Set(messages)].join('；');
    const error = new Error(`Jira 交接请求失败：HTTP ${response.status}${detail ? `，${detail}` : '，请检查权限及工作流要求'}`);
    error.definite = response.status >= 400 && response.status < 500;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

export async function readJiraFixIssue(reference) {
  if (!jiraBaseUrl) throw new Error(jiraAuthUnavailableMessage());
  let key = String(reference || '').trim();
  if (/^https?:\/\//i.test(key)) {
    const url = new URL(key);
    if (url.origin !== new URL(jiraBaseUrl).origin || url.username || url.password) throw new Error('请使用当前已配置 Jira 的事项链接');
    key = url.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/)?.[1] || '';
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) throw new Error('Jira Key 格式不正确');
  const authHeaders = getAuthHeaders();
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());
  const response = await fetch(`${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(key.toUpperCase())}`, {
    headers: { ...authHeaders, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`读取 Jira 失败：HTTP ${response.status}，请检查事项和访问权限`);
  return normalizeIssue(await response.json());
}

function makeMockUsers(query) {
  const users = [
    {
      name: "currentUser()",
      displayName: "当前登录用户",
      emailAddress: "",
      queryValue: "currentUser()"
    }
  ];

  if (!query) return users;

  const lowerQuery = query.toLowerCase();
  return users.filter((user) =>
    [user.name, user.displayName, user.emailAddress]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(lowerQuery))
  );
}

function displayLocalPath(value) {
  const home = homedir();
  if (value === home) return "~";
  return value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function getLocalProjectRoots() {
  const configured = String(process.env.LOCAL_PROJECT_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const roots = configured.length > 0
    ? configured
    : [path.join(repositoryRoot, "projects")];

  return [...new Set(roots.map((item) => path.resolve(item)))];
}

function shouldSkipLocalDirectory(name) {
  return name.startsWith(".")
    || name.endsWith(".app")
    || localProjectSkipDirectories.has(name);
}

async function findGitRepositories(root, maxDepth, maxDirectories) {
  const repositories = [];
  const queue = [{ directory: root, depth: 0 }];
  let cursor = 0;
  let directoryCount = 0;
  let unreadableCount = 0;

  while (cursor < queue.length && directoryCount < maxDirectories) {
    const current = queue[cursor];
    cursor += 1;
    directoryCount += 1;

    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      unreadableCount += 1;
      continue;
    }

    if (entries.some((entry) => entry.name === ".git")) {
      repositories.push(current.directory);
      continue;
    }

    if (current.depth >= maxDepth) continue;

    entries.forEach((entry) => {
      if (!entry.isDirectory() || shouldSkipLocalDirectory(entry.name)) return;
      queue.push({
        directory: path.join(current.directory, entry.name),
        depth: current.depth + 1
      });
    });
  }

  return {
    repositories,
    directoryCount,
    unreadableCount,
    limited: cursor < queue.length
  };
}

async function runGit(repositoryPath, args, timeout = 5000) {
  try {
    const result = await execFileAsync(gitBinary, ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout
    });
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function parseGitStatus(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
  let branch = header.split("...")[0].replace(/ \[.*$/, "");

  if (branch.startsWith("No commits yet on ")) {
    branch = branch.slice("No commits yet on ".length);
  } else if (branch === "HEAD (no branch)") {
    branch = "";
  }

  const upstreamMatch = header.match(/\.\.\.([^ \[]+)/);
  const aheadMatch = header.match(/ahead (\d+)/);
  const behindMatch = header.match(/behind (\d+)/);
  let staged = 0;
  let modified = 0;
  let untracked = 0;

  lines.forEach((line) => {
    if (line.startsWith("??")) {
      untracked += 1;
      return;
    }
    if (line[0] && line[0] !== " ") staged += 1;
    if (line[1] && line[1] !== " ") modified += 1;
  });

  return {
    branch,
    upstream: upstreamMatch?.[1] || "",
    ahead: Number(aheadMatch?.[1] || 0),
    behind: Number(behindMatch?.[1] || 0),
    changed: lines.length,
    staged,
    modified,
    untracked,
    clean: lines.length === 0
  };
}

function parseGitRemote(value, fallbackName = "") {
  const raw = String(value || "").trim();
  let host = "";
  let repository = "";
  let remoteUrl = raw;
  let webUrl = "";

  const scpMatch = !raw.includes("://")
    ? raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
    : null;

  if (scpMatch) {
    host = scpMatch[1];
    repository = scpMatch[2];
  } else if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      host = url.hostname;
      repository = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      url.password = "";
      url.search = "";
      url.hash = "";
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.username = "";
      }
      remoteUrl = url.toString().replace(/\/$/, "");
    } catch {
      repository = raw;
    }
  } else if (raw) {
    repository = raw;
  }

  repository = repository.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const projectName = repository ? path.basename(repository) : fallbackName;

  if (host && repository) {
    webUrl = `https://${host}/${repository}`;
  } else if (/^https?:\/\//.test(remoteUrl)) {
    webUrl = remoteUrl.replace(/\.git$/, "");
  }

  return {
    projectName,
    repository: repository || fallbackName,
    host,
    remoteUrl,
    webUrl
  };
}

function getLocalProjectId(remote, repositoryPath) {
  if (remote.host && remote.repository) return `${remote.host}:${remote.repository}`;
  return `local:${repositoryPath}`;
}

function getSuggestedLocalProjectName(remote) {
  return suggestedLocalProjectNames.get(remote.repository) || "";
}

async function readLocalProjectLabels() {
  try {
    const payload = JSON.parse(await fs.readFile(localProjectLabelsFile, "utf8"));
    return payload && typeof payload.labels === "object" ? payload.labels : {};
  } catch {
    return {};
  }
}

async function writeLocalProjectLabel(projectId, displayName) {
  const labels = await readLocalProjectLabels();

  if (displayName) {
    labels[projectId] = displayName;
  } else {
    delete labels[projectId];
  }

  await fs.mkdir(path.dirname(localProjectLabelsFile), { recursive: true });
  const temporaryFile = `${localProjectLabelsFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify({ version: 1, labels }, null, 2), "utf8");
  await fs.rename(temporaryFile, localProjectLabelsFile);
}

function sanitizeLocalProjectDisplayName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 60);
}

async function inspectGitRepository(repositoryPath, scanRoot) {
  const [
    statusOutput,
    remoteOutput,
    commitsAheadTargetOutput,
    diffFilesOutput,
    remoteBranchesContainingHeadOutput,
    headCommitMessageOutput
  ] = await Promise.all([
    runGit(repositoryPath, ["status", "--porcelain=v1", "--branch", "--ignore-submodules=all"]),
    runGit(repositoryPath, ["config", "--get", "remote.origin.url"]),
    runGit(repositoryPath, ["rev-list", "--count", `origin/${DEFAULT_AUTOMATION_SETTINGS.targetBranch}..HEAD`]),
    runGit(repositoryPath, ["diff", "--name-only", `origin/${DEFAULT_AUTOMATION_SETTINGS.targetBranch}...HEAD`]),
    runGit(repositoryPath, ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"]),
    runGit(repositoryPath, ["log", "-1", "--format=%s%n%b", "HEAD"])
  ]);
  const status = parseGitStatus(statusOutput);
  const detached = statusOutput.startsWith("## HEAD (no branch)");
  const folderName = path.basename(repositoryPath);
  const remote = parseGitRemote(remoteOutput, folderName);
  const projectId = getLocalProjectId(remote, repositoryPath);
  const branch = status.branch || (detached ? "游离 HEAD" : "未提交");

  return {
    folderName,
    path: repositoryPath,
    displayPath: displayLocalPath(repositoryPath),
    relativePath: path.relative(scanRoot, repositoryPath) || ".",
    rootPath: scanRoot,
    rootLabel: displayLocalPath(scanRoot),
    projectId,
    suggestedDisplayName: getSuggestedLocalProjectName(remote),
    commitsAheadTarget: Number(commitsAheadTargetOutput || 0),
    diffFileCount: diffFilesOutput ? diffFilesOutput.split(/\r?\n/).filter(Boolean).length : 0,
    remoteBranchesContainingHead: remoteBranchesContainingHeadOutput
      ? remoteBranchesContainingHeadOutput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : [],
    headCommitMessage: headCommitMessageOutput,
    ...status,
    branch,
    detached,
    ...remote
  };
}

async function refreshAutomationGitEvidence(issues, projects, jobs, settings) {
  const matchedPaths = new Set(
    buildAutomationPlan(issues, projects, jobs, settings)
      .filter((item) => !isIssueDone(item.issue) && item.workspace?.path)
      .map((item) => item.workspace.path)
  );
  const matchedProjects = projects.filter((project) => matchedPaths.has(project.path));
  const targetRef = `origin/${settings.targetBranch}`;

  await mapWithConcurrency(matchedProjects, 4, async (project) => {
    await runGit(project.path, ["fetch", "--quiet", "origin", settings.targetBranch], 15_000);
    const [statusOutput, commitsAheadOutput, diffFilesOutput, containingBranchesOutput] = await Promise.all([
      runGit(project.path, ["status", "--porcelain=v1", "--branch", "--ignore-submodules=all"]),
      runGit(project.path, ["rev-list", "--count", `${targetRef}..HEAD`]),
      runGit(project.path, ["diff", "--name-only", `${targetRef}...HEAD`]),
      runGit(project.path, ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"])
    ]);
    const status = parseGitStatus(statusOutput);

    Object.assign(project, status, {
      branch: status.branch || project.branch,
      commitsAheadTarget: Number(commitsAheadOutput || 0),
      diffFileCount: diffFilesOutput ? diffFilesOutput.split(/\r?\n/).filter(Boolean).length : 0,
      remoteBranchesContainingHead: containingBranchesOutput
        ? containingBranchesOutput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
        : []
    });
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function scanLocalProjects() {
  const startedAt = Date.now();
  const maxDepth = Math.min(Math.max(Number(process.env.LOCAL_PROJECT_SCAN_DEPTH || 6), 1), 12);
  const maxDirectories = Math.min(Math.max(Number(process.env.LOCAL_PROJECT_MAX_DIRECTORIES || 6000), 100), 50000);
  const roots = getLocalProjectRoots();
  const rootResults = await Promise.all(roots.map(async (root) => {
    try {
      await fs.access(root);
      const scan = await findGitRepositories(root, maxDepth, maxDirectories);
      return { path: root, label: displayLocalPath(root), exists: true, ...scan };
    } catch {
      return {
        path: root,
        label: displayLocalPath(root),
        exists: false,
        repositories: [],
        directoryCount: 0,
        unreadableCount: 0,
        limited: false
      };
    }
  }));
  const candidates = [];
  const seen = new Set();

  rootResults.forEach((root) => {
    root.repositories.forEach((repositoryPath) => {
      if (seen.has(repositoryPath)) return;
      seen.add(repositoryPath);
      candidates.push({ repositoryPath, scanRoot: root.path });
    });
  });

  const projects = await mapWithConcurrency(candidates, 10, ({ repositoryPath, scanRoot }) => (
    inspectGitRepository(repositoryPath, scanRoot)
  ));
  const labels = await readLocalProjectLabels();
  projects.forEach((project) => {
    project.customDisplayName = labels[project.projectId] || "";
    project.displayName = project.customDisplayName || project.suggestedDisplayName || "";
  });
  projects.sort((left, right) => left.displayPath.localeCompare(right.displayPath, "zh-CN"));

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    maxDepth,
    directoryCount: rootResults.reduce((total, root) => total + root.directoryCount, 0),
    limited: rootResults.some((root) => root.limited),
    unreadableCount: rootResults.reduce((total, root) => total + root.unreadableCount, 0),
    roots: rootResults.map(({ repositories, ...root }) => root),
    projects
  };
}

async function getLocalProjects(refresh = false) {
  if (!refresh && cachedLocalProjects?.expiresAt > Date.now()) {
    return cachedLocalProjects.payload;
  }

  if (!localProjectScanPromise) {
    localProjectScanPromise = scanLocalProjects()
      .then((payload) => {
        cachedLocalProjects = {
          expiresAt: Date.now() + 5 * 60_000,
          payload
        };
        return payload;
      })
      .finally(() => {
        localProjectScanPromise = null;
      });
  }

  return localProjectScanPromise;
}

async function updateLocalProjectDisplayName(projectId, value) {
  const payload = await getLocalProjects();
  const projects = payload.projects.filter((project) => project.projectId === projectId);
  if (projects.length === 0) return null;

  const displayName = sanitizeLocalProjectDisplayName(value);
  await writeLocalProjectLabel(projectId, displayName);
  projects.forEach((project) => {
    project.customDisplayName = displayName;
    project.displayName = displayName || project.suggestedDisplayName || "";
  });

  return {
    projectId,
    customDisplayName: displayName,
    displayName: projects[0].displayName
  };
}

async function openLocalProjectFolder(value) {
  const payload = await getLocalProjects();
  const requestedPath = path.resolve(String(value || ""));
  const project = payload.projects.find((item) => item.path === requestedPath);
  if (!project) return false;

  await fs.access(project.path);
  await execFileAsync("/usr/bin/open", [project.path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 5000
  });
  return true;
}

function makeDefaultAutomationState() {
  return {
    version: 1,
    settings: { ...DEFAULT_AUTOMATION_SETTINGS },
    jobs: [],
    plan: [],
    runs: [],
    lastRun: null,
    lastScheduledDate: "",
    lastScheduledSlot: "",
    weeklyReport: makeDefaultWeeklyReportState()
  };
}

async function readAutomationState() {
  try {
    const payload = JSON.parse(await fs.readFile(automationStateFile, "utf8"));
    const defaults = makeDefaultAutomationState();
    const settings = sanitizeAutomationSettings(payload.settings || {}, defaults.settings);
    return {
      ...defaults,
      ...payload,
      settings,
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      plan: Array.isArray(payload.plan) ? payload.plan : [],
      runs: Array.isArray(payload.runs) ? payload.runs : [],
      weeklyReport: sanitizeWeeklyReportState(payload.weeklyReport),
      lastScheduledSlot: payload.lastScheduledSlot
        || (payload.lastScheduledDate ? `${payload.lastScheduledDate} ${settings.dailyTimes[0]}` : "")
    };
  } catch {
    return makeDefaultAutomationState();
  }
}

async function writeAutomationState(state) {
  await fs.mkdir(path.dirname(automationStateFile), { recursive: true });
  const temporaryFile = `${automationStateFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(temporaryFile, automationStateFile);
}

function mutateAutomationState(updater) {
  const operation = automationStateLock.then(async () => {
    const state = await readAutomationState();
    const result = await updater(state);
    await writeAutomationState(state);
    return result;
  });
  automationStateLock = operation.catch(() => {});
  return operation;
}

async function getCatchupDashboard() {
  const [board, executionState, sessionRegistry, dispatcher] = await Promise.all([
    readCatchupBoard(catchupDataRoot),
    readCatchupExecutionState(catchupExecutionStateFile),
    readCatchupSessionRegistry(catchupSessionsFile),
    readCatchupDispatcherState()
  ]);
  return {
    ...attachCatchupSessions(attachCatchupExecution(board, executionState), sessionRegistry),
    dispatcher: presentCatchupDispatcherState(dispatcher)
  };
}

async function getCatchupMergeDashboard(force = false) {
  const board = await getCatchupDashboard();
  const [dashboard, pipeline] = await Promise.all([
    readCatchupMergeDashboard(board, { force }),
    readCatchupMergePipelineState(catchupMergePipelineStateFile)
  ]);
  const dashboardWithScreenshots = {
    ...dashboard,
    items: await Promise.all(dashboard.items.map(async (item) => ({
      ...item,
      evidenceRoot: catchupMergeEvidenceRoot,
      executionScreenshots: await listCatchupMergeEvidenceScreenshots(
        catchupMergeEvidenceRoot,
        item.requirementId,
        { notBefore: pipeline.requirements?.[item.requirementId]?.claimedAt }
      )
    })))
  };
  return attachCatchupMergePipeline(dashboardWithScreenshots, pipeline);
}

function isTrustedCatchupOrigin(request) {
  const origin = String(request.headers.origin || "");
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && parsed.port === String(port)
      && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function hasJsonContentType(request) {
  return String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase() === "application/json";
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(address || ""));
}

function isTrustedCatchupDispatcherRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  return !request.headers.origin || isTrustedCatchupOrigin(request);
}

function isTrustedCatchupBrowserRequest(request) {
  return isLoopbackAddress(request.socket?.remoteAddress) && isTrustedCatchupOrigin(request);
}

function isTrustedMeetingBrowserRequest(request) {
  return isLoopbackAddress(request.socket?.remoteAddress) && isTrustedCatchupOrigin(request);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCatchupActionRequest(body) {
  const allowedFields = new Set(["requirementIds", "action", "expectedRevision"]);
  if (
    !isPlainObject(body)
    || Object.keys(body).length !== allowedFields.size
    || Object.keys(body).some((key) => !allowedFields.has(key))
    || !Array.isArray(body.requirementIds)
    || body.requirementIds.length === 0
    || body.requirementIds.some((id) => !/^REQ-(?:CU-)?\d{3}$/.test(id))
    || new Set(body.requirementIds).size !== body.requirementIds.length
    || !CATCHUP_EXECUTION_ACTIONS.includes(body.action)
    || !Number.isInteger(body.expectedRevision)
    || body.expectedRevision < 0
  ) {
    throw new Error("INVALID_CATCHUP_ACTION_REQUEST");
  }
  return body;
}

export function buildCatchupDispatcherManifest(serverPort = port) {
  const endpoint = `http://127.0.0.1:${serverPort}`;
  const dispatchBatchSize = 8;
  const maxDispatchBatchSize = 8;
  const maxConcurrent = 8;
  const heartbeatMinutes = 1;
  const heartbeatPrompt = [
    "你是 APEX 重构追平的专用 Codex 调度器。只处理用户已在追平工作台明确开启、暂停、继续或结束后形成的控制任务；不要自行修改 Jira、追平事实或执行状态。",
    `每轮先 GET ${endpoint}/api/health；服务不可访问就结束本轮，不创建或操作任何任务。健康检查通过后 POST ${endpoint}/api/automation/catchup/dispatcher/update，JSON 为 {"status":"active","lastHeartbeatAt":"当前 ISO 时间"}。`,
    `本轮最多处理 ${dispatchBatchSize} 项。一次 POST ${endpoint}/api/automation/catchup/dispatch，Content-Type 为 application/json，JSON 为 {"limit":${dispatchBatchSize}}；jobs 为空即结束。每个 job 必须使用独立需求会话并行执行，接口硬上限为 ${maxDispatchBatchSize}；不得把多个需求串到一个长期 task。`,
    "一个 job.id 永远对应一个长期 Codex task。job.prompt 必须原样交给目标 task，不得在调度 task 中代替它实现需求。不要为同一 job.id 创建第二个 task，也不要把仅创建 task 或一次 turn 结束当成功能完成。向目标 task 投递时必须明确：它现在就是执行者，必须直接在 job.workspacePath 工作，禁止再调用 create_thread、fork_thread、send_message_to_thread 或其他线程管理工具转发、委派或重建本任务。",
    "合入预演任务必须按需求独立绑定 job.id 与长期 task；每个 task 只处理一个需求。现有 job.id=catchup-merge:sequence 仅作兼容控制标识，不得承载多个需求或跨需求复用 threadId。先在该需求隔离 worktree 基于最新已配置的目标分支 拉取对应需求分支，完成代码预演、本地服务、Chrome 自测和截图，并回调 awaiting_review 后停止；禁止仅创建 task 或一次 turn 结束就直接视为完成。只有用户审核该需求截图并在页面明确点击“确认通过”后，才向同一需求 task 投递交付动作，执行合入、提交和推送；禁止预演阶段提交、推送或自动开始下一项。",
    "公共组件复用规则：start/resume 向目标 task 交付 job.prompt 后，必须确认目标 task 已收到以下固定说明；不存在时向同一 task 追加且仅追加一次：“实现前必须先检查本仓库、同业务域 `_shared/` 和 `src/shared` 的既有公共组件；存在满足需求的组件时必须优先复用，禁止重复实现同类基础 UI、交互或工具。仅当能力已经稳定服务于同域多个 Feature 时才下沉到 `_shared/`，或稳定跨业务域复用时才下沉到 `shared/`；单一需求或单 Feature 的实现必须留在 Feature 内，不得为了形式上的‘公共组件’强行抽象。”",
    "action=start 或 resume：必须优先 list_threads，按 job.id、requirementId、需求标题和原登记 workspacePath 唯一匹配已有 task；命中后只恢复/续跑该 task，不重复创建。threadId 非空时先读取该 task并发送 job.prompt；已归档则先恢复。threadId 为空但 clientThreadId 非空时，禁止直接止于 dispatched：先 bounded wait 后再匹配；初始 prompt 已随 create_thread 提交，后续 stale resolution 重领仍须继续解析。确认找不到原 task 且没有多条歧义命中时，才创建该需求自己的独立 projectless task，使用用户默认模型；多条命中或 workspace 不一致时回写 blocked，不能猜测。目标 task 必须按 job.workspacePath 操作，绝不能在默认目录写产品代码。",
    "action=pause 或 finish：只能控制该 job 的同一长期 task。threadId 为空时先 list_threads，按 job.title 与 requirementId 查找未归档和已归档 task；唯一命中就回填 threadId 并发送 job.prompt，多条命中则回写 blocked，不得猜测。若没有命中且 clientThreadId 非空，只做一次 bounded wait 后再 list_threads，仍找不到才回写 blocked。若没有命中且 clientThreadId 也为空，说明目标 task 从未创建：pause 直接回 paused no-op，finish 直接回 completed no-op，绝不 blocked，也绝不能为 pause/finish 新建替代 task。",
    `创建或续跑成功后立即 POST ${endpoint}/api/automation/catchup/jobs/update，Content-Type 为 application/json，必须原样回传 job.id 与 job.claimToken，并回传 status、threadId、hostId、clientThreadId；仅取得 clientThreadId 时回 dispatched，取得或续跑 threadId 后 start/resume 回 running，pause 回 paused，finish 回 completed。`,
    "本轮所有 start/resume 投递完成后，对本轮目标 task 做一次 bounded wait/readback。若目标 turn 已完成或 task 已空闲，但没有任何执行输出且对应 job 仍为 running，说明发生空结束：向同一 task 仅补发一次“你就是执行者，禁止转发，立即直接执行上一条 job.prompt 并完成回调”的纠正消息；纠正 turn 仍空结束或仍无回调时，使用该 job 的原 claimToken 回写 blocked，error 写明“目标 task 空结束且未回调”，不得让幽灵 running 长时间占用并发槽。正在真实执行或已有回调的 task 不得重复发送。",
    "凡 job.prompt 涉及网页、登录态、页面交互、UI 验收或截图，只能使用用户指定的 Chrome 插件；插件不可用时按 prompt 回写 blocked，禁止切换内置浏览器或其他浏览器工具。",
    `任一任务失败时回写 status=blocked 和简洁 error，然后继续处理本轮后续任务；不得因单项失败中断其他任务，也不得泄露 Jira、Git 或其他凭据。本轮结束后再次 POST ${endpoint}/api/automation/catchup/dispatcher/update 更新 lastHeartbeatAt。`
  ].join("\n\n");
  return {
    projectName: "APEX 重构追平",
    endpoint,
    automationName: "APEX 重构追平 Codex 调度器",
    dispatchBatchSize,
    maxDispatchBatchSize,
    maxConcurrent,
    heartbeatMinutes,
    heartbeatRrule: `FREQ=MINUTELY;INTERVAL=${heartbeatMinutes}`,
    heartbeatPrompt
  };
}

function defaultCatchupDispatcherState() {
  return {
    status: "uninstalled",
    automationId: "",
    installedAt: "",
    lastHeartbeatAt: "",
    updatedAt: ""
  };
}

function normalizeCatchupDispatcherState(value = {}) {
  const fallback = defaultCatchupDispatcherState();
  if (!isPlainObject(value)) return fallback;
  return {
    status: ["active", "paused"].includes(value.status) ? value.status : fallback.status,
    automationId: typeof value.automationId === "string" ? value.automationId.trim().slice(0, 200) : "",
    installedAt: typeof value.installedAt === "string" ? value.installedAt.trim().slice(0, 80) : "",
    lastHeartbeatAt: typeof value.lastHeartbeatAt === "string"
      ? value.lastHeartbeatAt.trim().slice(0, 80)
      : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.trim().slice(0, 80) : ""
  };
}

export function resolveCatchupDispatcherDisplayStatus(
  dispatcher,
  now = Date.now()
) {
  if (dispatcher?.status !== "active") return dispatcher?.status || "uninstalled";
  const lastHeartbeatAt = Date.parse(dispatcher.lastHeartbeatAt || "");
  return Number.isFinite(lastHeartbeatAt) && now - lastHeartbeatAt > 15 * 60 * 1000
    ? "stale"
    : "active";
}

function presentCatchupDispatcherState(dispatcher) {
  return {
    ...dispatcher,
    displayStatus: resolveCatchupDispatcherDisplayStatus(dispatcher)
  };
}

async function readCatchupDispatcherState() {
  try {
    return normalizeCatchupDispatcherState(
      JSON.parse(await fs.readFile(catchupDispatcherStateFile, "utf8"))
    );
  } catch (error) {
    if (error.code === "ENOENT") return defaultCatchupDispatcherState();
    throw error;
  }
}

async function writeCatchupDispatcherState(state) {
  await fs.mkdir(path.dirname(catchupDispatcherStateFile), { recursive: true });
  const temporaryFile = `${catchupDispatcherStateFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(temporaryFile, catchupDispatcherStateFile);
}

function validateCatchupDispatcherUpdate(body) {
  const allowedFields = new Set(["status", "automationId", "installedAt", "lastHeartbeatAt"]);
  if (
    !isPlainObject(body)
    || Object.keys(body).some((key) => !allowedFields.has(key))
    || !["active", "paused"].includes(body.status)
  ) {
    throw new Error("INVALID_CATCHUP_DISPATCHER_UPDATE");
  }
  for (const field of ["automationId", "installedAt", "lastHeartbeatAt"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new Error("INVALID_CATCHUP_DISPATCHER_UPDATE");
    }
  }
  for (const field of ["installedAt", "lastHeartbeatAt"]) {
    if (body[field] && !Number.isFinite(Date.parse(body[field]))) {
      throw new Error("INVALID_CATCHUP_DISPATCHER_UPDATE");
    }
  }
  return body;
}

function updateCatchupDispatcherState(body) {
  const operation = catchupDispatcherStateLock.then(async () => {
    const current = await readCatchupDispatcherState();
    const now = new Date().toISOString();
    const next = normalizeCatchupDispatcherState({
      ...current,
      ...body,
      updatedAt: now
    });
    await writeCatchupDispatcherState(next);
    return next;
  });
  catchupDispatcherStateLock = operation.catch(() => {});
  return operation;
}

function catchupDispatchLimit(body) {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "limit")) {
    throw new Error("INVALID_CATCHUP_DISPATCH_REQUEST");
  }
  if (body.limit === undefined) return 4;
  if (!Number.isInteger(body.limit) || body.limit < 1) {
    throw new Error("INVALID_CATCHUP_DISPATCH_REQUEST");
  }
  return Math.min(body.limit, 8);
}

function validateCatchupJobUpdate(body) {
  const allowedFields = new Set([
    "id",
    "claimToken",
    "status",
    "threadId",
    "hostId",
    "clientThreadId",
    "result",
    "error"
  ]);
  if (
    !isPlainObject(body)
    || Object.keys(body).some((key) => !allowedFields.has(key))
    || !(
      /^catchup:REQ-(?:CU-)?\d{3}$/.test(body.id || "")
      || /^catchup-merge:REQ-(?:CU-)?\d{3}$/.test(body.id || "")
    )
    || typeof body.claimToken !== "string"
    || !body.claimToken.trim()
    || !CATCHUP_DISPATCH_JOB_STATUSES.includes(body.status)
  ) {
    throw new Error("INVALID_CATCHUP_JOB_UPDATE");
  }
  for (const field of ["threadId", "hostId", "clientThreadId", "error"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new Error("INVALID_CATCHUP_JOB_UPDATE");
    }
  }
  if (
    body.result !== undefined
    && typeof body.result !== "string"
    && !isPlainObject(body.result)
  ) {
    throw new Error("INVALID_CATCHUP_JOB_UPDATE");
  }
  return body;
}

function validateCatchupMergeActionRequest(body) {
  const allowedFields = new Set(body?.action === "direct-merge"
    ? ["requirementId", "action", "expectedRevision", "reason", "expectedSourceSha"]
    : ["requirementId", "action", "expectedRevision"]);
  if (
    !isPlainObject(body)
    || Object.keys(body).length !== allowedFields.size
    || Object.keys(body).some((key) => !allowedFields.has(key))
    || !/^REQ-(?:CU-)?\d{3}$/.test(body.requirementId || "")
    || !["start", "approve", "retry", "retest", "direct-merge"].includes(body.action)
    || !Number.isInteger(body.expectedRevision)
    || body.expectedRevision < 0
    || (body.action === "direct-merge" && (typeof body.reason !== "string" || body.reason.trim().length < 10 || body.reason.length > 1000 || !/^[0-9a-f]{40}$/i.test(body.expectedSourceSha || "")))
  ) {
    throw new Error("INVALID_CATCHUP_MERGE_ACTION_REQUEST");
  }
  return body;
}

function validateCatchupMergeResultRequest(body) {
  const allowedFields = new Set([
    "id",
    "claimToken",
    "requirementId",
    "status",
    "sourceSha",
    "targetSha",
    "summary",
    "automatedChecks",
    "testResults",
    "screenshots",
    "notes",
    "error"
  ]);
  if (
    !isPlainObject(body)
    || Object.keys(body).some((key) => !allowedFields.has(key))
    || !/^catchup-merge:REQ-(?:CU-)?\d{3}$/.test(body.id || "")
    || typeof body.claimToken !== "string"
    || !body.claimToken.trim()
    || !/^REQ-(?:CU-)?\d{3}$/.test(body.requirementId || "")
    || !["awaiting_review", "completed", "blocked"].includes(body.status)
  ) {
    throw new Error("INVALID_CATCHUP_MERGE_RESULT_REQUEST");
  }
  for (const field of ["sourceSha", "targetSha", "summary", "error"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new Error("INVALID_CATCHUP_MERGE_RESULT_REQUEST");
    }
  }
  for (const field of ["automatedChecks", "testResults", "screenshots", "notes"]) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      throw new Error("INVALID_CATCHUP_MERGE_RESULT_REQUEST");
    }
  }
  if (body.status === "blocked" && typeof body.error !== "string") {
    throw new Error("INVALID_CATCHUP_MERGE_RESULT_REQUEST");
  }
  return body;
}

function validateCatchupJiraConfiguration() {
  return /^[A-Z][A-Z0-9_-]*$/.test(catchupJiraProjectKey)
    && /^[A-Z][A-Z0-9_-]*-\d+$/.test(catchupJiraParentKey)
    && /^\d+$/.test(catchupJiraSubtaskTypeId)
    && /^[A-Za-z0-9_.@-]+$/.test(catchupJiraAssignee)
    && isDate(catchupJiraStartDate)
    && isDate(catchupJiraEndDate);
}

function catchupJiraDescription(requirement, session) {
  const criteria = (requirement.acceptanceCriteria || [])
    .map((item) => `* ${item.id || "AC"}：${item.text || "待核对"}`)
    .join("\n");
  return [
    "*需求来源*",
    `* ${requirement.id}｜${requirement.title}`,
    `* 父任务：${catchupJiraParentKey}`,
    `* 交接文件：{{${session.handoffPath}}}`,
    "",
    "*计划周期*",
    `* 目标开始日期：${catchupJiraStartDate}`,
    `* 目标结束日期：${catchupJiraEndDate}`,
    "",
    "*实现说明*",
    `* ${requirement.goal || "按冻结 Demo 最终代码还原页面、交互与业务规则。"}`,
    "* 正式接口契约、真实联调和 Gate 证据后补，不阻断功能编码。",
    "* 不得把静态实现表述为接口联调或需求验收完成。",
    "",
    "*交付物*",
    `* 分支：{{${session.branch}}}`,
    `* 工作区：{{${session.workspacePath}}}`,
    "* Vue 3 L-FSD 实现、Vitest、typecheck、lint 与构建证据。",
    "",
    "*验收标准*",
    criteria || "* 对照冻结需求与 Demo 完成功能还原和自测。"
  ].join("\n");
}

async function searchCatchupJiraIssue(requirementId, authHeaders, request = fetch) {
  const jql = [
    `project = ${catchupJiraProjectKey}`,
    `parent = ${catchupJiraParentKey}`,
    `labels = "${quoteJql(requirementId)}"`
  ].join(" AND ");
  const response = await request(`${jiraBaseUrl}/rest/api/2/search`, {
    method: "POST",
    signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs),
    headers: {
      ...authHeaders,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jql,
      startAt: 0,
      maxResults: 3,
      fields: ["summary", "status", "labels", "parent"]
    })
  });
  if (!response.ok) {
    throw new Error(`查询 Jira 子任务失败：HTTP ${response.status}`);
  }
  const payload = await response.json();
  const matches = (payload.issues || []).filter((issue) => (
    issue.fields?.parent?.key === catchupJiraParentKey
    && issue.fields?.labels?.includes(requirementId)
  ));
  if (matches.length > 1) throw new Error("发现多个同需求 Jira 子任务，拒绝猜测复用");
  return matches[0] || null;
}

async function createCatchupJiraIssue(requirement, session, authHeaders, request = fetch) {
  const response = await request(`${jiraBaseUrl}/rest/api/2/issue`, {
    method: "POST",
    signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs),
    headers: {
      ...authHeaders,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fields: {
        project: { key: catchupJiraProjectKey },
        parent: { key: catchupJiraParentKey },
        issuetype: { id: catchupJiraSubtaskTypeId },
        summary: `${requirement.id}｜${requirement.title}`.slice(0, 240),
        description: catchupJiraDescription(requirement, session),
        assignee: { name: catchupJiraAssignee },
        labels: [requirement.id, "apex-refactor-catchup", "demo-parity"],
        customfield_10109: catchupJiraStartDate,
        customfield_10110: catchupJiraEndDate
      }
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`创建 Jira 子任务失败：HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json();
}

export async function ensureCatchupJiraIssue(requirement, session, {
  authHeaders = getAuthHeaders(),
  request = fetch,
  transition = (issue, status) => transitionJiraIssue(issue, status, {
    signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs)
  })
} = {}) {
  const exclusionReason = catchupAdminExclusionReason(requirement.id);
  if (exclusionReason) throw new Error(exclusionReason);
  if (session.jiraKey && session.jiraStatus === "ready") {
    return {
      requirementId: requirement.id,
      jiraKey: session.jiraKey,
      jiraUrl: session.jiraUrl || `${jiraBaseUrl}/browse/${session.jiraKey}`,
      jiraStatus: "ready",
      jiraError: ""
    };
  }
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());
  if (!validateCatchupJiraConfiguration()) throw new Error("追平 Jira 创建配置无效");

  let issue;
  if (session.jiraKey) {
    const response = await request(
      `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(session.jiraKey)}?fields=status`,
      {
        headers: { ...authHeaders, Accept: "application/json" },
        signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs)
      }
    );
    if (!response.ok) throw new Error(`读取 Jira 子任务失败：HTTP ${response.status}`);
    issue = await response.json();
  } else {
    issue = await searchCatchupJiraIssue(requirement.id, authHeaders, request);
  }
  if (!issue) {
    const created = await createCatchupJiraIssue(requirement, session, authHeaders, request);
    issue = { key: created.key, fields: { status: null } };
  }
  const jiraKey = issue.key;
  let jiraError = "";
  try {
    await transition({
      key: jiraKey,
      status: issue.fields?.status?.name || ""
    }, "进行中");
  } catch (error) {
    jiraError = cleanAutomationText(error.message, 500);
  }
  return {
    requirementId: requirement.id,
    jiraKey,
    jiraUrl: `${jiraBaseUrl}/browse/${jiraKey}`,
    jiraStatus: jiraError ? "pending" : "ready",
    jiraError
  };
}

async function mapCatchupJiraWithConcurrency(items, worker, limit = 4) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await worker(items[current]);
      } catch (error) {
        results[current] = {
          requirementId: items[current].requirement.id,
          jiraKey: items[current].session.jiraKey || "",
          jiraUrl: items[current].session.jiraUrl || "",
          jiraStatus: "pending",
          jiraError: cleanAutomationText(error.message, 500)
        };
      }
    }
  }));
  return results;
}

async function ensureCatchupJiraSessions(board, requirementIds, registry) {
  if (catchupJiraDisabled) return { registry, jiraPending: [] };
  const requirementsById = new Map(board.requirements.map((item) => [item.id, item]));
  const items = requirementIds
    .filter((requirementId) => !catchupAdminExclusionReason(requirementId))
    .map((requirementId) => ({
      requirement: requirementsById.get(requirementId),
      session: registry.requirements[requirementId]
    }))
    .filter((item) => (
      item.requirement
      && item.session
      && (!item.session.jiraKey || item.session.jiraStatus === "pending")
    ));
  if (!items.length) return { registry, jiraPending: [] };

  const authHeaders = await getCatchupJiraAuthHeaders();
  const jiraResults = await mapCatchupJiraWithConcurrency(
    items,
    ({ requirement, session }) => ensureCatchupJiraIssue(requirement, session, { authHeaders })
  );
  try {
    const result = await mutateCatchupDispatchRegistryFile({
      sessionRegistryFile: catchupSessionsFile,
      update: async (freshRegistry) => {
        let changed = false;
        for (const jira of jiraResults) {
          const session = freshRegistry.requirements[jira.requirementId];
          if (!session) continue;
          if (
            session.jiraKey === jira.jiraKey
            && session.jiraUrl === jira.jiraUrl
            && session.jiraStatus === jira.jiraStatus
            && session.jiraError === jira.jiraError
          ) {
            continue;
          }
          freshRegistry.requirements[jira.requirementId] = {
            ...session,
            jiraKey: jira.jiraKey,
            jiraUrl: jira.jiraUrl,
            jiraStatus: jira.jiraStatus,
            jiraError: jira.jiraError,
            updatedAt: new Date().toISOString()
          };
          changed = true;
        }
        if (changed) {
          freshRegistry.revision += 1;
          freshRegistry.updatedAt = new Date().toISOString();
        }
        return { registry: freshRegistry, write: changed };
      }
    });
    return {
      registry: result.registry,
      jiraPending: jiraResults.filter((item) => item.jiraStatus !== "ready")
    };
  } catch (error) {
    return {
      registry,
      jiraPending: jiraResults.map((item) => ({
        ...item,
        jiraStatus: "pending",
        jiraError: item.jiraError || cleanAutomationText(error.message, 500)
      }))
    };
  }
}

function queueCatchupJiraReconciliation(requirementIds = []) {
  if (catchupJiraDisabled) return;
  requirementIds.forEach((requirementId) => {
    if (/^REQ-(?:CU-)?\d{3}$/.test(requirementId) && !catchupAdminExclusionReason(requirementId)) {
      catchupJiraReconcileRequirementIds.add(requirementId);
    }
  });
  if (catchupJiraReconcilePromise || catchupJiraReconcileRequirementIds.size === 0) return;

  catchupJiraReconcilePromise = (async () => {
    while (catchupJiraReconcileRequirementIds.size > 0) {
      const ids = [...catchupJiraReconcileRequirementIds];
      ids.forEach((requirementId) => catchupJiraReconcileRequirementIds.delete(requirementId));
      const [board, registry] = await Promise.all([
        readCatchupBoard(catchupDataRoot),
        readCatchupSessionRegistry(catchupSessionsFile)
      ]);
      await ensureCatchupJiraSessions(board, ids, registry);
    }
  })().catch((error) => {
    console.error(`Catchup Jira reconciliation failed: ${cleanAutomationText(error.message, 300)}`);
  }).finally(() => {
    catchupJiraReconcilePromise = null;
    if (catchupJiraReconcileRequirementIds.size > 0) {
      queueCatchupJiraReconciliation();
    }
  });
}

async function catchupJiraReconciliationTick() {
  if (catchupJiraDisabled) return;
  const [board, executionState, registry] = await Promise.all([
    readCatchupBoard(catchupDataRoot),
    readCatchupExecutionState(catchupExecutionStateFile),
    readCatchupSessionRegistry(catchupSessionsFile)
  ]);
  const ids = board.requirements
    .filter((requirement) => !catchupAdminExclusionReason(requirement.id))
    .filter((requirement) => {
      const status = executionState.requirements[requirement.id]?.status || "NOT_STARTED";
      const session = registry.requirements[requirement.id];
      return ["IN_PROGRESS", "PAUSED", "ENDED"].includes(status)
        && session?.workspacePath
        && (!session.jiraKey || session.jiraStatus === "pending");
    })
    .map((requirement) => requirement.id);
  queueCatchupJiraReconciliation(ids);
}

function runCatchupExecutionAction(board, body) {
  const operation = catchupExecutionStateLock.then(async () => {
    const executionState = await readCatchupExecutionState(catchupExecutionStateFile);
    const validRequirementIds = new Set(board.requirements.map((requirement) => requirement.id));

    applyCatchupExecutionAction(
      executionState,
      validRequirementIds,
      body.requirementIds,
      body.action,
      body.expectedRevision
    );

    let registry = await readCatchupSessionRegistry(catchupSessionsFile);
    let actionableIds = body.requirementIds;
    let preparationFailures = [];
    let jiraPending = [];

    if (body.action === "start") {
      const provisioning = await provisionCatchupSessions({
        requirements: board.requirements,
        requirementIds: body.requirementIds,
        sessionRegistryFile: catchupSessionsFile,
        catchupDataRoot,
        sourceRepository: catchupSourceRepository,
        requirementsRoot: catchupRequirementsRoot,
        runtimeSupportSource: catchupRuntimeSupportSource,
        sessionsRoot: catchupSessionsRoot,
        baseSha: catchupBaseSha
      });
      registry = provisioning.registry;
      preparationFailures = provisioning.failures;
      const failedIds = new Set(preparationFailures.map((item) => item.requirementId));
      actionableIds = body.requirementIds.filter((requirementId) => !failedIds.has(requirementId));
      jiraPending = actionableIds
        .filter((requirementId) => registry.requirements[requirementId]?.jiraStatus !== "ready")
        .map((requirementId) => ({
          requirementId,
          jiraStatus: "pending",
          jiraError: registry.requirements[requirementId]?.jiraError || "后台创建中"
        }));
    } else if (body.action === "resume") {
      const unregistered = body.requirementIds.filter((requirementId) => (
        !registry.requirements[requirementId]?.workspacePath
      ));
      if (unregistered.length > 0) {
        const error = new Error("CATCHUP_SESSION_WORKSPACE_REQUIRED");
        error.requirementIds = unregistered;
        throw error;
      }
    }

    if (!actionableIds.length) {
      return {
        state: executionState,
        updated: [],
        registry,
        preparationFailures,
        jiraPending
      };
    }
    const result = applyCatchupExecutionAction(
      executionState,
      validRequirementIds,
      actionableIds,
      body.action,
      body.expectedRevision
    );
    await writeCatchupExecutionState(catchupExecutionStateFile, result.state);
    return { ...result, registry, preparationFailures, jiraPending };
  });
  catchupExecutionStateLock = operation.catch(() => {});
  return operation;
}

function cleanAutomationText(value, maxLength = 2000) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanAutomationUrl(value) {
  const candidate = cleanAutomationText(value, 1000);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function cleanAutomationArtifactPath(value, workspacePath, allowedExtensions) {
  const candidate = cleanAutomationText(value, 1000);
  if (!candidate || !workspacePath) return "";

  const workspaceRoot = path.resolve(workspacePath);
  const tempdocsRoot = path.join(workspaceRoot, "tempdocs");
  const artifactPath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspaceRoot, candidate);
  const extension = path.extname(artifactPath).toLowerCase();

  if (!artifactPath.startsWith(`${tempdocsRoot}${path.sep}`)) return "";
  return allowedExtensions.has(extension) ? artifactPath : "";
}

function compactAutomationPlan(plan) {
  return plan.map(({ job, ...item }) => ({
    ...item,
    jobStatus: job?.status || "",
    threadId: job?.threadId || "",
    mrUrl: job?.mrUrl || ""
  }));
}

function synchronizeAutomationJobs(state, issues, projects) {
  const now = new Date().toISOString();
  const staleBefore = Date.now() - 2 * 60 * 60_000;
  const ignoredIssueKeys = getIgnoredAutomationIssueKeys(issues);
  state.jobs = state.jobs.filter((job) => !ignoredIssueKeys.has(job.issueKey));
  const existingJobs = new Map(state.jobs.map((job) => [job.id, job]));
  let plan = buildAutomationPlan(issues, projects, state.jobs, state.settings);
  let enqueued = 0;

  state.jobs.forEach((job) => {
    if (job.status === "dispatching" && Date.parse(job.claimedAt || 0) < staleBefore) {
      job.status = "pending";
      job.error = "上次会话创建未确认，已自动重新排队";
      job.updatedAt = now;
    }
  });

  if (state.settings.autoCreateCodex) {
    plan.forEach((item) => {
      if (isJiraSubtask(item.issue)) return;
      state.jobs
        .filter((job) => job.issueKey === item.issue.key && job.id !== item.jobId)
        .filter((job) => ["waiting", "pending", "cancelled"].includes(job.status))
        .forEach((job) => {
          job.status = "cancelled";
          job.result = "任务分类已更新，旧队列项已停止。";
          job.workspacePath = "";
          job.workspaceEvidence = null;
          job.updatedAt = now;
        });

      if (isIssueDone(item.issue) || item.localAlreadyDone || item.hasChildren || item.category === "unsupported") {
        const staleJob = existingJobs.get(item.jobId);
        if (staleJob && ["waiting", "pending", "blocked", "cancelled"].includes(staleJob.status)) {
          const alreadyHandled = isIssueDone(item.issue) || item.localAlreadyDone;
          staleJob.status = alreadyHandled ? "skipped" : "cancelled";
          staleJob.result = item.localAlreadyDone
            ? `本地需求分支已合入 ${state.settings.targetBranch}，巡检判定为已做过，不再创建 Codex 会话。`
            : isIssueDone(item.issue)
              ? "Jira 已完成，巡检判定为已做过，不再创建 Codex 会话。"
              : item.category === "unsupported"
                ? "该 Jira 被识别为非前端任务，仅保留在执行计划中。"
                : "该 Jira 是包含子任务的主任务，不单独创建 Codex 会话。";
          staleJob.workspacePath = item.workspace?.path || staleJob.workspacePath || "";
          staleJob.branch = item.workspace?.branch || staleJob.branch || "";
          staleJob.workspaceEvidence = item.workspaceEvidence;
          staleJob.updatedAt = now;
        }
        return;
      }

      let job = existingJobs.get(item.jobId);
      if (!job) {
        job = {
          id: item.jobId,
          issueKey: item.issue.key,
          issueUrl: item.issue.url,
          summary: item.issue.summary,
          parentKey: item.issue.parent?.key || "",
          category: item.category,
          categoryLabel: item.categoryLabel,
          phase: item.phase,
          model: item.model,
          status: item.dispatchable ? "pending" : "waiting",
          createdAt: now,
          updatedAt: now,
          attempts: 0,
          threadId: "",
          hostId: "",
          clientThreadId: "",
          mrUrl: "",
          artifactUrl: "",
          coverage: "",
          tests: "",
          commitMessage: "",
          i18n: "",
          i18nXlsxPath: "",
          selfTestScreenshots: [],
          selfTestReportPath: "",
          result: "",
          error: ""
        };
        state.jobs.push(job);
        existingJobs.set(job.id, job);
        enqueued += 1;
      }

      if (job.status === "waiting" && item.dispatchable) job.status = "pending";
      if (job.status === "pending" && !item.dispatchable) job.status = "waiting";
      job.issueUrl = item.issue.url;
      job.summary = item.issue.summary;
      job.parentKey = item.issue.parent?.key || "";
      job.category = item.category;
      job.categoryLabel = item.categoryLabel;
      job.phase = item.phase;
      job.model = item.model;
      job.startDate = item.issue.startDate || "";
      job.endDate = item.issue.endDate || item.issue.dueDate || "";
      job.workspacePath = item.workspace?.path || "";
      job.branch = item.workspace?.branch || `feature/${item.issue.key}`;
      job.workspaceEvidence = item.workspaceEvidence;
      job.deliveryOnly = item.deliveryOnly;
      if (item.deliveryOnly && item.workspaceEvidence.commitMessageStatus === "failed" && !["completed", "review"].includes(job.status)) {
        job.commitMessage = "failed";
      } else if (!item.deliveryOnly && !job.threadId && ["waiting", "pending"].includes(job.status)) {
        job.commitMessage = "";
      }
      job.title = `${item.issue.key} ${item.categoryLabel} · ${item.issue.summary}`.slice(0, 140);
      job.prompt = buildCodexPrompt(item, state.settings);
      job.updatedAt = now;
    });
  }

  plan = buildAutomationPlan(issues, projects, state.jobs, state.settings);
  state.plan = compactAutomationPlan(plan);
  return { plan, enqueued };
}

async function transitionJiraIssue(issue, targetStatus, { signal } = {}) {
  if (issue.status === targetStatus) {
    return { issueKey: issue.key, targetStatus, status: "skipped", message: "已经是目标状态" };
  }

  const authHeaders = getAuthHeaders();
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());

  const transitionsResponse = await fetch(
    `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issue.key)}/transitions`,
    { headers: { ...authHeaders, Accept: "application/json" }, signal }
  );
  if (!transitionsResponse.ok) {
    throw new Error(`读取 Jira transitions 失败：HTTP ${transitionsResponse.status}`);
  }

  const payload = await transitionsResponse.json();
  const transition = (payload.transitions || []).find((item) => (
    item.name === targetStatus || item.to?.name === targetStatus
  ));
  if (!transition) {
    throw new Error(`当前工作流没有“${targetStatus}”transition`);
  }

  const updateResponse = await fetch(
    `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issue.key)}/transitions`,
    {
      method: "POST",
      headers: {
        ...authHeaders,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      signal,
      body: JSON.stringify({ transition: { id: transition.id } })
    }
  );
  if (!updateResponse.ok) {
    const body = await updateResponse.text();
    throw new Error(`更新 Jira 状态失败：HTTP ${updateResponse.status} ${body.slice(0, 200)}`);
  }

  issue.status = targetStatus;
  issue.statusCategory = /完成|关闭|done|closed/i.test(targetStatus) ? "Done" : "In Progress";
  return { issueKey: issue.key, targetStatus, status: "updated", transitionId: transition.id };
}

function hasVerifiedCatchupDelivery(item) {
  const evidence = item?.pipeline?.evidence || {};
  return item?.status === "APPROVED"
    && Boolean(item?.pipeline?.approvedAt)
    && /^[0-9a-f]{40}$/i.test(evidence.sourceSha || "")
    && /^[0-9a-f]{40}$/i.test(evidence.targetSha || "");
}

function jiraCompletionTransitionPath(issue, targetStatus) {
  if (/待开始|待处理/i.test(issue?.status || "")) return ["开发中", "测试中", targetStatus];
  if (/开发中|进行中/i.test(issue?.status || "")) return ["测试中", targetStatus];
  return [targetStatus];
}

/**
 * 设计说明：Git 合入事实与 Jira 状态是两个独立来源，不能仅凭页面展示直接假定 Jira 已完成。
 * 此处接收实时 Git 已包含项，以及完成交付回调、人工审核且留存有效源/目标 SHA 的 APPROVED 项，
 * 逐项读取 Jira，按真实 transition 更新，并在写入后回读。例外合入和范围待复核项继续阻断。
 * 不复用日期驱动的自动巡检规则，因为本操作的唯一边界是可核验的追平交付证据。
 */
export async function reconcileMergedCatchupJiraCompletion(items, {
  apply = false,
  targetStatus = "已完成",
  authHeaders = getAuthHeaders(),
  request = fetch,
  transition = (issue, status) => transitionJiraIssue(issue, status, {
    signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs)
  })
} = {}) {
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());

  const deliveredItems = (items || []).filter((item) => (
    (item?.merged === true || hasVerifiedCatchupDelivery(item))
    && !catchupAdminExclusionReason(item.requirementId)
  ));
  const results = [];
  const seenKeys = new Set();
  const readIssue = async (jiraKey) => {
    const response = await request(
      `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(jiraKey)}?fields=summary,status`,
      {
        headers: { ...authHeaders, Accept: "application/json" },
        signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs)
      }
    );
    if (!response.ok) {
      throw new Error(`读取 Jira 状态失败：HTTP ${response.status}`);
    }
    const payload = await response.json();
    return {
      key: payload.key || jiraKey,
      summary: payload.fields?.summary || "",
      status: payload.fields?.status?.name || "-",
      statusCategory: payload.fields?.status?.statusCategory?.name || ""
    };
  };

  for (const item of deliveredItems) {
    const jiraKey = cleanAutomationText(item.jiraKey, 80).toUpperCase();
    const baseResult = {
      requirementId: item.requirementId || "",
      jiraKey,
      jiraUrl: item.jiraUrl || (jiraKey ? `${jiraBaseUrl}/browse/${jiraKey}` : ""),
      targetStatus
    };
    const scopeReviewReason = catchupAdminScopeReviewReason(item.requirementId);
    if (item.status === "EXCEPTION_MERGED" || item.pipeline?.reviewException
      || (item.pipeline?.reviewExceptionHistory?.length && item.status !== "APPROVED")) {
      results.push({ ...baseResult, status: "blocked", message: "例外合入保留未验证项，请完成补测审核后再同步 Jira 完成状态" });
      continue;
    }
    if (scopeReviewReason) {
      results.push({ ...baseResult, status: "blocked", message: scopeReviewReason });
      continue;
    }
    if (!/^[A-Z][A-Z0-9_-]*-\d+$/.test(jiraKey)) {
      results.push({ ...baseResult, status: "blocked", message: "合入项缺少有效 Jira Key" });
      continue;
    }
    if (seenKeys.has(jiraKey)) {
      results.push({ ...baseResult, status: "blocked", message: "多个合入项指向同一 Jira，拒绝重复更新" });
      continue;
    }
    seenKeys.add(jiraKey);

    try {
      const issue = await readIssue(jiraKey);
      const current = {
        ...baseResult,
        summary: issue.summary,
        currentStatus: issue.status,
        currentStatusCategory: issue.statusCategory
      };
      if (isIssueDone(issue)) {
        results.push({ ...current, status: "completed", message: "Jira 已是完成状态" });
        continue;
      }
      if (!apply) {
        results.push({ ...current, status: "pending", message: `待流转为${targetStatus}` });
        continue;
      }

      const transitionPath = jiraCompletionTransitionPath(issue, targetStatus);
      for (const status of transitionPath) await transition(issue, status);
      const updatedIssue = await readIssue(jiraKey);
      if (!isIssueDone(updatedIssue)) {
        results.push({
          ...current,
          status: "blocked",
          message: `transition 后回读仍为“${updatedIssue.status}”`
        });
        continue;
      }
      results.push({
        ...current,
        status: "updated",
        currentStatus: updatedIssue.status,
        currentStatusCategory: updatedIssue.statusCategory,
        transitionPath,
        message: "已更新并回读确认"
      });
    } catch (error) {
      results.push({
        ...baseResult,
        status: "blocked",
        message: cleanAutomationText(error.message, 300)
      });
    }
  }

  const completed = results.filter((item) => ["completed", "updated"].includes(item.status)).length;
  return {
    mode: apply ? "sync" : "check",
    targetStatus,
    checkedAt: new Date().toISOString(),
    total: results.length,
    completed,
    alreadyCompleted: results.filter((item) => item.status === "completed").length,
    updated: results.filter((item) => item.status === "updated").length,
    pending: results.filter((item) => item.status === "pending").length,
    blocked: results.filter((item) => item.status === "blocked").length,
    allCompleted: results.length > 0 && completed === results.length,
    results
  };
}

async function updateJiraIssueEndDate(issue, targetEndDate) {
  if (issue.endDate === targetEndDate) {
    return {
      issueKey: issue.key,
      targetEndDate,
      status: "skipped",
      message: "结束日期已经与版本发布日期一致"
    };
  }

  const authHeaders = getAuthHeaders();
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());

  const response = await fetch(
    `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issue.key)}`,
    {
      method: "PUT",
      headers: {
        ...authHeaders,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: { customfield_10110: targetEndDate } })
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`更新 Jira 结束日期失败：HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  issue.endDate = targetEndDate;
  return { issueKey: issue.key, targetEndDate, status: "updated" };
}

const automationProjectKeys = new Set((process.env.JIRA_AUTOMATION_PROJECT_KEYS || "")
  .split(",")
  .map((key) => key.trim().toUpperCase())
  .filter(Boolean));

function taskSegmentMarker(segment) {
  return `delivery-segment-${segment.index}-of-${segment.total}`;
}

function taskSegmentSummary(issue, segment) {
  return buildRequirementSegmentTitles(issue, segment.total)[segment.index - 1] || issue.summary;
}

function taskSegmentDescription(issue, segment, maxDays, summary) {
  return [
    "*需求功能切片*",
    `* 父任务：[${issue.key}|${issue.url}]`,
    `* 交付内容：${summary}`,
    `* 排期规则：技术方案、需求功能、联调自测均计入切片，每项最多 ${maxDays} 个自然日。`,
    "",
    "*计划周期*",
    `* 目标开始日期：${segment.startDate}`,
    `* 目标结束日期：${segment.endDate}`,
    "",
    "*完成口径*",
    "* 到达结束日期后按配置自动关闭当前功能切片。",
    "* 父任务按全部子任务和交付证据关闭。",
    "",
    `自动规则标识：${THREE_DAY_SPLIT_LABEL}/${taskSegmentMarker(segment)}`
  ].join("\n");
}

async function createAutomationTaskSegment(issue, segment, maxDays, authHeaders) {
  const summary = taskSegmentSummary(issue, segment);
  const fields = {
    project: { key: issue.project },
    parent: { key: issue.key },
    issuetype: { id: catchupJiraSubtaskTypeId },
    summary,
    description: taskSegmentDescription(issue, segment, maxDays, summary),
    customfield_10109: segment.startDate,
    customfield_10110: segment.endDate
  };
  if (issue.assigneeName) fields.assignee = { name: issue.assigneeName };
  if (issue.components?.length) {
    fields.components = issue.components.map((component) => (
      component.id ? { id: component.id } : { name: component.name }
    ));
  }

  const response = await fetch(`${jiraBaseUrl}/rest/api/2/issue`, {
    method: "POST",
    signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs),
    headers: {
      ...authHeaders,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`创建 Jira 子任务失败：HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function updateAutomationTaskSegment(issue, segment, authHeaders) {
  const marker = `${THREE_DAY_SPLIT_LABEL}/${taskSegmentMarker(segment)}`;
  const oldMarkerPattern = new RegExp(`${THREE_DAY_SPLIT_LABEL}/delivery-segment-\\d+-of-\\d+`, "g");
  const description = String(issue.description || "");
  const nextDescription = oldMarkerPattern.test(description)
    ? description.replace(oldMarkerPattern, marker)
    : `${description.trim()}${description.trim() ? "\n\n" : ""}自动规则标识：${marker}`;
  const fields = {
    customfield_10109: segment.startDate,
    customfield_10110: segment.endDate,
    description: nextDescription
  };
  const response = await fetch(`${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issue.key)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(catchupJiraRequestTimeoutMs),
    headers: {
      ...authHeaders,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`更新 Jira 功能切片失败：HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  issue.startDate = segment.startDate;
  issue.endDate = segment.endDate;
  issue.description = nextDescription;
}

function automationChildOrder(left, right) {
  const markerIndex = (issue) => Number(
    String(issue.description || issue.summary || "").match(/delivery-segment-(\d+)-of-\d+|进度切片\s+(\d+)\/\d+/)?.slice(1).find(Boolean) || 0
  );
  const leftMarker = markerIndex(left);
  const rightMarker = markerIndex(right);
  if (leftMarker && rightMarker && leftMarker !== rightMarker) return leftMarker - rightMarker;
  const leftPhase = classifyAutomationTask(left).phase;
  const rightPhase = classifyAutomationTask(right).phase;
  if (leftPhase !== rightPhase) return leftPhase - rightPhase;
  return left.key.localeCompare(right.key, undefined, { numeric: true });
}

function managedParallelFunctionalSegments(parent, children, maxDays) {
  if (children.length === 0) return [];
  const parentStart = new Date(`${parent.startDate}T00:00:00.000Z`);
  const parentEnd = new Date(`${parent.endDate || parent.dueDate}T00:00:00.000Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  const spanLimit = Math.max(1, Math.min(Math.floor(Number(maxDays) || 3), 30));
  if (Number.isNaN(parentStart.getTime()) || Number.isNaN(parentEnd.getTime())) return [];

  const managed = children.map((child, index) => {
    if (!isThreeDaySplitTask(child)) return null;
    const start = new Date(`${child.startDate}T00:00:00.000Z`);
    const end = new Date(`${child.endDate || child.dueDate}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const duration = Math.floor((end.getTime() - start.getTime()) / dayMs) + 1;
    if (duration < 1 || duration > spanLimit || start < parentStart || end > parentEnd) return null;
    const marker = String(child.description || "").match(/delivery-segment-(\d+)-of-(\d+)/);
    return {
      child,
      segment: {
        index: Number(marker?.[1] || index + 1),
        total: Number(marker?.[2] || children.length),
        startDate: child.startDate,
        endDate: child.endDate || child.dueDate
      }
    };
  }).filter(Boolean);
  return managed.length === children.length ? managed : [];
}

async function ensureAutomationTaskSegments(issues, settings) {
  if (!settings.autoSplitLongTasks || automationProjectKeys.size === 0) return [];
  const authHeaders = getAuthHeaders();
  if (!authHeaders) throw new Error(jiraAuthUnavailableMessage());

  const ignoredIssueKeys = getIgnoredAutomationIssueKeys(issues);
  const childIssuesByParent = new Map();
  for (const issue of issues) {
    if (!issue.parent?.key) continue;
    const children = childIssuesByParent.get(issue.parent.key) || [];
    children.push(issue);
    childIssuesByParent.set(issue.parent.key, children);
  }

  const results = [];
  for (const issue of issues) {
    if (!automationProjectKeys.has(issue.project) || ignoredIssueKeys.has(issue.key)) continue;
    const segments = buildTaskDateSegments(issue, settings.maxTaskSpanDays);
    if (segments.length === 0) continue;

    const knownChildren = childIssuesByParent.get(issue.key) || [];
    const orderedChildren = [...knownChildren].sort(automationChildOrder);
    const parallelSegments = knownChildren.length > segments.length
      ? managedParallelFunctionalSegments(issue, orderedChildren, settings.maxTaskSpanDays)
      : [];
    if (parallelSegments.length > 0) {
      results.push(...parallelSegments.map(({ child, segment }) => ({
        parentKey: issue.key,
        issueKey: child.key,
        segment,
        status: "skipped",
        message: "对应并行需求功能切片已存在"
      })));
      continue;
    }
    const assignedKeys = new Set();
    for (const segment of segments) {
      const marker = taskSegmentMarker(segment);
      const expectedSummary = taskSegmentSummary(issue, segment);
      const existing = knownChildren.find((child) => (
        !assignedKeys.has(child.key)
        && (
          child.labels?.includes(marker)
          || String(child.description || "").includes(`${THREE_DAY_SPLIT_LABEL}/${marker}`)
          || (child.startDate === segment.startDate && child.endDate === segment.endDate)
          || child.summary === expectedSummary
        )
      )) || orderedChildren.find((child) => !assignedKeys.has(child.key));
      if (existing) {
        assignedKeys.add(existing.key);
        const hasMarker = String(existing.description || "")
          .includes(`${THREE_DAY_SPLIT_LABEL}/${marker}`);
        const datesMatch = existing.startDate === segment.startDate && existing.endDate === segment.endDate;
        if (hasMarker && datesMatch) {
          results.push({
            parentKey: issue.key,
            issueKey: existing.key,
            segment,
            status: "skipped",
            message: "对应需求功能切片已存在"
          });
          continue;
        }
        try {
          await updateAutomationTaskSegment(existing, segment, authHeaders);
          results.push({
            parentKey: issue.key,
            issueKey: existing.key,
            segment,
            status: "updated",
            message: "已将现有需求子任务纳入连续排期"
          });
        } catch (error) {
          results.push({
            parentKey: issue.key,
            issueKey: existing.key,
            segment,
            status: "blocked",
            message: cleanAutomationText(error.message, 300)
          });
        }
        continue;
      }

      try {
        const created = await createAutomationTaskSegment(
          issue,
          segment,
          settings.maxTaskSpanDays,
          authHeaders
        );
        const createdIssue = {
          key: created.key,
          summary: expectedSummary,
          description: taskSegmentDescription(
            issue,
            segment,
            settings.maxTaskSpanDays,
            expectedSummary
          ),
          startDate: segment.startDate,
          endDate: segment.endDate,
          labels: [THREE_DAY_SPLIT_LABEL, marker]
        };
        knownChildren.push(createdIssue);
        results.push({
          parentKey: issue.key,
          issueKey: created.key,
          segment,
          status: "created"
        });
      } catch (error) {
        results.push({
          parentKey: issue.key,
          issueKey: "",
          segment,
          status: "blocked",
          message: cleanAutomationText(error.message, 300)
        });
      }
    }
  }
  return results;
}

async function executeAutomationTransitions(plan, settings, today) {
  if (!settings.autoTransitionJira && !settings.autoCloseDueSplitTasks) return [];

  const results = [];
  const transitionedDone = new Set();
  const versionManaged = new Set();
  const planByKey = new Map(plan.map((item) => [item.issue.key, item]));
  const execute = async (item, targetStatus, reason) => {
    try {
      const result = await transitionJiraIssue(item.issue, targetStatus);
      results.push({ ...result, reason });
      if (result.status === "updated" && targetStatus === settings.completedStatus) {
        transitionedDone.add(item.issue.key);
      }
      return result;
    } catch (error) {
      const result = {
        issueKey: item.issue.key,
        targetStatus,
        status: "blocked",
        reason,
        message: cleanAutomationText(error.message, 300)
      };
      results.push(result);
      return result;
    }
  };
  const complete = async (item, reason) => {
    try {
      const transitionPath = jiraCompletionTransitionPath(item.issue, settings.completedStatus);
      for (const status of transitionPath) await transitionJiraIssue(item.issue, status);
      const result = {
        issueKey: item.issue.key,
        targetStatus: settings.completedStatus,
        status: "updated",
        transitionPath,
        reason
      };
      results.push(result);
      transitionedDone.add(item.issue.key);
      return result;
    } catch (error) {
      const result = {
        issueKey: item.issue.key,
        targetStatus: settings.completedStatus,
        status: "blocked",
        reason,
        message: cleanAutomationText(error.message, 300)
      };
      results.push(result);
      return result;
    }
  };

  if (settings.autoTransitionJira) {
    for (const item of plan) {
      if (shouldStartIssue(item.issue, today)) {
        await execute(item, settings.startStatus, "目标开始日期已到");
      }
    }
  }

  for (const item of plan) {
    const parentIssue = planByKey.get(item.issue.parent?.key)?.issue || null;
    if (isScheduledSliceIssue(item.issue)) {
      versionManaged.add(item.issue.key);
      if (shouldCompleteScheduledSlice(item.issue)) {
        await complete(item, "明确排期子任务已过结束日 18:00");
      }
      continue;
    }
    if (isThreeDaySplitTask(item.issue)) {
      versionManaged.add(item.issue.key);
      const endDate = item.issue.endDate || item.issue.dueDate;
      if (settings.autoCloseDueSplitTasks && dateReached(endDate, today)) {
        if (shouldStartIssue(item.issue, today)) {
          const startResult = await execute(
            item,
            settings.startStatus,
            "功能切片结束日期已到，先按工作流进入开发中"
          );
          if (startResult.status === "blocked") continue;
        }
        if (item.issue.status !== "测试中" && item.issue.status !== settings.completedStatus) {
          const testResult = await execute(
            item,
            "测试中",
            "功能切片结束日期已到，按工作流进入测试中"
          );
          if (testResult.status === "blocked") continue;
        }
        await execute(
          item,
          settings.completedStatus,
          "功能切片结束日期已到；关闭对应子任务，父任务仍按全部子任务结果处理"
        );
      }
      continue;
    }
    if (!settings.autoTransitionJira) continue;
    const hasFixVersion = item.issue.fixVersionDetails?.length > 0
      || (!item.issue.fixVersionDetails?.length && parentIssue?.fixVersionDetails?.length > 0);
    const versionAction = getVersionDateAction(item.issue, today, parentIssue);
    if (versionAction.action === "none") continue;

    versionManaged.add(item.issue.key);
    if (versionAction.action === "complete") {
      if (shouldCompleteIssue(item, settings, today)) {
        await execute(
          item,
          settings.completedStatus,
          versionAction.releaseDate
            ? `任务结束日期和关联版本发布日期 ${versionAction.releaseDate} 均已到，且完成证据齐全`
            : hasFixVersion
              ? "任务结束日期已到、关联版本未配置发布日期，且完成证据齐全"
              : "任务结束日期已到、未关联版本，且完成证据齐全"
        );
      } else {
        results.push({
          issueKey: item.issue.key,
          targetStatus: settings.completedStatus,
          status: "pending",
          reason: "结束日期已到，但完成证据尚未齐全"
        });
      }
      continue;
    }

    try {
      const result = await updateJiraIssueEndDate(item.issue, versionAction.releaseDate);
      results.push({
        ...result,
        reason: `任务已到结束日期，已顺延至关联版本发布日期 ${versionAction.releaseDate}`
      });
    } catch (error) {
      results.push({
        issueKey: item.issue.key,
        targetEndDate: versionAction.releaseDate,
        status: "blocked",
        reason: "任务已到结束日期，但关联版本尚未到期",
        message: cleanAutomationText(error.message, 300)
      });
    }
  }

  if (!settings.autoTransitionJira) return results;

  for (const item of plan) {
    if (versionManaged.has(item.issue.key)) continue;
    if (shouldCompleteIssue(item, settings, today)) {
      await execute(item, settings.completedStatus, "目标结束日期已到且完成证据齐全");
    }
  }

  for (const item of plan.filter((candidate) => (
    candidate.hasChildren
    && !isIssueDone(candidate.issue)
    && !versionManaged.has(candidate.issue.key)
  ))) {
    const endDate = item.issue.endDate || item.issue.dueDate;
    if (!dateReached(endDate, today)) continue;

    const deliveryChildKeys = item.childKeys.filter((key) => {
      const child = planByKey.get(key)?.issue
        || item.issue.subtasks?.find((candidate) => candidate.key === key);
      return child && !isThreeDaySplitTask(child);
    });
    const allChildrenDone = deliveryChildKeys.length > 0 && deliveryChildKeys.every((key) => {
      const child = planByKey.get(key)?.issue
        || item.issue.subtasks?.find((candidate) => candidate.key === key);
      return transitionedDone.has(key) || isIssueDone(child);
    });
    if (allChildrenDone) {
      await execute(item, settings.completedStatus, "目标结束日期已到且全部子任务已完成");
    }
  }

  return results;
}

async function performAutomationScan(trigger = "manual", scheduledSlot = "") {
  const state = await readAutomationState();
  if (!state.settings.enabled && trigger === "schedule") {
    return { skipped: true, reason: "自动巡检已暂停" };
  }

  const startedAt = new Date().toISOString();
  const query = buildJql(new URLSearchParams({
    allTime: "true",
    includeDone: "true",
    includeSubtasks: "true",
    assignee: "currentUser()",
    maxResults: "5000"
  }));
  let [jiraPayload, localPayload] = await Promise.all([
    fetchJiraIssues(query),
    getLocalProjects(true)
  ]);
  const splitResults = jiraPayload.source === "jira"
    ? await ensureAutomationTaskSegments(jiraPayload.issues, state.settings)
    : [];
  if (splitResults.some((item) => item.status === "created")) {
    jiraPayload = await fetchJiraIssues(query);
  }
  await refreshAutomationGitEvidence(
    jiraPayload.issues,
    localPayload.projects,
    state.jobs,
    state.settings
  );
  let synchronized;

  await mutateAutomationState((latestState) => {
    synchronized = synchronizeAutomationJobs(latestState, jiraPayload.issues, localPayload.projects);
  });

  const latestState = await readAutomationState();
  const plan = buildAutomationPlan(jiraPayload.issues, localPayload.projects, latestState.jobs, latestState.settings);
  const transitionResults = jiraPayload.source === "jira"
    ? await executeAutomationTransitions(plan, latestState.settings, localDateIso())
    : [];
  const completedAt = new Date().toISOString();
  const run = {
    id: `${Date.now()}-${trigger}`,
    trigger,
    scheduledSlot: trigger === "schedule" ? scheduledSlot : "",
    localDate: localDateIso(),
    startedAt,
    completedAt,
    source: jiraPayload.source,
    issueCount: jiraPayload.issues.length,
    workspaceCount: localPayload.projects.length,
    dispatchableCount: plan.filter((item) => item.dispatchable).length,
    alreadyDoneCount: plan.filter((item) => (
      isIssueDone(item.issue)
      || item.localAlreadyDone
      || ["completed", "review", "skipped"].includes(item.job?.status)
    )).length,
    localAlreadyDoneCount: plan.filter((item) => item.localAlreadyDone).length,
    enqueuedCount: synchronized.enqueued,
    splitCreatedCount: splitResults.filter((item) => item.status === "created").length,
    splitUpdatedCount: splitResults.filter((item) => item.status === "updated").length,
    splitExistingCount: splitResults.filter((item) => item.status === "skipped").length,
    splitBlockedCount: splitResults.filter((item) => item.status === "blocked").length,
    splitResults,
    transitionUpdatedCount: transitionResults.filter((item) => item.status === "updated").length,
    transitionBlockedCount: transitionResults.filter((item) => item.status === "blocked").length,
    transitionResults
  };

  await mutateAutomationState((finalState) => {
    finalState.plan = compactAutomationPlan(
      buildAutomationPlan(jiraPayload.issues, localPayload.projects, finalState.jobs, finalState.settings)
    );
    finalState.lastRun = run;
    if (trigger === "schedule") {
      finalState.lastScheduledDate = run.localDate;
      finalState.lastScheduledSlot = scheduledSlot;
    }
    finalState.runs = [run, ...finalState.runs].slice(0, 40);
  });

  return run;
}

function runAutomationScan(trigger = "manual", scheduledSlot = "") {
  if (!automationScanPromise) {
    automationScanPromise = performAutomationScan(trigger, scheduledSlot)
      .finally(() => {
        automationScanPromise = null;
      });
  }
  return automationScanPromise;
}

async function performWeeklyReport(trigger = "manual", scheduledSlot = "") {
  const state = await readAutomationState();
  try {
    const query = buildJql(new URLSearchParams({
      allTime: "true",
      includeDone: "true",
      includeSubtasks: "true",
      assignee: "currentUser()",
      maxResults: "5000"
    }));
    const jiraPayload = await fetchJiraIssues(query);
    const run = createWeeklyReportRun({
      issues: jiraPayload.issues,
      jobs: state.jobs,
      automationRuns: state.runs,
      trigger,
      scheduledSlot,
      source: jiraPayload.source
    });
    await mutateAutomationState((latestState) => {
      const weeklyReport = sanitizeWeeklyReportState(latestState.weeklyReport);
      weeklyReport.lastRun = run;
      weeklyReport.runs = [run, ...weeklyReport.runs].slice(0, 12);
      if (trigger === "schedule") weeklyReport.lastScheduledSlot = scheduledSlot;
      latestState.weeklyReport = weeklyReport;
    });
    return run;
  } catch (error) {
    const generatedAt = new Date();
    const failure = {
      id: `${generatedAt.getTime()}-${trigger}`,
      trigger,
      scheduledSlot,
      status: "failed",
      source: "jira",
      generatedAt: generatedAt.toISOString(),
      rangeStart: "",
      rangeEnd: "",
      completedCount: 0,
      inProgressCount: 0,
      blockedCount: 0,
      agentCompletedCount: 0,
      maintenanceUpdatedCount: 0,
      content: "",
      error: cleanAutomationText(error.message, 500)
    };
    await mutateAutomationState((latestState) => {
      const weeklyReport = sanitizeWeeklyReportState(latestState.weeklyReport);
      weeklyReport.lastRun = failure;
      weeklyReport.runs = [failure, ...weeklyReport.runs].slice(0, 12);
      if (trigger === "schedule") weeklyReport.lastScheduledSlot = scheduledSlot;
      latestState.weeklyReport = weeklyReport;
    });
    throw error;
  }
}

function runWeeklyReport(trigger = "manual", scheduledSlot = "") {
  if (!weeklyReportPromise) {
    weeklyReportPromise = performWeeklyReport(trigger, scheduledSlot)
      .finally(() => {
        weeklyReportPromise = null;
      });
  }
  return weeklyReportPromise;
}

async function getAutomationDashboard() {
  const state = await readAutomationState();
  return {
    ...state,
    nextRun: getNextAutomationRun(state.settings),
    running: Boolean(automationScanPromise),
    weeklyReport: {
      ...sanitizeWeeklyReportState(state.weeklyReport),
      nextRun: getNextWeeklyReportRun(state.weeklyReport.settings),
      running: Boolean(weeklyReportPromise)
    },
    stateFile: displayLocalPath(automationStateFile)
  };
}

async function readAutomationArtifact(searchParams) {
  const state = await readAutomationState();
  const job = state.jobs.find((item) => item.id === searchParams.get("id"));
  const type = searchParams.get("type");
  const index = Number(searchParams.get("index") || 0);
  if (!job?.workspacePath) return null;

  let artifactPath = "";
  let allowedExtensions = new Set();
  if (type === "i18n") {
    artifactPath = job.i18nXlsxPath || "";
    allowedExtensions = automationSpreadsheetExtensions;
  } else if (type === "screenshot" && Number.isInteger(index) && index >= 0) {
    artifactPath = job.selfTestScreenshots?.[index] || "";
    allowedExtensions = automationScreenshotExtensions;
  } else if (type === "report") {
    artifactPath = job.selfTestReportPath || "";
    allowedExtensions = automationReportExtensions;
  }
  if (!artifactPath) return null;

  try {
    const [workspaceRoot, resolvedArtifact] = await Promise.all([
      fs.realpath(job.workspacePath),
      fs.realpath(artifactPath)
    ]);
    const tempdocsRoot = path.join(workspaceRoot, "tempdocs");
    const extension = path.extname(resolvedArtifact).toLowerCase();
    if (!resolvedArtifact.startsWith(`${tempdocsRoot}${path.sep}`)) return null;
    if (!allowedExtensions.has(extension)) return null;

    const stat = await fs.stat(resolvedArtifact);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return null;
    return {
      content: await fs.readFile(resolvedArtifact),
      filename: path.basename(resolvedArtifact),
      mimeType: mimeTypes.get(extension) || "application/octet-stream",
      inline: automationScreenshotExtensions.has(extension) || extension === ".md"
    };
  } catch {
    return null;
  }
}

function sendAutomationArtifact(response, artifact) {
  const disposition = artifact.inline ? "inline" : "attachment";
  response.writeHead(200, {
    "Content-Type": artifact.mimeType,
    "Content-Length": artifact.content.length,
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(artifact.content);
}

async function claimAutomationJobs(requestedLimit) {
  return mutateAutomationState((state) => {
    if (!state.settings.enabled || !state.settings.autoCreateCodex) return [];
    const limit = resolveDispatchLimit(requestedLimit, state.settings.maxDispatchPerRun);
    const now = new Date().toISOString();
    const subtaskKeys = automationSubtaskKeys(state.plan);
    const pendingJobs = state.jobs
      .filter((job) => job.status === "pending")
      .filter((job) => !isAutomationSubtaskJob(job, subtaskKeys))
      .sort((left, right) => (
        String(left.endDate || "9999-12-31").localeCompare(String(right.endDate || "9999-12-31"))
        || Number(left.phase || 9) - Number(right.phase || 9)
        || left.issueKey.localeCompare(right.issueKey)
      ));
    const jobs = limit ? pendingJobs.slice(0, limit) : pendingJobs;

    jobs.forEach((job) => {
      job.prompt = buildCodexPromptFromJob(job, state.settings);
      job.status = "dispatching";
      job.claimedAt = now;
      job.updatedAt = now;
      job.attempts = Number(job.attempts || 0) + 1;
    });
    return jobs;
  });
}

async function updateAutomationJob(body) {
  const allowedStatuses = new Set([
    "waiting",
    "pending",
    "dispatching",
    "dispatched",
    "running",
    "review",
    "completed",
    "skipped",
    "blocked",
    "cancelled"
  ]);
  return mutateAutomationState((state) => {
    const job = state.jobs.find((item) => item.id === body.id);
    if (!job) return null;

    if (body.expectedClaimedAt && (job.claimedAt !== body.expectedClaimedAt || !["dispatching", "dispatched", "running"].includes(job.status))) {
      return { cliClaimSuperseded: true };
    }

    if (allowedStatuses.has(body.status)) job.status = body.status;
    if (typeof body.threadId === "string") job.threadId = cleanAutomationText(body.threadId, 200);
    if (typeof body.hostId === "string") job.hostId = cleanAutomationText(body.hostId, 200);
    if (typeof body.clientThreadId === "string") job.clientThreadId = cleanAutomationText(body.clientThreadId, 200);
    if (typeof body.mrUrl === "string") job.mrUrl = cleanAutomationUrl(body.mrUrl);
    if (typeof body.artifactUrl === "string") job.artifactUrl = cleanAutomationUrl(body.artifactUrl);
    if (typeof body.coverage === "string") job.coverage = cleanAutomationText(body.coverage, 40);
    if (typeof body.tests === "string") job.tests = cleanAutomationText(body.tests, 40);
    if (typeof body.commitMessage === "string") job.commitMessage = cleanAutomationText(body.commitMessage, 40);
    if (typeof body.i18n === "string") job.i18n = cleanAutomationText(body.i18n, 40);
    if (typeof body.i18nXlsxPath === "string") {
      job.i18nXlsxPath = cleanAutomationArtifactPath(
        body.i18nXlsxPath,
        job.workspacePath,
        automationSpreadsheetExtensions
      );
    }
    if (Array.isArray(body.selfTestScreenshots)) {
      job.selfTestScreenshots = body.selfTestScreenshots
        .slice(0, 40)
        .map((artifactPath) => cleanAutomationArtifactPath(
          artifactPath,
          job.workspacePath,
          automationScreenshotExtensions
        ))
        .filter(Boolean);
    }
    if (typeof body.selfTestReportPath === "string") {
      job.selfTestReportPath = cleanAutomationArtifactPath(
        body.selfTestReportPath,
        job.workspacePath,
        automationReportExtensions
      );
    }
    if (typeof body.result === "string") job.result = cleanAutomationText(body.result, 4000);
    if (typeof body.error === "string") job.error = cleanAutomationText(body.error, 1000);
    if (body.status === "pending") {
      job.error = "";
      job.claimedAt = "";
    }
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

const automationSchedulerTick = createAutomationSchedulerTick({
  readState: readAutomationState,
  runScan: runAutomationScan,
  runWeeklyReport,
  reconcile: catchupJiraReconciliationTick,
  onError: (name, error) => console.error(`${name} failed: ${error.message}`)
});

async function serveStatic(request, response, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const requestedPath = path.normalize(path.join(publicDir, decodeURIComponent(pathname)));

  if (!requestedPath.startsWith(publicDir)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  try {
    let content;
    if (pathname === "/meeting-snapshot.json") {
      const snapshotFile = process.env.DELIVERY_MEETING_SNAPSHOT_FILE || path.join(runtimeRoot, "meeting-snapshot.json");
      try { content = await fs.readFile(snapshotFile); }
      catch (error) { if (error.code !== "ENOENT") throw error; content = await fs.readFile(requestedPath); }
    } else content = await fs.readFile(requestedPath);
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(path.extname(requestedPath)) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(response, 404, "Not found");
      return;
    }
    sendError(response, 500, "Static file error", error.message);
  }
}

export async function handleJiraTaskCalendarRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendError(response, 405, "Method not allowed");
        return;
      }
      sendJson(response, 200, { ok: true, project: "APEX 重构追平" });
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(response, 200, {
        baseUrl: jiraBaseUrl,
        hasCredentials: Boolean(getAuthHeaders())
      });
      return;
    }

    if (url.pathname === "/api/issues") {
      const query = buildJql(url.searchParams);
      const payload = await fetchJiraIssues(query);
      sendJson(response, 200, payload);
      return;
    }

    if (url.pathname === "/api/users") {
      const payload = await fetchJiraUsers(url.searchParams.get("query"));
      sendJson(response, 200, payload);
      return;
    }

    if (url.pathname === "/api/automation/artifact") {
      if (request.method !== "GET") {
        sendError(response, 405, "Method not allowed");
        return;
      }
      const artifact = await readAutomationArtifact(url.searchParams);
      if (!artifact) {
        sendError(response, 404, "Automation artifact not found");
        return;
      }
      sendAutomationArtifact(response, artifact);
      return;
    }

    if (url.pathname === "/api/automation/catchup/dispatcher/manifest") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendError(response, 405, "Method not allowed");
        return;
      }
      sendJson(response, 200, {
        ...buildCatchupDispatcherManifest(),
        dispatcher: presentCatchupDispatcherState(await readCatchupDispatcherState())
      });
      return;
    }

    if (url.pathname === "/api/automation/catchup/dispatcher/update") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupDispatcherRequest(request)) {
        sendError(response, 403, "Catchup dispatcher must run from loopback");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = validateCatchupDispatcherUpdate(await readJsonBody(request));
        sendJson(response, 200, { dispatcher: await updateCatchupDispatcherState(body) });
      } catch (error) {
        if (error instanceof SyntaxError || error.message === "INVALID_CATCHUP_DISPATCHER_UPDATE") {
          sendError(response, 400, "Invalid catchup dispatcher update");
          return;
        }
        if (error.message === "Request body is too large") {
          sendError(response, 413, "Catchup dispatcher update is too large");
          return;
        }
        console.error(`Catchup dispatcher update failed: ${error.message}`);
        sendError(response, 503, "Catchup dispatcher state unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/dispatch") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupDispatcherRequest(request)) {
        sendError(response, 403, "Catchup dispatcher must run from loopback");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const limit = catchupDispatchLimit(await readJsonBody(request));
        const catchupResult = await claimCatchupDispatchJobFromFiles({
          catchupDataRoot,
          executionStateFile: catchupExecutionStateFile,
          sessionRegistryFile: catchupSessionsFile,
          limit,
          callbackUrl: `http://127.0.0.1:${port}/api/automation/catchup/jobs/update`
        });
        const remainingMergeSlots = Math.max(0, limit - catchupResult.jobs.length);
        if (remainingMergeSlots > 0) {
          const [mergeDashboard, sessionRegistry] = await Promise.all([
            getCatchupMergeDashboard(false),
            readCatchupSessionRegistry(catchupSessionsFile)
          ]);
          const mergeResult = await claimCatchupMergeJobFile({
            stateFile: catchupMergePipelineStateFile,
            dashboard: mergeDashboard,
            sessionRegistry,
            limit: remainingMergeSlots,
            callbackUrl: `http://127.0.0.1:${port}/api/automation/catchup/merge/jobs/update`,
            evidenceRoot: catchupMergeEvidenceRoot
          });
          catchupResult.jobs.push(...mergeResult.jobs);
          catchupResult.mergeRevision = mergeResult.state.revision;
        }
        sendJson(response, 200, catchupResult);
      } catch (error) {
        if (error instanceof SyntaxError || error.message === "INVALID_CATCHUP_DISPATCH_REQUEST") {
          sendError(response, 400, "Invalid catchup dispatch request");
          return;
        }
        if (error.message === "Request body is too large") {
          sendError(response, 413, "Catchup dispatch request is too large");
          return;
        }
        console.error(`Catchup dispatch failed: ${error.message}`);
        sendError(response, 503, "Catchup dispatcher unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/jobs/update") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupDispatcherRequest(request)) {
        sendError(response, 403, "Catchup dispatcher must run from loopback");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = validateCatchupJobUpdate(await readJsonBody(request));
        if (/^catchup-merge:REQ-(?:CU-)?\d{3}$/.test(body.id || "")) {
          const result = await updateCatchupMergeHandshakeFile({
            stateFile: catchupMergePipelineStateFile,
            body
          });
          sendJson(response, 200, {
            job: {
              id: body.id,
              status: body.status,
              threadId: result.state.sequence.threadId,
              hostId: result.state.sequence.hostId,
              clientThreadId: result.state.sequence.clientThreadId
            },
            revision: result.state.revision
          });
        } else {
          sendJson(response, 200, await updateCatchupDispatchJobFile({
            sessionRegistryFile: catchupSessionsFile,
            body
          }));
        }
      } catch (error) {
        if (error instanceof SyntaxError || [
          "INVALID_CATCHUP_JOB_UPDATE",
          "INVALID_CATCHUP_JOB_ID",
          "INVALID_CATCHUP_JOB_STATUS"
        ].includes(error.code || error.message) || String(error.code || "").startsWith("INVALID_CATCHUP_MERGE_")) {
          sendError(response, 400, "Invalid catchup job update");
          return;
        }
        if (error.code === "CATCHUP_JOB_NOT_FOUND") {
          sendError(response, 404, error.message);
          return;
        }
        if (
          String(error.code || "").startsWith("CATCHUP_JOB_")
          || String(error.code || "").startsWith("CATCHUP_MERGE_")
        ) {
          sendError(response, 409, error.message);
          return;
        }
        if (error.message === "Request body is too large") {
          sendError(response, 413, "Catchup job update is too large");
          return;
        }
        console.error(`Catchup job update failed: ${error.message}`);
        sendError(response, 503, "Catchup dispatcher unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendError(response, 405, "Method not allowed");
        return;
      }
      try {
        sendJson(response, 200, await getCatchupDashboard());
      } catch (error) {
        console.error(`Catchup source failed: ${error.message}`);
        sendError(response, 503, "Catchup source unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/merge-plan") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendError(response, 405, "Method not allowed");
        return;
      }
      try {
        sendJson(
          response,
          200,
          await getCatchupMergeDashboard(url.searchParams.get("refresh") === "1")
        );
      } catch (error) {
        console.error(`Catchup merge plan failed: ${error.message}`);
        sendError(response, 503, "Catchup merge plan unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/merge/jira-completion") {
      if (!["GET", "POST"].includes(request.method)) {
        response.setHeader("Allow", "GET, POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (request.method === "POST") {
        if (!isTrustedCatchupBrowserRequest(request)) {
          sendError(response, 403, "Untrusted catchup Jira request origin");
          return;
        }
        if (!hasJsonContentType(request)) {
          sendError(response, 415, "Content-Type must be application/json");
          return;
        }
      }
      try {
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!isPlainObject(body) || Object.keys(body).length > 0) {
            sendError(response, 400, "Invalid catchup Jira completion request");
            return;
          }
          if (catchupJiraCompletionPromise) {
            sendError(response, 409, "Catchup Jira completion sync is already running");
            return;
          }
        }

        const run = async () => {
          const [dashboard, automationState] = await Promise.all([
            getCatchupMergeDashboard(false),
            readAutomationState()
          ]);
          return reconcileMergedCatchupJiraCompletion(dashboard.items, {
            apply: request.method === "POST",
            targetStatus: automationState.settings.completedStatus
          });
        };
        if (request.method === "POST") {
          catchupJiraCompletionPromise = run();
          try {
            sendJson(response, 200, await catchupJiraCompletionPromise);
          } finally {
            catchupJiraCompletionPromise = null;
          }
        } else {
          sendJson(response, 200, await run());
        }
      } catch (error) {
        console.error(`Catchup Jira completion failed: ${cleanAutomationText(error.message, 300)}`);
        sendError(response, 503, "Catchup Jira completion unavailable", cleanAutomationText(error.message, 300));
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/merge/actions") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupBrowserRequest(request)) {
        sendError(response, 403, "Untrusted catchup merge request origin");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = validateCatchupMergeActionRequest(await readJsonBody(request));
        const dashboard = await getCatchupMergeDashboard(false);
        await applyCatchupMergeActionFile({
          stateFile: catchupMergePipelineStateFile,
          items: dashboard.items,
          body,
          evidenceRoot: catchupMergeEvidenceRoot
        });
        sendJson(response, 200, await getCatchupMergeDashboard(false));
      } catch (error) {
        if (
          error instanceof SyntaxError
          || error.message === "INVALID_CATCHUP_MERGE_ACTION_REQUEST"
          || error.code === "INVALID_CATCHUP_MERGE_ACTION"
        ) {
          sendError(response, 400, "Invalid catchup merge action");
          return;
        }
        if (String(error.code || "").startsWith("CATCHUP_MERGE_")) {
          sendError(response, 409, error.message);
          return;
        }
        if (error.message === "Request body is too large") {
          sendError(response, 413, "Catchup merge action is too large");
          return;
        }
        console.error(`Catchup merge action failed: ${error.message}`);
        sendError(response, 503, "Catchup merge pipeline unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/merge/jobs/update") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupDispatcherRequest(request)) {
        sendError(response, 403, "Catchup merge callback must run from loopback");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = validateCatchupMergeResultRequest(await readJsonBody(request));
        const dashboard = await getCatchupMergeDashboard(true);
        const item = dashboard.items.find((candidate) => (
          candidate.requirementId === body.requirementId
        ));
        if (!item) {
          sendError(response, 404, "Catchup merge item not found");
          return;
        }
        const result = await updateCatchupMergeResultFile({
          stateFile: catchupMergePipelineStateFile,
          item,
          body,
          evidenceRoot: catchupMergeEvidenceRoot
        });
        sendJson(response, 200, {
          job: {
            id: body.id,
            requirementId: body.requirementId,
            status: body.status
          },
          revision: result.state.revision
        });
      } catch (error) {
        if (
          error instanceof SyntaxError
          || error.message === "INVALID_CATCHUP_MERGE_RESULT_REQUEST"
          || String(error.code || "").startsWith("INVALID_CATCHUP_MERGE_")
        ) {
          sendError(response, 400, error.message || "Invalid catchup merge result");
          return;
        }
        if (String(error.code || "").startsWith("CATCHUP_MERGE_")) {
          sendError(response, 409, error.message);
          return;
        }
        if (error.message === "Request body is too large") {
          sendError(response, 413, "Catchup merge result is too large");
          return;
        }
        console.error(`Catchup merge result failed: ${error.message}`);
        sendError(response, 503, "Catchup merge pipeline unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/merge/evidence") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendError(response, 405, "Method not allowed");
        return;
      }
      const artifact = await readCatchupMergeEvidence(
        catchupMergeEvidenceRoot,
        url.searchParams.get("requirementId"),
        url.searchParams.get("filename")
      );
      if (!artifact) {
        sendError(response, 404, "Catchup merge evidence not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.mimeType || mimeTypes.get(artifact.extension) || "application/octet-stream",
        "Content-Length": artifact.content.length,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(artifact.content);
      return;
    }

    if (url.pathname === "/api/automation/catchup/actions") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupBrowserRequest(request)) {
        sendError(response, 403, "Untrusted catchup request origin");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = validateCatchupActionRequest(await readJsonBody(request));
        const [board, dispatcher] = await Promise.all([
          readCatchupBoard(catchupDataRoot),
          readCatchupDispatcherState()
        ]);
        const validRequirementIds = new Set(board.requirements.map((requirement) => requirement.id));
        if (body.requirementIds.some((requirementId) => !validRequirementIds.has(requirementId))) {
          sendError(response, 404, "Catchup requirement not found");
          return;
        }
        const result = await runCatchupExecutionAction(board, body);
        sendJson(response, 200, {
          updated: result.updated,
          preparationFailures: result.preparationFailures,
          jiraPending: result.jiraPending,
          board: {
            ...attachCatchupSessions(attachCatchupExecution(board, result.state), result.registry),
            dispatcher: presentCatchupDispatcherState(dispatcher)
          }
        });
        if (body.action === "start") {
          queueCatchupJiraReconciliation(result.updated);
        }
      } catch (error) {
        if (error instanceof SyntaxError || [
          "INVALID_CATCHUP_ACTION_REQUEST",
          "INVALID_ACTION",
          "INVALID_REQUIREMENT_IDS",
          "INVALID_REVISION"
        ].includes(error.message)) {
          sendError(response, 400, "Invalid catchup action request");
          return;
        }
        if (error.message === "Request body is too large") {
          sendError(response, 413, "Catchup action request is too large");
          return;
        }
        if (error.message === "UNKNOWN_REQUIREMENT_ID") {
          sendError(response, 404, "Catchup requirement not found");
          return;
        }
        if (error.message === "ADMIN_DELIVERY_EXCLUDED") {
          sendError(response, 409, "该需求已移出 Admin 交付，不再执行；冻结事实与历史记录保留");
          return;
        }
        if (error.message === "REVISION_CONFLICT") {
          sendError(response, 409, "Catchup state changed, refresh and retry");
          return;
        }
        if (error.message === "CATCHUP_SESSION_WORKSPACE_REQUIRED") {
          sendError(
            response,
            409,
            "Catchup session workspace is required before resuming AI",
            (error.requirementIds || []).join(", ")
          );
          return;
        }
        if (error.message === "INVALID_TRANSITION") {
          const conflicts = (error.conflicts || [])
            .map((item) => `${item.requirementId}:${item.status}`)
            .join(", ");
          sendError(response, 409, "Catchup action is not allowed", conflicts);
          return;
        }
        console.error(`Catchup action failed: ${error.message}`);
        sendError(response, 503, "Catchup execution state unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/sessions/open-cursor") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedCatchupOrigin(request)) {
        sendError(response, 403, "Untrusted catchup request origin");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (
          !body
          || typeof body !== "object"
          || Array.isArray(body)
          || Object.keys(body).length !== 1
          || typeof body.requirementId !== "string"
        ) {
          sendError(response, 400, "requirementId is required");
          return;
        }

        const [board, executionState, sessionRegistry] = await Promise.all([
          readCatchupBoard(catchupDataRoot),
          readCatchupExecutionState(catchupExecutionStateFile),
          readCatchupSessionRegistry(catchupSessionsFile)
        ]);
        const dashboard = attachCatchupSessions(
          attachCatchupExecution(board, executionState),
          sessionRegistry
        );
        const requirement = dashboard.requirements.find((item) => item.id === body.requirementId);
        if (!requirement) {
          sendError(response, 404, "Catchup requirement not found");
          return;
        }
        if (requirement.execution.exclusionReason) {
          sendError(response, 409, requirement.execution.exclusionReason);
          return;
        }
        if (!["IN_PROGRESS", "PAUSED"].includes(requirement.execution.status)) {
          sendError(response, 409, "Start the catchup requirement before opening Cursor");
          return;
        }

        sendJson(
          response,
          200,
          await openCatchupSessionInCursor(sessionRegistry, body.requirementId)
        );
      } catch (error) {
        if (["INVALID_REQUIREMENT_ID", "SESSION_WORKSPACE_UNCONFIGURED", "SESSION_BRANCH_UNCONFIGURED", "SESSION_BASE_SHA_INVALID"].includes(error.code)) {
          sendError(response, 400, error.message);
          return;
        }
        if (["SESSION_NOT_FOUND", "WORKSPACE_NOT_FOUND"].includes(error.code)) {
          sendError(response, 404, error.message);
          return;
        }
        if (error.code === "WORKSPACE_OUTSIDE_REQUIREMENTS_ROOT") {
          sendError(response, 403, error.message);
          return;
        }
        if (["WORKSPACE_GIT_TOP_LEVEL_MISMATCH", "WORKSPACE_BRANCH_MISMATCH", "WORKSPACE_BASE_NOT_ANCESTOR"].includes(error.code)) {
          sendError(response, 409, error.message);
          return;
        }
        console.error(`Open catchup session in Cursor failed: ${error.message}`);
        sendError(response, 503, "Catchup session unavailable");
      }
      return;
    }

    if (url.pathname === "/api/automation/catchup/document") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendError(response, 405, "Method not allowed");
        return;
      }
      let document;
      try {
        document = await readCatchupDocument(
          catchupDataRoot,
          url.searchParams.get("type"),
          url.searchParams.get("id")
        );
      } catch (error) {
        console.error(`Catchup document failed: ${error.message}`);
        sendError(response, 503, "Catchup source unavailable");
        return;
      }
      if (!document) {
        sendError(response, 404, "Catchup document not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": "inline",
        "Cache-Control": "no-store"
      });
      response.end(document.content);
      return;
    }

    if (url.pathname === "/api/meeting/confluence-sync") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendError(response, 405, "Method not allowed");
        return;
      }
      if (!isTrustedMeetingBrowserRequest(request)) {
        sendError(response, 403, "Untrusted meeting request origin");
        return;
      }
      if (!hasJsonContentType(request)) {
        sendError(response, 415, "Content-Type must be application/json");
        return;
      }
      try {
        const body = await readJsonBody(request, 32 * 1024);
        if (
          !isPlainObject(body)
          || typeof body.pageId !== "string"
          || typeof body.taskId !== "string"
          || typeof body.text !== "string"
          || Object.keys(body).some((key) => !["pageId", "taskId", "text"].includes(key))
        ) {
          sendError(response, 400, "pageId, taskId and text are required");
          return;
        }
        sendJson(response, 200, await syncMeetingTaskToConfluence(body));
      } catch (error) {
        if (error instanceof SyntaxError || error.message === "Request body is too large") {
          sendError(response, error.message === "Request body is too large" ? 413 : 400, "Invalid meeting sync request");
          return;
        }
        if (["MEETING_TASK_NOT_FOUND"].includes(error.code)) {
          sendError(response, 409, error.message);
          return;
        }
        if (error.code === "CONFLUENCE_AUTH_REQUIRED") {
          sendError(response, 409, "Confluence 鉴权未配置或已失效，本地草稿已保留");
          return;
        }
        if (/鉴权|页面不是当前月份|内容或版本不可用|页面 ID|任务 ID|内容不能为空/.test(error.message)) {
          sendError(response, 409, error.message);
          return;
        }
        console.error(`Meeting Confluence sync failed: ${error.message}`);
        sendError(response, 503, "Confluence 同步失败");
      }
      return;
    }

    if (url.pathname === "/api/automation" && request.method === "GET") {
      sendJson(response, 200, await getAutomationDashboard());
      return;
    }

    if (url.pathname === "/api/automation/weekly-report/generate") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }
      try {
        const run = await runWeeklyReport("manual");
        sendJson(response, 200, { message: "周报已生成", run, dashboard: await getAutomationDashboard() });
      } catch (error) {
        sendError(response, 503, "周报生成失败", error.message);
      }
      return;
    }

    if (url.pathname === "/api/automation/settings") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }

      const body = await readJsonBody(request);
      await mutateAutomationState((state) => {
        state.settings = sanitizeAutomationSettings(body, state.settings);
      });
      sendJson(response, 200, await getAutomationDashboard());
      return;
    }

    if (url.pathname === "/api/automation/scan") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }

      const run = await runAutomationScan("manual");
      sendJson(response, 200, { run, dashboard: await getAutomationDashboard() });
      return;
    }

    if (url.pathname === "/api/automation/dispatch") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }

      const body = await readJsonBody(request);
      sendJson(response, 200, { jobs: await claimAutomationJobs(body.limit) });
      return;
    }

    if (url.pathname === "/api/automation/jobs/update") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }

      const body = await readJsonBody(request, 64 * 1024);
      if (typeof body.id !== "string") {
        sendError(response, 400, "id is required");
        return;
      }
      const job = await updateAutomationJob(body);
      if (job?.cliClaimSuperseded) {
        sendError(response, 409, "追平调度任务已进入终态");
        return;
      }
      if (!job) {
        sendError(response, 404, "Automation job not found");
        return;
      }
      sendJson(response, 200, { job });
      if (["review", "completed"].includes(body.status)) {
        setTimeout(() => {
          runAutomationScan("callback").catch((error) => {
            console.error(`Automation callback scan failed: ${error.message}`);
          });
        }, 0);
      }
      return;
    }

    if (url.pathname === "/api/local-projects" && request.method === "GET") {
      const payload = await getLocalProjects(url.searchParams.get("refresh") === "true");
      sendJson(response, 200, payload);
      return;
    }

    if (url.pathname === "/api/local-projects/label") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }

      const body = await readJsonBody(request);
      if (typeof body.projectId !== "string") {
        sendError(response, 400, "projectId is required");
        return;
      }

      const result = await updateLocalProjectDisplayName(body.projectId, body.displayName);
      if (!result) {
        sendError(response, 404, "Local project not found");
        return;
      }

      sendJson(response, 200, result);
      return;
    }

    if (url.pathname === "/api/local-projects/open") {
      if (request.method !== "POST") {
        sendError(response, 405, "Method not allowed");
        return;
      }

      const body = await readJsonBody(request);
      if (typeof body.path !== "string") {
        sendError(response, 400, "path is required");
        return;
      }

      if (!await openLocalProjectFolder(body.path)) {
        sendError(response, 403, "Folder is outside the scanned projects");
        return;
      }

      sendJson(response, 200, { opened: true, path: body.path });
      return;
    }

    await serveStatic(request, response, url);
  } catch (error) {
    sendError(response, error.code === "JIRA_AUTH_UNAVAILABLE" ? 503 : 500, "Request failed", error.message);
  }
}

const server = http.createServer(handleJiraTaskCalendarRequest);

let schedulerStartup = null;
let schedulerInterval = null;

export function startAutomationScheduler() {
  if (schedulerInterval) return;
  schedulerStartup = setTimeout(() => {
    automationSchedulerTick().catch((error) => {
      console.error(`Automation scheduler failed: ${error.message}`);
    });
  }, 2000);
  schedulerStartup.unref();
  schedulerInterval = setInterval(() => {
    automationSchedulerTick().catch((error) => {
      console.error(`Automation scheduler failed: ${error.message}`);
    });
  }, 60_000);
  schedulerInterval.unref();
}

export function stopAutomationScheduler() {
  if (schedulerStartup) clearTimeout(schedulerStartup);
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerStartup = null;
  schedulerInterval = null;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.env.NODE_ENV !== "test") {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Jira Task Calendar: http://localhost:${port}`);
    startAutomationScheduler();
  });
}

export {
  buildJql,
  buildOrderBy,
  claimAutomationJobs,
  getCatchupMergeDashboard,
  getLocalProjectId,
  getLocalProjects,
  getSuggestedLocalProjectName,
  parseGitRemote,
  parseGitStatus,
  performAutomationScan,
  sanitizeLocalProjectDisplayName,
  server
};
