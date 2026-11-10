export const chinaWorkCalendarSources: readonly { year: number; source: string; notice: string }[];
export function isChinaWorkingDay(date: string): boolean;
export function chinaWorkingDates(startDate: string, endDate: string): string[];
export function splitWorkingDates(days: readonly string[], maxDays?: number): string[][];
