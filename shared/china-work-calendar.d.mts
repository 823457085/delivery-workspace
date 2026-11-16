export interface ChinaWorkCalendarDefinition {
  source?: string;
  notice?: string;
  holidays: readonly (readonly [string, string])[];
  workdays: readonly string[];
}

export interface ChinaWorkCalendarCoverage {
  years: number[];
  latestYear: number;
  daysRemaining: number;
  expiringSoon: boolean;
  warning: string;
}

export const chinaWorkCalendarSources: readonly { year: number; source: string; notice: string }[];
export function registerChinaWorkCalendar(year: number | string, definition: ChinaWorkCalendarDefinition): void;
export function resetCustomChinaWorkCalendars(): void;
export function hasChinaWorkCalendarYear(yearOrDate: number | string): boolean;
export function getChinaWorkCalendarCoverage(referenceDate: string): ChinaWorkCalendarCoverage;
export function isChinaWorkingDay(date: string): boolean;
export function chinaWorkingDates(startDate: string, endDate: string): string[];
export function splitWorkingDates(days: readonly string[], maxDays?: number): string[][];
