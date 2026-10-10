export interface WeeklyReportSettings {
  enabled: boolean;
  weekday: number;
  time: string;
}

export interface WeeklyReportRun {
  id: string;
  trigger: string;
  scheduledSlot: string;
  status: 'completed';
  source: string;
  generatedAt: string;
  rangeStart: string;
  rangeEnd: string;
  completedCount: number;
  inProgressCount: number;
  blockedCount: number;
  agentCompletedCount: number;
  maintenanceUpdatedCount: number;
  content: string;
  error: string;
}

export interface WeeklyReportState {
  settings: WeeklyReportSettings;
  runs: WeeklyReportRun[];
  lastRun: WeeklyReportRun | null;
  lastScheduledSlot: string;
}

export const DEFAULT_WEEKLY_REPORT_SETTINGS: Readonly<WeeklyReportSettings>;
export function sanitizeWeeklyReportSettings(value?: Partial<WeeklyReportSettings>, current?: WeeklyReportSettings): WeeklyReportSettings;
export function makeDefaultWeeklyReportState(): WeeklyReportState;
export function sanitizeWeeklyReportState(value?: Partial<WeeklyReportState>): WeeklyReportState;
export function getNextWeeklyReportRun(settings: WeeklyReportSettings, now?: Date): string | null;
export function getDueWeeklyReportSlot(settings: WeeklyReportSettings, lastScheduledSlot?: string, now?: Date): string;
export function getWeeklyReportRange(reference?: Date | string): { start: string; end: string; startAt: Date; endAt: Date };
export function createWeeklyReportRun(input?: {
  issues?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  automationRuns?: Array<Record<string, unknown>>;
  trigger?: string;
  scheduledSlot?: string;
  now?: Date;
  source?: string;
}): WeeklyReportRun;
