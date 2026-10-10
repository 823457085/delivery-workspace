import fs from "node:fs/promises";
import { sourceDataRoot, gitBinary } from "./config.mjs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

/**
 * 设计说明：追平会话登记与需求事实、执行生命周期分开读取，避免打开编辑器时改写
 * 需求或执行状态。这里只有已经显式登记的工作区可被附加和打开；打开前重新核对
 * 固定根目录、Git 顶层、分支和基线祖先，且不负责创建、切换或删除 worktree。
 */

export const CATCHUP_REQUIREMENTS_ROOT = process.env.APEX_CATCHUP_REQUIREMENTS_ROOT
  || path.join(sourceDataRoot, "workspaces", "requirements");
export const CATCHUP_CURSOR_BINARY = process.env.DELIVERY_CURSOR_EDITOR_BIN || "cursor";

const execFileAsync = promisify(execFileCallback);
const requirementIdPattern = /^REQ-(?:CU-)?\d{3}$/;

export class CatchupSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatchupSessionError";
    this.code = code;
  }
}

function cleanText(value, maxLength = 200) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength)
    : "";
}

function normalizeSession(value = {}) {
  const workspace = value?.workspace && typeof value.workspace === "object"
    ? value.workspace
    : {};
  const session = value?.session && typeof value.session === "object"
    ? value.session
    : value;
  return {
    workspacePath: cleanText(value.workspacePath || workspace.path, 2000),
    branch: cleanText(value.branch || workspace.branch, 300),
    baseSha: cleanText(value.baseSha || workspace.baseSha, 80).toLowerCase(),
    provider: cleanText(session.provider, 40),
    status: cleanText(session.status || value.status, 40),
    jobId: cleanText(session.jobId || value.jobId, 200),
    sessionId: cleanText(session.sessionId || value.sessionId, 200),
    threadId: cleanText(session.threadId, 200),
    hostId: cleanText(session.hostId, 200),
    clientThreadId: cleanText(session.clientThreadId, 200),
    cursorChatId: cleanText(session.cursorChatId, 200),
    handoffPath: cleanText(session.handoffPath || value.handoffPath, 2000),
    jiraKey: cleanText(session.jiraKey || value.jiraKey, 100),
    jiraUrl: cleanText(session.jiraUrl || value.jiraUrl, 1000),
    jiraStatus: cleanText(session.jiraStatus || value.jiraStatus, 40),
    jiraError: cleanText(session.jiraError || value.jiraError, 1000),
    claimedAction: cleanText(session.claimedAction, 40),
    claimedAt: cleanText(session.claimedAt, 80),
    claimToken: cleanText(session.claimToken, 200),
    lastDispatchedExecutionSequence: Number.isInteger(session.lastDispatchedExecutionSequence)
      && session.lastDispatchedExecutionSequence >= 0
      ? session.lastDispatchedExecutionSequence
      : 0,
    lastDispatchedExecutionUpdatedAt: cleanText(session.lastDispatchedExecutionUpdatedAt, 80),
    result: cleanText(session.result, 4000),
    error: cleanText(session.error, 1000),
    createdAt: cleanText(session.createdAt || value.createdAt, 80),
    updatedAt: cleanText(value.updatedAt || session.updatedAt, 80)
  };
}

export function makeDefaultCatchupSessionRegistry() {
  return {
    version: 1,
    revision: 0,
    updatedAt: "",
    requirements: {}
  };
}

export function normalizeCatchupSessionRegistry(value = {}) {
  const registry = makeDefaultCatchupSessionRegistry();
  if (!value || typeof value !== "object" || Array.isArray(value)) return registry;
  registry.revision = Number.isInteger(value.revision) && value.revision >= 0
    ? value.revision
    : 0;
  registry.updatedAt = cleanText(value.updatedAt, 80);
  if (!value.requirements || typeof value.requirements !== "object" || Array.isArray(value.requirements)) {
    return registry;
  }
  registry.requirements = Object.fromEntries(
    Object.entries(value.requirements)
      .filter(([requirementId]) => requirementIdPattern.test(requirementId))
      .map(([requirementId, session]) => [requirementId, normalizeSession(session)])
  );
  return registry;
}

export async function readCatchupSessionRegistry(filename) {
  try {
    return normalizeCatchupSessionRegistry(JSON.parse(await fs.readFile(filename, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return makeDefaultCatchupSessionRegistry();
    throw new CatchupSessionError("SESSION_REGISTRY_UNAVAILABLE", "追平会话登记不可用");
  }
}

export function attachCatchupSessions(board, registry) {
  const normalized = normalizeCatchupSessionRegistry(registry);
  return {
    ...board,
    sessionRegistryRevision: normalized.revision,
    sessionRegistryUpdatedAt: normalized.updatedAt || null,
    requirements: (board.requirements || []).map((requirement) => ({
      ...requirement,
      session: toPublicCatchupSession(
        normalized.requirements[requirement.id],
        requirement.execution
      )
    }))
  };
}

function hasPendingExecutionEvent(session, execution) {
  if (!session || !execution?.lastAction) return false;
  if (Number.isInteger(execution.sequence) && execution.sequence > 0) {
    return execution.sequence > session.lastDispatchedExecutionSequence;
  }
  if (!execution.updatedAt || !session.lastDispatchedExecutionUpdatedAt) {
    return Boolean(execution.updatedAt);
  }
  return execution.updatedAt > session.lastDispatchedExecutionUpdatedAt;
}

function toPublicCatchupSession(session, execution) {
  if (!session) return null;
  const { claimToken: _claimToken, ...publicSession } = session;
  return hasPendingExecutionEvent(session, execution)
    ? { ...publicSession, status: "queued" }
    : publicSession;
}

async function defaultRunGit(args, options) {
  const { stdout } = await execFileAsync(gitBinary, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 5000
  });
  return stdout;
}

function fail(code, message) {
  throw new CatchupSessionError(code, message);
}

export async function validateCatchupSessionWorkspace(
  registry,
  requirementId,
  { realpath = fs.realpath, runGit = defaultRunGit } = {}
) {
  if (!requirementIdPattern.test(String(requirementId || ""))) {
    fail("INVALID_REQUIREMENT_ID", "追平需求 ID 无效");
  }

  const session = normalizeCatchupSessionRegistry(registry).requirements[requirementId];
  if (!session) fail("SESSION_NOT_FOUND", "追平需求尚未登记会话");
  if (!session.workspacePath) fail("SESSION_WORKSPACE_UNCONFIGURED", "追平会话尚未登记工作区");
  if (!session.branch) fail("SESSION_BRANCH_UNCONFIGURED", "追平会话尚未登记分支");
  if (!/^[0-9a-f]{40}$/.test(session.baseSha)) {
    fail("SESSION_BASE_SHA_INVALID", "追平会话基线提交无效");
  }

  let requirementsRoot;
  try {
    requirementsRoot = await realpath(CATCHUP_REQUIREMENTS_ROOT);
  } catch {
    fail("REQUIREMENTS_ROOT_UNAVAILABLE", "追平需求根目录不可用");
  }

  let workspacePath;
  try {
    workspacePath = await realpath(session.workspacePath);
  } catch {
    fail("WORKSPACE_NOT_FOUND", "追平需求工作区不存在");
  }
  const relativeWorkspace = path.relative(requirementsRoot, workspacePath);
  if (!relativeWorkspace || relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
    fail("WORKSPACE_OUTSIDE_REQUIREMENTS_ROOT", "追平需求工作区不在固定根目录下");
  }

  let gitTopLevel;
  try {
    const output = await runGit(["rev-parse", "--show-toplevel"], { cwd: workspacePath });
    gitTopLevel = await realpath(String(output || "").trim());
  } catch {
    fail("WORKSPACE_NOT_GIT_REPOSITORY", "追平需求工作区不是可用的 Git 仓库");
  }
  if (gitTopLevel !== workspacePath) {
    fail("WORKSPACE_GIT_TOP_LEVEL_MISMATCH", "Git 顶层目录与追平需求工作区不一致");
  }

  let branch;
  try {
    branch = String(await runGit(["branch", "--show-current"], { cwd: workspacePath })).trim();
  } catch {
    fail("WORKSPACE_BRANCH_UNAVAILABLE", "无法读取追平需求工作区分支");
  }
  if (branch !== session.branch) {
    fail("WORKSPACE_BRANCH_MISMATCH", "追平需求工作区分支与登记不一致");
  }

  try {
    await runGit(["merge-base", "--is-ancestor", session.baseSha, "HEAD"], { cwd: workspacePath });
  } catch {
    fail("WORKSPACE_BASE_NOT_ANCESTOR", "追平会话基线不是当前 HEAD 的祖先");
  }

  return {
    requirementId,
    workspacePath,
    branch,
    baseSha: session.baseSha,
    session
  };
}

export async function openCatchupSessionInCursor(
  registry,
  requirementId,
  { realpath = fs.realpath, runGit = defaultRunGit, executeFile = execFileAsync } = {}
) {
  const workspace = await validateCatchupSessionWorkspace(registry, requirementId, {
    realpath,
    runGit
  });
  try {
    await executeFile(
      CATCHUP_CURSOR_BINARY,
      ["--new-window", workspace.workspacePath],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5000 }
    );
  } catch {
    fail("CURSOR_OPEN_FAILED", "无法在 Cursor 中打开追平需求工作区");
  }
  return {
    opened: true,
    requirementId,
    workspacePath: workspace.workspacePath,
    branch: workspace.branch
  };
}
