/**
 * 设计说明：例会页是多人维护的长文档，本模块只提取“当天日报”里明确归属配置负责人的条目，
 * 并将日期等于当天的任务与后续任务分栏。它不负责写回 Confluence，避免自动化误改整页内容。
 */

const DEFAULT_TIME_ZONE = process.env.DELIVERY_TIME_ZONE || "Asia/Shanghai";
const DEFAULT_ASSIGNEE = Object.freeze({
  name: process.env.MEETING_ASSIGNEE_NAME || "",
  userKeys: Object.freeze((process.env.MEETING_ASSIGNEE_USER_KEYS || "").split(",").map(value => value.trim()).filter(Boolean))
});

function dateParts(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localDateIso(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = dateParts(value, timeZone);
  return `${year}-${month}-${day}`;
}

export function expectedMeetingTitle(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { year, month } = dateParts(value, timeZone);
  return `${process.env.MEETING_TITLE_PREFIX || ""}${year.slice(-2)}年${month}月例会`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function htmlText(value) {
  return decodeHtml(String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function findDailySection(storageHtml, dayCode) {
  const headings = [...String(storageHtml || "").matchAll(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi)];
  const targetIndex = headings.findIndex((heading) => htmlText(heading[0]).replace(/\s/g, "") === `${dayCode}日报`);
  if (targetIndex < 0) return "";
  const start = headings[targetIndex].index + headings[targetIndex][0].length;
  const nextDailyHeading = headings.slice(targetIndex + 1)
    .find((heading) => /^\d{4}日报$/.test(htmlText(heading[0]).replace(/\s/g, "")));
  const end = nextDailyHeading?.index ?? String(storageHtml || "").length;
  return String(storageHtml || "").slice(start, end);
}

function parentheticalDate(taskText, month, day) {
  const groups = [...String(taskText || "").matchAll(/[（(]([^()（）]{1,100})[）)]/g)];
  const dueParts = [];
  let matchesToday = false;

  for (const group of groups) {
    const dates = [...group[1].matchAll(/(?<!\d)(\d{1,2})\s*(?:月|[.\-/])\s*(\d{1,2})(?:\s*[日号])?/g)];
    if (dates.length > 0) dueParts.push(group[1].trim());
    if (dates.some((match) => Number(match[1]) === Number(month) && Number(match[2]) === Number(day))) {
      matchesToday = true;
    }
  }

  return { dueText: dueParts.join("；"), matchesToday };
}

function taskId(attributes, index) {
  return /\bdata-uuid=["']([^"']+)["']/i.exec(attributes)?.[1] || `meeting-task-${index + 1}`;
}

export function extractAssigneeTasks(storageHtml, {
  localDate,
  assignee = DEFAULT_ASSIGNEE
} = {}) {
  const [year, month, day] = String(localDate || localDateIso()).split("-");
  if (!year || !month || !day) throw new Error("INVALID_MEETING_LOCAL_DATE");
  const section = findDailySection(storageHtml, `${month}${day}`);
  if (!section) return { sectionFound: false, todayTasks: [], tomorrowTasks: [] };

  const taskMatches = [...section.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
  const tasks = taskMatches.flatMap((match, index) => {
    const raw = match[2];
    const assignedByName = Boolean(assignee.name) && htmlText(raw).includes(`@${assignee.name}`);
    const assignedByKey = assignee.userKeys.some((key) => new RegExp(`ri:userkey=["']${key}["']`, "i").test(raw));
    if (!assignedByName && !assignedByKey) return [];

    let text = htmlText(raw);
    if (assignee.name && !text.includes(`@${assignee.name}`)) text = `${text} @${assignee.name}`;
    const due = parentheticalDate(text, month, day);
    return [{
      id: taskId(match[1], index),
      sourceText: text,
      dueText: due.dueText,
      dateMatchesToday: due.matchesToday
    }];
  });

  return {
    sectionFound: true,
    todayTasks: tasks.filter((task) => task.dateMatchesToday),
    tomorrowTasks: tasks.filter((task) => !task.dateMatchesToday)
  };
}

export function buildMeetingSnapshot(input, now = new Date()) {
  const scannedAt = input?.scannedAt || now.toISOString();
  const localDate = input?.localDate || localDateIso(scannedAt);
  const expectedTitle = expectedMeetingTitle(scannedAt);
  const title = String(input?.title || "").trim();
  if (title !== expectedTitle) {
    const error = new Error(`例会标题不匹配：期望 ${expectedTitle}，实际 ${title || "空"}`);
    error.code = "MEETING_TITLE_MISMATCH";
    throw error;
  }

  const assignee = {
    name: String(input?.assignee?.name || DEFAULT_ASSIGNEE.name),
    userKeys: Array.isArray(input?.assignee?.userKeys) && input.assignee.userKeys.length
      ? input.assignee.userKeys.map(String)
      : [...DEFAULT_ASSIGNEE.userKeys]
  };
  const extracted = extractAssigneeTasks(input?.storageHtml, { localDate, assignee });
  const warnings = [];
  if (!extracted.sectionFound) warnings.push(`未找到 ${localDate.slice(5).replace("-", "")}日报`);
  if (extracted.sectionFound && extracted.todayTasks.length + extracted.tomorrowTasks.length === 0) {
    warnings.push(`当天日报未识别到 ${assignee.name} 的任务`);
  }

  return {
    schemaVersion: 1,
    localDate,
    scannedAt,
    schedule: `工作日 17:00（${DEFAULT_TIME_ZONE}）`,
    expectedTitle,
    assignee,
    source: {
      pageId: String(input?.pageId || ""),
      title,
      url: String(input?.url || ""),
      version: Number(input?.version || 0)
    },
    sectionTitle: `${localDate.slice(5).replace("-", "")}日报`,
    todayTasks: extracted.todayTasks,
    tomorrowTasks: extracted.tomorrowTasks,
    warnings
  };
}

export async function writeMeetingSnapshot(filePath, snapshot) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}
