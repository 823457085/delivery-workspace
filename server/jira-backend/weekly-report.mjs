/**
 * 设计说明：周报是自动交付状态的本地只读汇总，不负责向 Jira 或 Confluence 写入。
 * 调度、内容生成和状态归一化保持为纯函数，服务端只负责读取真实来源并持久化结果。
 */

export const DEFAULT_WEEKLY_REPORT_SETTINGS = Object.freeze({
  enabled: false,
  weekday: 5,
  time: "17:30"
});

const completedJobStatuses = new Set(["completed", "review"]);

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function localDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function scheduleDate(reference, weekday, time, direction) {
  const result = new Date(reference);
  const offset = direction === "next"
    ? (weekday - result.getDay() + 7) % 7
    : -((result.getDay() - weekday + 7) % 7);
  result.setDate(result.getDate() + offset);
  const [hour, minute] = time.split(":").map(Number);
  result.setHours(hour, minute, 0, 0);
  if (direction === "next" && result <= reference) result.setDate(result.getDate() + 7);
  if (direction === "previous" && result > reference) result.setDate(result.getDate() - 7);
  return result;
}

export function sanitizeWeeklyReportSettings(value = {}, current = DEFAULT_WEEKLY_REPORT_SETTINGS) {
  const weekday = Number.isInteger(value.weekday) && value.weekday >= 0 && value.weekday <= 6
    ? value.weekday
    : current.weekday;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
    weekday,
    time: validTime(value.time) ? value.time : current.time
  };
}

export function makeDefaultWeeklyReportState() {
  return {
    settings: { ...DEFAULT_WEEKLY_REPORT_SETTINGS },
    runs: [],
    lastRun: null,
    lastScheduledSlot: ""
  };
}

export function sanitizeWeeklyReportState(value = {}) {
  const defaults = makeDefaultWeeklyReportState();
  return {
    ...defaults,
    ...value,
    settings: sanitizeWeeklyReportSettings(value.settings || {}, defaults.settings),
    runs: Array.isArray(value.runs) ? value.runs.slice(0, 12) : [],
    lastRun: value.lastRun && typeof value.lastRun === "object" ? value.lastRun : null,
    lastScheduledSlot: typeof value.lastScheduledSlot === "string" ? value.lastScheduledSlot : ""
  };
}

export function getNextWeeklyReportRun(settings, now = new Date()) {
  if (!settings.enabled) return null;
  return scheduleDate(now, settings.weekday, settings.time, "next").toISOString();
}

export function getDueWeeklyReportSlot(settings, lastScheduledSlot = "", now = new Date()) {
  if (!settings.enabled) return "";
  const due = scheduleDate(now, settings.weekday, settings.time, "previous");
  const slot = `${localDate(due)} ${settings.time}`;
  return slot > lastScheduledSlot ? slot : "";
}

export function getWeeklyReportRange(reference = new Date()) {
  const date = reference instanceof Date ? new Date(reference) : new Date(reference);
  const monday = new Date(date);
  const day = monday.getDay();
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: localDate(monday), end: localDate(sunday), startAt: monday, endAt: sunday };
}

function within(value, range) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= range.startAt.getTime() && timestamp <= range.endAt.getTime();
}

function scheduleTouchesRange(issue, range) {
  const start = issue.startDate ? new Date(`${issue.startDate}T00:00:00`).getTime() : Number.NaN;
  const endValue = issue.endDate || issue.dueDate;
  const end = endValue ? new Date(`${endValue}T23:59:59`).getTime() : Number.NaN;
  if (Number.isFinite(start) && Number.isFinite(end)) return start <= range.endAt.getTime() && end >= range.startAt.getTime();
  if (Number.isFinite(start)) return start <= range.endAt.getTime();
  return Number.isFinite(end) && end >= range.startAt.getTime() && end <= range.endAt.getTime();
}

function issueDone(issue) {
  return /已完成|完成|关闭|done|closed/i.test(`${issue.status || ""} ${issue.statusCategory || ""}`);
}

function issueBlocked(issue) {
  return /阻塞|blocked/i.test(`${issue.status || ""} ${issue.statusCategory || ""}`);
}

function chineseDate(value) {
  if (!value) return "待补充";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "待补充";
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function chineseDateWithYear(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "待补充";
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function cleanSummary(issue) {
  return String(issue.summary || "未命名任务")
    .replace(/^\s*【[^】]+】\s*/, "")
    .replace(/^\s*(?:完成|实现|编写|支持|修复|调整|优化)\s*/, "")
    .replace(/[.。；;]+$/, "")
    .trim();
}

function businessLabel(issue) {
  const label = String(issue.summary || "").match(/^【([^】]+)】/);
  return label ? label[1] : (issue.projectName || issue.project || "Apex");
}

function reportIdentity(issue) {
  return issue.parent?.key || issue.key || cleanSummary(issue);
}

function parentSummary(issue) {
  return issue.parent?.summary || issue.summary;
}

function deduplicateForReport(items, useParentSummary = true) {
  const grouped = new Map();
  for (const issue of items) {
    const key = reportIdentity(issue);
    const existing = grouped.get(key);
    const normalized = useParentSummary && issue.parent
      ? { ...issue, summary: parentSummary(issue) }
      : issue;
    if (!existing || (!existing.endDate && (normalized.endDate || normalized.dueDate))) grouped.set(key, normalized);
  }
  return [...grouped.values()];
}

function numbered(items, render, emptyText = "无。") {
  if (!items.length) return emptyText;
  return items.map((item, index) => `${index + 1}、${render(item)}`).join("\n\n");
}

function completedLine(issue) {
  return `完成【${businessLabel(issue)}】${cleanSummary(issue)}。`;
}

function unfinishedLine(issue) {
  const status = issueBlocked(issue) ? "已阻塞" : (issue.status || "进行中");
  return `【${businessLabel(issue)}】${cleanSummary(issue)}，当前状态【${status}】。`;
}

function planLine(issue) {
  const owner = issue.assignee || "未分配";
  return `【${businessLabel(issue)}】：完成【${cleanSummary(issue)}】，计划【${chineseDate(issue.endDate || issue.dueDate)}】完成，负责人【${owner}】。`;
}

function referenceFromSlot(slot, now) {
  if (!slot) return now;
  const parsed = new Date(slot.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

export function createWeeklyReportRun({ issues = [], jobs = [], automationRuns = [], trigger = "manual", scheduledSlot = "", now = new Date(), source = "jira" } = {}) {
  const generatedAt = now instanceof Date ? now : new Date(now);
  const range = getWeeklyReportRange(referenceFromSlot(scheduledSlot, generatedAt));
  const nextWeekReference = new Date(range.startAt);
  nextWeekReference.setDate(nextWeekReference.getDate() + 7);
  const nextWeekRange = getWeeklyReportRange(nextWeekReference);
  const completed = issues.filter((issue) => issueDone(issue) && within(issue.resolutionDate || issue.updated, range));
  const active = issues.filter((issue) => !issueDone(issue) && !issueBlocked(issue)
    && (within(issue.updated, range) || scheduleTouchesRange(issue, range)));
  const blocked = issues.filter((issue) => !issueDone(issue) && issueBlocked(issue));
  const nextWeekPlan = issues.filter((issue) => !issueDone(issue) && !issueBlocked(issue) && scheduleTouchesRange(issue, nextWeekRange));
  const weeklyJobs = jobs.filter((job) => within(job.updatedAt || job.createdAt, range));
  const completedJobs = weeklyJobs.filter((job) => completedJobStatuses.has(job.status));
  const blockedJobs = weeklyJobs.filter((job) => job.status === "blocked");
  const weeklyAutomationRuns = automationRuns.filter((run) => {
    if (!run.localDate) return within(run.completedAt || run.startedAt, range);
    return run.localDate >= range.start && run.localDate <= range.end;
  });
  const maintenanceUpdatedCount = weeklyAutomationRuns.reduce((total, run) => total + Number(run.transitionUpdatedCount || 0), 0);
  const completedReportItems = deduplicateForReport(completed, false).slice(0, 6);
  const unfinishedReportItems = deduplicateForReport([...blocked, ...active]).slice(0, 6);
  const planItems = deduplicateForReport(
    [...nextWeekPlan].sort((left, right) => String(left.endDate || left.dueDate || "9999-12-31").localeCompare(String(right.endDate || right.dueDate || "9999-12-31"))),
    false
  )
    .slice(0, 3);
  const content = [
    "Apex 工作周报",
    `周报时间：${chineseDateWithYear(range.start)} - ${chineseDateWithYear(range.end)}`,
    "一、本周进展",
    numbered(completedReportItems, completedLine),
    "二、本周未完成",
    numbered(unfinishedReportItems, unfinishedLine),
    "三、下周计划",
    numbered(planItems, planLine)
  ].join("\n\n");

  return {
    id: `${generatedAt.getTime()}-${trigger}`,
    trigger,
    scheduledSlot,
    status: "completed",
    source,
    generatedAt: generatedAt.toISOString(),
    rangeStart: range.start,
    rangeEnd: range.end,
    completedCount: completed.length,
    inProgressCount: active.length,
    blockedCount: blocked.length + blockedJobs.length,
    agentCompletedCount: completedJobs.length,
    maintenanceUpdatedCount,
    content,
    error: ""
  };
}
