/** 中国大陆全体公民放假及官方补班日；表单与 Jira 建单共用，不推算未核验年份。 */
const calendars = {
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
export const chinaWorkCalendarSources = Object.entries(calendars).map(([year, value]) => ({ year: Number(year), source: value.source, notice: value.notice }));
function dateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) throw new Error('计划日期必须是真实的 YYYY-MM-DD 日期。');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('计划日期必须是真实的 YYYY-MM-DD 日期。');
  return time;
}
function calendarFor(date) {
  const calendar = calendars[date.slice(0, 4)];
  if (!calendar) throw new Error(`${date.slice(0, 4)} 年官方放假与调休日历尚未收录，请更新日历后再生成 Jira 排期。`);
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
