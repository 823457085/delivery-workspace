import fs from "node:fs/promises";
import path from "node:path";
import { catchupAdminExclusionReason } from "./catchup-admin-scope.mjs";

/**
 * 设计说明：功能追平的执行状态独立于需求事实源和自动交付队列，避免“开始/暂停”等操作
 * 改写审计证据、Jira 或 Codex 状态。该模块只记录本地执行进度；“暂停”不会强停
 * 正在运行的 Codex，并通过受控状态转换防止暂停未开始项、继续非暂停项等无效操作。
 */

export const CATCHUP_EXECUTION_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "PAUSED",
  "ENDED"
];

export const CATCHUP_EXECUTION_ACTIONS = ["start", "pause", "resume", "finish"];

export const CATCHUP_EXECUTION_SEMANTICS = Object.freeze({
  pause: "仅暂停等待中或可控的后续执行，不会强制终止正在运行的 Codex 会话",
  finish: "仅结束本次功能还原执行生命周期，不代表接口联调、正式 Gate 或验收通过"
});

const transitions = {
  start: { NOT_STARTED: "IN_PROGRESS" },
  pause: { IN_PROGRESS: "PAUSED" },
  resume: { PAUSED: "IN_PROGRESS" },
  finish: { IN_PROGRESS: "ENDED", PAUSED: "ENDED" }
};

export function makeDefaultCatchupExecutionState() {
  return {
    version: 1,
    revision: 0,
    updatedAt: "",
    requirements: {}
  };
}

function normalizeEntry(value = {}) {
  return {
    status: CATCHUP_EXECUTION_STATUSES.includes(value.status) ? value.status : "NOT_STARTED",
    lastAction: CATCHUP_EXECUTION_ACTIONS.includes(value.lastAction) ? value.lastAction : "",
    sequence: Number.isInteger(value.sequence) && value.sequence >= 0 ? value.sequence : 0,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    endedAt: typeof value.endedAt === "string" ? value.endedAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

export function normalizeCatchupExecutionState(value = {}) {
  const state = makeDefaultCatchupExecutionState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  state.revision = Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0;
  state.updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  if (!value.requirements || typeof value.requirements !== "object" || Array.isArray(value.requirements)) {
    return state;
  }
  state.requirements = Object.fromEntries(
    Object.entries(value.requirements)
      .filter(([requirementId]) => /^REQ-(?:CU-)?\d{3}$/.test(requirementId))
      .map(([requirementId, entry]) => [requirementId, normalizeEntry(entry)])
  );
  return state;
}

export function allowedCatchupActions(status) {
  return CATCHUP_EXECUTION_ACTIONS.filter((action) => transitions[action][status]);
}

export function applyCatchupExecutionAction(
  state,
  validRequirementIds,
  requirementIds,
  action,
  expectedRevision,
  now = new Date().toISOString()
) {
  if (!CATCHUP_EXECUTION_ACTIONS.includes(action)) throw new Error("INVALID_ACTION");
  if (!Array.isArray(requirementIds) || requirementIds.length === 0) {
    throw new Error("INVALID_REQUIREMENT_IDS");
  }

  const ids = [...new Set(requirementIds.map((value) => String(value || "").trim()))];
  if (ids.length > validRequirementIds.size) throw new Error("INVALID_REQUIREMENT_IDS");
  if (ids.some((requirementId) => !validRequirementIds.has(requirementId))) {
    throw new Error("UNKNOWN_REQUIREMENT_ID");
  }
  if (ids.some(catchupAdminExclusionReason)) throw new Error("ADMIN_DELIVERY_EXCLUDED");

  const normalized = normalizeCatchupExecutionState(state);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("INVALID_REVISION");
  }
  if (normalized.revision !== expectedRevision) {
    throw new Error("REVISION_CONFLICT");
  }

  const conflicts = ids
    .map((requirementId) => ({
      requirementId,
      status: normalizeEntry(normalized.requirements[requirementId]).status
    }))
    .filter(({ status }) => !transitions[action][status]);
  if (conflicts.length > 0) {
    const error = new Error("INVALID_TRANSITION");
    error.conflicts = conflicts;
    throw error;
  }

  ids.forEach((requirementId) => {
    const current = normalizeEntry(normalized.requirements[requirementId]);
    const nextStatus = transitions[action][current.status];
    normalized.requirements[requirementId] = {
      status: nextStatus,
      lastAction: action,
      sequence: current.sequence + 1,
      startedAt: action === "start" ? now : current.startedAt,
      endedAt: action === "finish" ? now : "",
      updatedAt: now
    };
  });

  normalized.revision += 1;
  normalized.updatedAt = now;
  return { state: normalized, updated: ids };
}

export function attachCatchupExecution(board, state) {
  const normalized = normalizeCatchupExecutionState(state);
  const executionStatuses = Object.fromEntries(
    CATCHUP_EXECUTION_STATUSES.map((status) => [status, 0])
  );
  const requirements = board.requirements.map((requirement) => {
    const execution = normalizeEntry(normalized.requirements[requirement.id]);
    const exclusionReason = catchupAdminExclusionReason(requirement.id);
    if (!exclusionReason) executionStatuses[execution.status] += 1;
    return {
      ...requirement,
      execution: {
        ...execution,
        exclusionReason,
        allowedActions: exclusionReason ? [] : allowedCatchupActions(execution.status)
      }
    };
  });
  return {
    ...board,
    apiVersion: 2,
    executionSemantics: CATCHUP_EXECUTION_SEMANTICS,
    executionUpdatedAt: normalized.updatedAt || null,
    executionRevision: normalized.revision,
    executionStatuses,
    requirements
  };
}

export async function readCatchupExecutionState(filename) {
  try {
    return normalizeCatchupExecutionState(JSON.parse(await fs.readFile(filename, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return makeDefaultCatchupExecutionState();
    throw new Error("追平执行状态不可用");
  }
}

export async function writeCatchupExecutionState(filename, state) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporaryFile = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(normalizeCatchupExecutionState(state), null, 2), "utf8");
  await fs.rename(temporaryFile, filename);
}
