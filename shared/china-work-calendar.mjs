/** 中国大陆全体公民放假及官方补班日；表单与 Jira 建单共用，不推算未核验年份，支持动态导入新年度官方数据与到期预警。 */
const builtinCalendars = {
  2025: {
    source: 'https://www.forestry.gov.cn/c/www/szxx/594663.jhtml',
    notice: '国办发明电〔2024〕12号',
    holidays: [['01-01', '01-01'], ['01-28', '02-04'], ['04-04', '04-06'], ['05-01', '05-05'], ['05-31', '06-02'], ['10-01', '10-08']],
    workdays: ['01-26', '02-08', '04-27', '09-28', '10-11'],
  },
  2026: {
    source: 'https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html',
    notice: '国办发明电〔2025〕7号',
    holidays: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
    workdays: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
  },
};

const customCalendars = new Map();

export const chinaWorkCalendarSources = Object.entries(builtinCalendars).map(([year, value]) => ({
  year: Number(year),
  source: value.source,
  notice: value.notice,
}));

function assertMonthDay(year, md, label) {
  if (typeof md !== 'string' || !/^\d{2}-\d{2}$/.test(md)) {
    throw new Error(`${label} 必须是 MM-DD 格式（收到：${String(md)}）。`);
  }
  dateTime(`${year}-${md}`);
}

export function registerChinaWorkCalendar(year, definition) {
  const numYear = Number(year);
  if (!Number.isInteger(numYear) || numYear < 2020 || numYear > 2100) {
    throw new Error('导入的工作日历年份必须是 2020–2100 之间的整数。');
  }
  if (!definition || typeof definition !== 'object') {
    throw new Error('导入的工作日历定义格式无效。');
  }
  const holidaysRaw = Array.isArray(definition.holidays) ? definition.holidays : null;
  const workdaysRaw = Array.isArray(definition.workdays) ? definition.workdays : null;
  if (!holidaysRaw || !workdaysRaw) {
    throw new Error('导入的工作日历必须包含 holidays 与 workdays 数组。');
  }
  const holidays = holidaysRaw.map((range) => {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new Error('holidays 每项必须是 [开始 MM-DD, 结束 MM-DD] 二元组。');
    }
    const [start, end] = range;
    assertMonthDay(numYear, start, '假期开始日');
    assertMonthDay(numYear, end, '假期结束日');
    if (end < start) throw new Error(`假期结束日 ${end} 不能早于开始日 ${start}。`);
    return [start, end];
  });
  const workdays = workdaysRaw.map((day) => {
    assertMonthDay(numYear, day, '调休补班日');
    return day;
  });
  customCalendars.set(String(numYear), {
    source: typeof definition.source === 'string' ? definition.source.trim() : 'custom-import',
    notice: typeof definition.notice === 'string' ? definition.notice.trim() : `${numYear} 导入日历`,
    holidays,
    workdays,
  });
}

export function resetCustomChinaWorkCalendars() {
  customCalendars.clear();
}

export function hasChinaWorkCalendarYear(yearOrDate) {
  const key = String(yearOrDate || '').slice(0, 4);
  return customCalendars.has(key) || Object.hasOwn(builtinCalendars, key);
}

export function getChinaWorkCalendarCoverage(referenceDate) {
  const refTime = dateTime(referenceDate);
  const allYears = [
    ...Object.keys(builtinCalendars).map(Number),
    ...Array.from(customCalendars.keys(), Number),
  ].sort((a, b) => a - b);
  const latestYear = allYears.at(-1) || 2026;
  const latestEndTime = Date.parse(`${latestYear}-12-31T00:00:00Z`);
  const daysRemaining = Math.floor((latestEndTime - refTime) / 86400000);
  const expiringSoon = daysRemaining <= 60;
  return {
    years: Array.from(new Set(allYears)),
    latestYear,
    daysRemaining,
    expiringSoon,
    warning: daysRemaining < 0
      ? `官方工作日历仅收录至 ${latestYear} 年（已过期 ${Math.abs(daysRemaining)} 天），请尽快导入 ${latestYear + 1} 年官方放假与调休安排。`
      : expiringSoon
        ? `官方工作日历仅收录至 ${latestYear} 年（距年底仅剩 ${daysRemaining} 天），跨入 ${latestYear + 1} 年的排期将无法自动拆单，请提前导入新年度日历。`
        : '',
  };
}

function dateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) throw new Error('计划日期必须是真实的 YYYY-MM-DD 日期。');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('计划日期必须是真实的 YYYY-MM-DD 日期。');
  return time;
}
function calendarFor(date) {
  const yearKey = date.slice(0, 4);
  const calendar = customCalendars.get(yearKey) || builtinCalendars[yearKey];
  if (!calendar) throw new Error(`${yearKey} 年官方放假与调休日历尚未收录，请更新日历后再生成 Jira 排期。`);
  return calendar;
}
export function isChinaWorkingDay(date) {
  const time = dateTime(date), calendar = calendarFor(date), day = date.slice(5);
  if (calendar.workdays.includes(day)) return true;
  if (calendar.holidays.some(([start, end]) => day >= start && day <= end)) return false;
  return ![0, 6].includes(new Date(time).getUTCDay());
}
export function chinaWorkingDates(startDate, endDate) {
  const start = dateTime(startDate), end = dateTime(endDate);
  if (end < start) throw new Error('计划结束日期不能早于计划开始日期。');
  const days = [];
  for (let time = start; time <= end; time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (isChinaWorkingDay(day)) days.push(day);
  }
  return days;
}
/** 单张任务只覆盖连续工作日，休假间隔另起一段。 */
export function splitWorkingDates(days, maxDays = 3) {
  const size = Math.max(1, Math.min(Math.floor(Number(maxDays) || 3), 30)), parts = [];
  for (const day of days) {
    const last = parts.at(-1);
    if (last && last.length < size && dateTime(day) - dateTime(last.at(-1)) === 86400000) last.push(day);
    else parts.push([day]);
  }
  return parts;
}
