import { execFile, spawn as spawnChild } from "node:child_process";
import { gitBinary } from "./config.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CATCHUP_MERGE_WORKSPACE } from "./catchup-merge-pipeline.mjs";
import {
  CATCHUP_REQUIREMENTS_ROOT,
  validateCatchupSessionWorkspace
} from "./catchup-sessions.mjs";
import {
  AtomicCatchupCliLedger,
  CATCHUP_CLI_LOCK_FILE,
  CatchupCliDispatcherError,
  acquireCatchupCliLock
} from "./catchup-cli-state.mjs";

export { AtomicCatchupCliLedger, CatchupCliDispatcherError, acquireCatchupCliLock };

/**
 * 设计说明：Desktop 动态工具不可用时，本模块只充当本地 HTTP 调度协议与 Codex CLI
 * 之间的适配器。服务端仍是 lifecycle、claim token 和 session 的唯一写入方；适配器
 * 只保留防止崩溃后重复创建 task 的最小运行账本，并按真实 workspace/thread 串行。
 */

export const CATCHUP_CODEX_BINARY = process.env.DELIVERY_CODEX_BIN || "codex";
export const CATCHUP_CLI_DISPATCHER_ID =
  "delivery-workspace:catchup-cli-dispatcher";
export const CATCHUP_CLI_ENDPOINT = process.env.CATCHUP_CLI_ENDPOINT
  || `http://127.0.0.1:${process.env.DELIVERY_PORT || process.env.PORT || 5199}`;
export const CATCHUP_CLI_MAX_CONCURRENT = 8;
export const CATCHUP_CLI_JOB_TIMEOUT_MS = 60 * 60 * 1000;
export const CATCHUP_CLI_KILL_GRACE_MS = 10 * 1000;

const requirementIdPattern = /^REQ-(?:CU-)?\d{3}$/;
const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jiraJobPattern = /^[A-Z][A-Z0-9]*-\d+:(design|implementation|verification|compliance)$/;
const implementationActions = new Set(["start", "resume", "deliver"]);
const controlActions = new Set(["pause", "finish"]);
const claimMismatchMessage = "追平调度任务领取令牌已失效";
const mergeClaimMismatchMessage = "合入任务领取令牌已失效";
const terminalJobMessage = "追平调度任务已进入终态";
const mergeTerminalMessage = "合入任务已结束调度阶段";
const execFileAsync = promisify(execFile);

export class CatchupCliHttpError extends CatchupCliDispatcherError {
  constructor(status, message, payload) {
    super("CATCHUP_CLI_HTTP_ERROR", message, { status, payload });
  }
}

function cleanText(value, maxLength = 1000) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength)
    : "";
}

function fail(code, message, details) {
  throw new CatchupCliDispatcherError(code, message, details);
}

function loopbackEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail("CATCHUP_CLI_ENDPOINT_INVALID", "追平 CLI 调度端点无效");
  }
  if (
    endpoint.protocol !== "http:"
    || endpoint.hostname !== "127.0.0.1"
    || endpoint.username
    || endpoint.password
    || !["", "/"].includes(endpoint.pathname)
    || endpoint.search
    || endpoint.hash
  ) {
    fail("CATCHUP_CLI_ENDPOINT_NOT_LOOPBACK", "追平 CLI 调度器只允许访问 127.0.0.1");
  }
  return endpoint.origin;
}

function normalizeJob(value) {
  const id = cleanText(value?.id, 100);
  const jira = jiraJobPattern.test(id);
  const requirementId = cleanText(value?.requirementId || (jira ? id.split(":")[0] : ""), 40);
  const action = cleanText(value?.action || (jira ? "start" : ""), 20);
  const kind = jira ? "jira" : id === `catchup-merge:${requirementId}` ? "merge" : "catchup";
  const actionAllowed = kind === "merge"
    ? new Set(["start", "deliver"]).has(action)
    : implementationActions.has(action) || controlActions.has(action);
  if (
    (!jira && (!requirementIdPattern.test(requirementId)
      || ![`catchup:${requirementId}`, `catchup-merge:${requirementId}`].includes(id)))
    || !actionAllowed
    || typeof value?.prompt !== "string"
    || !value.prompt
    || !cleanText(value.claimToken, 200)
  ) {
    fail("CATCHUP_CLI_JOB_INVALID", "追平 CLI job 无效");
  }
  const threadId = cleanText(value.threadId, 200);
  if (threadId && !threadIdPattern.test(threadId)) {
    fail("CATCHUP_CLI_THREAD_ID_INVALID", "追平 CLI threadId 无效");
  }
  return {
    id,
    kind,
    requirementId,
    action,
    claimToken: cleanText(value.claimToken, 200),
    prompt: value.prompt,
    workspacePath: cleanText(value.workspacePath, 2000),
    branch: cleanText(value.branch, 300),
    baseSha: cleanText(value.baseSha, 80).toLowerCase(),
    threadId,
    clientThreadId: cleanText(value.clientThreadId, 200)
  };
}

export function createCatchupCliApi({
  endpoint = CATCHUP_CLI_ENDPOINT,
  fetchImpl = globalThis.fetch,
  includeJira = false
} = {}) {
  const origin = loopbackEndpoint(endpoint);
  if (typeof fetchImpl !== "function") fail("CATCHUP_CLI_FETCH_UNAVAILABLE", "本地 HTTP 客户端不可用");

  async function request(pathname, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new CatchupCliDispatcherError(
        "CATCHUP_CLI_HTTP_UNAVAILABLE",
        cleanText(error?.message, 500) || "追平本地服务不可用"
      );
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new CatchupCliHttpError(
        response.status,
        cleanText(payload?.error || payload?.message, 500) || `HTTP ${response.status}`,
        payload
      );
    }
    return payload;
  }

  return {
    health: () => request("/api/health"),
    manifest: () => request("/api/automation/catchup/dispatcher/manifest"),
    updateDispatcher: (body) => request("/api/automation/catchup/dispatcher/update", {
      method: "POST",
      body
    }),
    claim: async (limit = 1) => {
      const payload = await request("/api/automation/catchup/dispatch", {
        method: "POST",
        body: { limit }
      });
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      // 已领取追平任务后立即交给运行账本；不得因另一个队列请求失败而丢失这些领取。
      if (!includeJira || jobs.length) return jobs;
      const state = await request("/api/automation");
      const active = state.jobs.filter((job) => ["dispatching", "dispatched", "running"].includes(job.status));
      const remaining = Math.max(0, limit - jobs.length - active.length);
      if (!remaining) return jobs;
      const jira = await request("/api/automation/dispatch", { method: "POST", body: { limit: remaining } });
      return [...jobs, ...jira.jobs.map((job) => ({ ...job, claimToken: job.claimedAt }))];
    },
    updateJob: async (body) => {
      if (includeJira && jiraJobPattern.test(body.id)) {
        const state = await request("/api/automation");
        const current = state.jobs.find((job) => job.id === body.id);
        if (!current || current.claimedAt !== body.claimToken || !["dispatching", "dispatched", "running"].includes(current.status)) {
          throw new CatchupCliHttpError(409, terminalJobMessage, { error: terminalJobMessage });
        }
        return request("/api/automation/jobs/update", { method: "POST", body: { ...body, expectedClaimedAt: body.claimToken } });
      }
      return request("/api/automation/catchup/jobs/update", { method: "POST", body });
    }
  };
}

export async function validateCatchupCliJobWorkspace(job, options = {}) {
  const normalized = normalizeJob(job);
  if (normalized.kind === "jira") {
    if (!path.isAbsolute(normalized.workspacePath) || !normalized.branch) {
      fail("CLI_WORKSPACE_MISSING", "Jira 任务缺少已登记的绝对工作目录或分支，请补齐后重试");
    }
    const realpath = options.realpath || fs.realpath;
    const workspacePath = await realpath(normalized.workspacePath);
    const runGit = options.runGit || (async (args, opts) => (await execFileAsync(gitBinary, args, { cwd: opts.cwd, timeout: 5000 })).stdout);
    const root = await realpath(String(await runGit(["rev-parse", "--show-toplevel"], { cwd: workspacePath })).trim());
    const branch = String(await runGit(["branch", "--show-current"], { cwd: workspacePath })).trim();
    if (root !== workspacePath || branch !== normalized.branch) {
      fail("CLI_WORKSPACE_MISMATCH", "Jira 任务实际 Git 工作区或分支与登记信息不一致");
    }
    return { workspacePath, branch };
  }
  if (normalized.kind === "merge") {
    const realpath = options.realpath || fs.realpath;
    const runGit = options.runGit || (async (args, runOptions) => {
      const { stdout } = await execFileAsync(gitBinary, args, {
        cwd: runOptions.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5000
      });
      return stdout;
    });
    if (!/^[0-9a-f]{40}$/.test(normalized.baseSha)) {
      fail("CATCHUP_CLI_MERGE_BASE_SHA_INVALID", "合入任务基线提交无效");
    }

    let workspacePath;
    let allowedRoot;
    try {
      workspacePath = await realpath(normalized.workspacePath);
      allowedRoot = await realpath(
        normalized.action === "deliver" ? CATCHUP_MERGE_WORKSPACE : CATCHUP_REQUIREMENTS_ROOT
      );
    } catch {
      fail("CATCHUP_CLI_MERGE_WORKSPACE_NOT_FOUND", "合入任务工作区不存在");
    }
    const relativeWorkspace = path.relative(allowedRoot, workspacePath);
    if (normalized.action === "deliver") {
      if (relativeWorkspace) {
        fail("CATCHUP_CLI_MERGE_WORKSPACE_MISMATCH", "交付任务不在固定目标工作区");
      }
    } else if (!relativeWorkspace || relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
      fail("CATCHUP_CLI_MERGE_WORKSPACE_MISMATCH", "预演任务不在固定需求根目录");
    }

    let gitTopLevel;
    let branch;
    try {
      gitTopLevel = await realpath(String(
        await runGit(["rev-parse", "--show-toplevel"], { cwd: workspacePath })
      ).trim());
      branch = String(await runGit(["branch", "--show-current"], { cwd: workspacePath })).trim();
    } catch {
      fail("CATCHUP_CLI_MERGE_GIT_UNAVAILABLE", "合入任务工作区不是可用的 Git 仓库");
    }
    if (gitTopLevel !== workspacePath) {
      fail("CATCHUP_CLI_MERGE_GIT_TOP_LEVEL_MISMATCH", "Git 顶层目录与合入工作区不一致");
    }
    if (branch !== normalized.branch) {
      fail("CATCHUP_CLI_MERGE_BRANCH_MISMATCH", "合入工作区分支与任务不一致");
    }
    try {
      await runGit(["merge-base", "--is-ancestor", normalized.baseSha, "HEAD"], { cwd: workspacePath });
    } catch {
      fail("CATCHUP_CLI_MERGE_BASE_NOT_ANCESTOR", "合入任务基线不是当前 HEAD 的祖先");
    }
    return {
      requirementId: normalized.requirementId,
      workspacePath,
      branch,
      baseSha: normalized.baseSha
    };
  }
  return validateCatchupSessionWorkspace({
    requirements: {
      [normalized.requirementId]: {
        workspacePath: normalized.workspacePath,
        branch: normalized.branch,
        baseSha: normalized.baseSha
      }
    }
  }, normalized.requirementId, options);
}

export function buildCatchupCodexInvocation(
  job,
  workspacePath,
  codexBinary = CATCHUP_CODEX_BINARY
) {
  const normalized = normalizeJob(job);
  const common = [
    "--approve-for-me",
    "-C",
    workspacePath,
    "exec",
    "--thread-source",
    "cli",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'service_tier="default"'
  ];
  const args = normalized.threadId
    ? [...common, "resume", "--json", normalized.threadId, "-"]
    : [...common, "--json", "-"];
  return { file: codexBinary, args };
}

function threadIdFromEvent(event) {
  const value = cleanText(event?.thread_id || event?.threadId || event?.thread?.id, 200);
  return threadIdPattern.test(value) ? value : "";
}

export async function runCatchupCodexProcess(job, {
  workspacePath,
  codexBinary = CATCHUP_CODEX_BINARY,
  spawnImpl = spawnChild,
  env = process.env,
  onSpawn = async () => {},
  onThreadStarted = async () => {},
  timeoutMs = CATCHUP_CLI_JOB_TIMEOUT_MS,
  killGraceMs = CATCHUP_CLI_KILL_GRACE_MS,
  signalProcess = process.kill
} = {}) {
  const normalized = normalizeJob(job);
  const invocation = buildCatchupCodexInvocation(normalized, workspacePath, codexBinary);
  const child = spawnImpl(invocation.file, invocation.args, {
    cwd: workspacePath,
    env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let threadId = normalized.threadId;
  let stdoutBuffer = "";
  let stderr = "";
  let eventChain = Promise.resolve().then(() => onSpawn({ pid: child.pid || 0 }));
  // 回调异常留待退出路径统一上报，避免异步 JSON 事件造成宿主未处理拒绝。
  eventChain.catch(() => {});

  const handleLine = (line) => {
    if (!line.trim()) return;
    eventChain = eventChain.then(async () => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "thread.started") {
        const startedThreadId = threadIdFromEvent(event);
        if (!startedThreadId) fail("CATCHUP_CLI_THREAD_ID_INVALID", "Codex CLI 未返回有效 threadId");
        if (threadId && threadId !== startedThreadId) {
          fail("CATCHUP_CLI_THREAD_MISMATCH", "Codex CLI 返回了不同的 threadId");
        }
        threadId = startedThreadId;
        await onThreadStarted(threadId);
      }
    });
    eventChain.catch(() => {});
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    lines.forEach(handleLine);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(normalized.prompt, "utf8");

  let timedOut = false;
  let forceTimer;
  const signalTree = (signal) => {
    if (!child.pid) return;
    try {
      signalProcess(-child.pid, signal);
    } catch {
      child.kill?.(signal);
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    signalTree("SIGTERM");
    forceTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
    forceTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  clearTimeout(forceTimer);
  if (stdoutBuffer) handleLine(stdoutBuffer);
  await eventChain;
  return {
    ...exit,
    threadId,
    timedOut,
    stderr: cleanText(stderr, 1000)
  };
}

class ResourceGate {
  constructor() {
    this.active = new Set();
    this.waiters = [];
  }

  async run(keys, operation) {
    const resources = [...new Set(keys.filter(Boolean))].sort();
    while (resources.some((key) => this.active.has(key))) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    resources.forEach((key) => this.active.add(key));
    try {
      return await operation();
    } finally {
      resources.forEach((key) => this.active.delete(key));
      const waiters = this.waiters.splice(0);
      waiters.forEach((resolve) => resolve());
    }
  }
}

class CapacityGate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(operation) {
    while (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class CatchupCliDispatcher {
  constructor({
    api = createCatchupCliApi(),
    ledger = new AtomicCatchupCliLedger(),
    lockFile = CATCHUP_CLI_LOCK_FILE,
    acquireLock = acquireCatchupCliLock,
    validateWorkspace = validateCatchupCliJobWorkspace,
    runCodex = runCatchupCodexProcess,
    codexBinary = CATCHUP_CODEX_BINARY,
    maxConcurrent = CATCHUP_CLI_MAX_CONCURRENT
  } = {}) {
    this.api = api;
    this.ledger = ledger;
    this.lockFile = lockFile;
    this.acquireLock = acquireLock;
    this.validateWorkspace = validateWorkspace;
    this.runCodex = runCodex;
    this.codexBinary = codexBinary;
    this.dispatcherId = CATCHUP_CLI_DISPATCHER_ID;
    this.maxConcurrent = Math.min(
      Math.max(Number(maxConcurrent) || CATCHUP_CLI_MAX_CONCURRENT, 1),
      CATCHUP_CLI_MAX_CONCURRENT
    );
    this.resourceGate = new ResourceGate();
    this.processGate = new CapacityGate(this.maxConcurrent);
    this.running = new Set();
    this.releaseLock = null;
    this.initialized = false;
    this.stopping = false;
    this.lastError = null;
  }

  async recoverOrphans() {
    const entries = Object.entries((await this.ledger.read()).runs);
    const alive = entries.filter(([, run]) => {
      if (!Number.isInteger(run.pid) || run.pid <= 0) return false;
      try {
        process.kill(run.pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    });
    if (alive.length) {
      fail("CATCHUP_CLI_ORPHANED_RUN", "存在仍在运行的追平 CLI 子进程，拒绝重复启动");
    }
    for (const [runId, run] of entries) {
      if (run.jobId && run.claimToken) {
        try {
          await this.api.updateJob({
            id: run.jobId,
            claimToken: run.claimToken,
            status: "blocked",
            hostId: "local-cli-dispatcher",
            ...(run.threadId ? { threadId: run.threadId } : {}),
            error: "CLI 调度进程异常退出，已清理孤儿运行；保留工作树并等待重试"
          });
        } catch (error) {
          if (!(error instanceof CatchupCliHttpError) || error.status !== 409) throw error;
        }
      }
      await this.ledger.remove(runId);
    }
  }

  assertNoActiveDesktopDispatcher(manifest) {
    const dispatcher = manifest?.dispatcher || {};
    if (
      dispatcher.status === "active"
      && dispatcher.automationId
      && dispatcher.automationId !== this.dispatcherId
    ) {
      fail("CATCHUP_CLI_DESKTOP_DISPATCHER_ACTIVE", "Desktop heartbeat 已启用，拒绝启动 CLI 调度器");
    }
    if (dispatcher.status === "active" && !dispatcher.automationId) {
      fail("CATCHUP_CLI_DISPATCHER_OWNER_UNKNOWN", "存在无法确认归属的 active 调度器");
    }
    return dispatcher;
  }

  async initialize() {
    if (this.initialized) return;
    this.releaseLock = await this.acquireLock(this.lockFile);
    try {
      await this.api.health();
      await this.recoverOrphans();
      await this.ledger.assertNoOrphans();
      const manifest = await this.api.manifest();
      const dispatcher = this.assertNoActiveDesktopDispatcher(manifest);
      const timestamp = new Date().toISOString();
      await this.api.updateDispatcher({
        status: "active",
        automationId: this.dispatcherId,
        installedAt: dispatcher.automationId === this.dispatcherId && dispatcher.installedAt
          ? dispatcher.installedAt
          : timestamp,
        lastHeartbeatAt: timestamp
      });
      this.initialized = true;
    } catch (error) {
      await this.releaseLock();
      this.releaseLock = null;
      throw error;
    }
  }

  async heartbeat() {
    await this.api.health();
    const manifest = await this.api.manifest();
    const dispatcher = this.assertNoActiveDesktopDispatcher(manifest);
    const update = { status: "active", lastHeartbeatAt: new Date().toISOString() };
    if (dispatcher.automationId !== this.dispatcherId) {
      update.automationId = this.dispatcherId;
      update.installedAt = update.lastHeartbeatAt;
    }
    await this.api.updateDispatcher(update);
  }

  async tick() {
    if (!this.initialized) fail("CATCHUP_CLI_NOT_INITIALIZED", "追平 CLI 调度器尚未初始化");
    if (this.stopping) return 0;
    if (this.lastError) throw this.lastError;
    await this.heartbeat();
    const jobs = await this.api.claim(this.maxConcurrent);
    let claimed = 0;
    for (const value of jobs) {
      // 暂停只禁止下一次领取；本次已经领取的每项都必须登记和收尾。
      if (this.lastError) throw this.lastError;
      const job = normalizeJob(value);
      const manifest = await this.api.manifest();
      try {
        this.assertNoActiveDesktopDispatcher(manifest);
      } catch (error) {
        await this.api.updateJob({
          id: job.id,
          claimToken: job.claimToken,
          status: "blocked",
          hostId: "local-cli-dispatcher",
          error: error.message
        });
        throw error;
      }
      claimed += 1;
      const task = this.execute(job)
        .catch((error) => { this.lastError = error; })
        .finally(() => this.running.delete(task));
      this.running.add(task);
    }
    return claimed;
  }

  async execute(jobValue) {
    const job = normalizeJob(jobValue);
    const runId = `${job.id}:${job.claimToken}`;
    await this.ledger.set(runId, {
      jobId: job.id,
      claimToken: job.claimToken,
      action: job.action,
      workspacePath: job.workspacePath,
      threadId: job.threadId,
      pid: 0,
      phase: "claimed"
    });

    let workspace;
    try {
      workspace = await this.validateWorkspace(job);
    } catch (error) {
      return this.finalize(runId, job, {
        status: "blocked",
        error: cleanText(error?.message, 1000) || "追平工作区校验失败"
      });
    }
    await this.ledger.patch(runId, {
      workspacePath: workspace.workspacePath,
      phase: "validated"
    });

    const keys = [
      `workspace:${workspace.workspacePath}`,
      job.threadId ? `thread:${job.threadId}` : ""
    ];
    return this.resourceGate.run(keys, async () => {
      try {
        const current = await this.validateWorkspace(job);
        if (current.workspacePath !== workspace.workspacePath) {
          fail("CATCHUP_CLI_WORKSPACE_CHANGED", "追平工作区在等待期间发生变化");
        }
        return await this.executeInLane(runId, job, current.workspacePath);
      } catch (error) {
        if (error.callbackFailure) throw error;
        return this.finalize(runId, job, {
          status: "blocked",
          error: cleanText(error?.message, 1000) || "Codex CLI 执行失败"
        });
      }
    });
  }

  async executeInLane(runId, job, workspacePath) {
    if (controlActions.has(job.action) && !job.threadId) {
      if (job.clientThreadId) {
        return this.finalize(runId, job, {
          status: "blocked",
          error: "CLI 调度器无法安全解析仅有 clientThreadId 的既有 task"
        });
      }
      return this.finalize(runId, job, {
        status: job.action === "pause" ? "paused" : "completed",
        result: "目标 task 尚未创建，控制动作按 no-op 完成"
      });
    }
    if (implementationActions.has(job.action) && job.clientThreadId && !job.threadId) {
      return this.finalize(runId, job, {
        status: "blocked",
        error: "CLI 调度器不会为已有 clientThreadId 创建第二个 task"
      });
    }

    let callbackSuperseded = false;
    let runningSent = false;
    let threadId = job.threadId;
    await this.ledger.patch(runId, { phase: "spawning" });
    const sendRunning = async () => {
      if (runningSent || !implementationActions.has(job.action) || !threadId) return;
      runningSent = true;
      const response = await this.postJobUpdate(job, {
        status: "running",
        threadId,
        result: "Codex CLI task 已启动或续跑"
      });
      callbackSuperseded = response.superseded;
    };
    if (threadId) {
      await sendRunning();
      if (callbackSuperseded) {
        await this.ledger.remove(runId);
        return { superseded: true };
      }
    }
    const execution = await this.processGate.run(() => this.runCodex(job, {
      workspacePath,
      codexBinary: this.codexBinary,
      onSpawn: async ({ pid }) => {
        await this.ledger.patch(runId, {
          pid,
          phase: "running"
        });
        await sendRunning();
      },
      onThreadStarted: async (value) => {
        threadId = value;
        await this.ledger.patch(runId, { threadId });
        await sendRunning();
      }
    }));
    threadId = execution.threadId || threadId;
    if (callbackSuperseded) {
      await this.ledger.remove(runId);
      return { superseded: true };
    }
    if (implementationActions.has(job.action) && !threadId) {
      return this.finalize(runId, job, {
        status: "blocked",
        error: "Codex CLI 退出前未返回 threadId"
      });
    }
    if (execution.code !== 0) {
      return this.finalize(runId, { ...job, threadId }, {
        status: "blocked",
        error: execution.timedOut
          ? `Codex CLI 单任务执行超过 ${Math.round(CATCHUP_CLI_JOB_TIMEOUT_MS / 60000)} 分钟，已终止并保留工作树`
          : execution.stderr || `Codex CLI 异常退出${execution.signal ? ` (${execution.signal})` : ""}`
      });
    }
    return this.finalize(runId, { ...job, threadId }, ["merge", "jira"].includes(job.kind)
      ? {
        status: "blocked",
        error: job.kind === "merge" ? "Codex CLI 已退出但未完成合入任务最终回调" : "Codex CLI 已退出但未完成 Jira 任务最终回调"
      }
      : {
        status: job.action === "pause" ? "paused" : "completed",
        result: "Codex CLI 本轮执行完成"
      });
  }

  async postJobUpdate(job, update) {
    try {
      await this.api.updateJob({
        id: job.id,
        claimToken: job.claimToken,
        hostId: "local-cli-dispatcher",
        ...(job.threadId ? { threadId: job.threadId } : {}),
        ...update
      });
      return { superseded: false };
    } catch (error) {
      if (
        error instanceof CatchupCliHttpError
        && error.status === 409
        && [
          claimMismatchMessage,
          mergeClaimMismatchMessage,
          terminalJobMessage,
          mergeTerminalMessage
        ].includes(
          error.payload?.error || error.message
        )
      ) {
        return { superseded: true };
      }
      error.callbackFailure = true;
      throw error;
    }
  }

  async finalize(runId, job, update) {
    await this.ledger.patch(runId, {
      phase: "callback-pending",
      threadId: job.threadId,
      error: cleanText(update.error, 1000)
    });
    const response = await this.postJobUpdate(job, update);
    await this.ledger.remove(runId);
    return response;
  }

  async waitForIdle() {
    await Promise.allSettled([...this.running]);
    if (this.lastError) throw this.lastError;
  }

  async runForever() {
    await this.initialize();
    let failure;
    try {
      while (!this.stopping) {
        if (this.lastError) throw this.lastError;
        await this.tick();
        if (this.lastError) throw this.lastError;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      failure = error;
      this.stopping = true;
    } finally {
      try {
        await this.waitForIdle();
      } catch (error) {
        failure ||= error;
      }
      try {
        const dispatcher = (await this.api.manifest())?.dispatcher;
        if (dispatcher?.automationId === this.dispatcherId) {
          await this.api.updateDispatcher({
            status: "paused",
            automationId: this.dispatcherId,
            lastHeartbeatAt: new Date().toISOString()
          });
        }
      } catch (error) {
        failure ||= error;
      }
      await this.releaseLock?.();
      this.releaseLock = null;
      this.initialized = false;
    }
    if (failure) throw failure;
  }

  stop() {
    this.stopping = true;
  }
}

export async function runCatchupCliDispatcher() {
  const dispatcher = new CatchupCliDispatcher();
  const stop = () => dispatcher.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await dispatcher.runForever();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCatchupCliDispatcher().catch((error) => {
    console.error(`${error.code || "CATCHUP_CLI_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
}
