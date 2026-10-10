export const calendarWeekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export interface MonthCalendarCell {
  day: string;
  dateNumber: number;
  isCurrentMonth: boolean;
  isRestDay: boolean;
  isToday: boolean;
}

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isWeekend(date: Date) {
  return date.getDay() === 0 || date.getDay() === 6;
}

export function monthTitle(date: Date) {
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月`;
}

export function buildMonthCalendar(anchor: Date, today = new Date()): MonthCalendarCell[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const firstDay = new Date(year, month, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);
  const todayKey = dayKey(today);

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    return {
      day: dayKey(date),
      dateNumber: date.getDate(),
      isCurrentMonth: date.getMonth() === month,
      isRestDay: isWeekend(date),
      isToday: dayKey(date) === todayKey,
    };
  });
}
