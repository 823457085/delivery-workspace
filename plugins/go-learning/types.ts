import { z } from 'zod';

export const goCommandActions = ['run', 'test', 'race', 'vet', 'fmt', 'version'] as const;
export type GoCommandAction = (typeof goCommandActions)[number];

export interface GoChecklistItem {
  id: string;
  text: string;
}

export interface GoExerciseItem {
  id: string;
  level: '基础' | '进阶' | '挑战';
  title: string;
  description: string;
}

export interface GoDaySummary {
  day: number;
  id: string;
  title: string;
  shortTitle: string;
  goal: string;
  estimatedHours: string;
  keywords: string[];
  deliverable: string;
  checklist: GoChecklistItem[];
  exercises: GoExerciseItem[];
}

export interface GoSandboxFile {
  path: string;
  content: string;
  size: number;
  updatedAt: string;
}

export interface GoDayDetail extends GoDaySummary {
  cardMarkdown: string;
  tutorialMarkdown: string;
  answerCode: string;
  expectedRunOutput: string;
}

export interface GoEnvironmentStatus {
  installed: boolean;
  version: string;
  goBinaryPath: string;
  goproxy: string;
  cgoEnabled: string;
  installHint: string;
  port8080Listening: boolean;
}

export interface GoLearningProgress {
  currentDay: number;
  activeSnapshot: string;
  checkedItems: string[];
  completedExercises: string[];
  notes: Record<string, string>;
  updatedAt: string;
}

export interface GoLearningOverview {
  environment: GoEnvironmentStatus;
  sandboxPath: string;
  docsPath: string;
  progress: GoLearningProgress;
  days: GoDaySummary[];
  currentDayDetail: GoDayDetail;
  sandboxFiles: GoSandboxFile[];
  tasksJsonContent: string | null;
  guideMarkdown: string;
  cheatSheetMarkdown: string;
}

export interface GoCommandRunResult {
  action: GoCommandAction;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  ranAt: string;
  simulated: boolean;
  notice?: string;
}

export interface GoHttpDebugResult {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  status: number;
  statusText: string;
  responseBody: string;
  mode: 'live-server' | 'sandbox-simulator';
  durationMs: number;
  tasksJsonContent: string | null;
}

export const goProgressUpdateSchema = z.object({
  currentDay: z.number().int().min(1).max(7).optional(),
  toggleChecklistId: z.string().trim().min(1).max(80).optional(),
  toggleExerciseId: z.string().trim().min(1).max(80).optional(),
  note: z.object({
    day: z.number().int().min(1).max(7),
    content: z.string().max(50_000),
  }).optional(),
}).strict();

export const goSandboxInitSchema = z.object({
  snapshot: z.enum(['day1', 'day2', 'day3', 'day4', 'day5', 'day6', 'day7', 'day7-graduation']),
}).strict();

export const goSandboxSaveFileSchema = z.object({
  filePath: z.string().trim().min(1).max(260).regex(/^[a-zA-Z0-9_./-]+$/),
  content: z.string().max(200_000),
}).strict();

export const goSandboxRunSchema = z.object({
  action: z.enum(goCommandActions),
  args: z.array(z.string().max(120)).max(6).optional(),
}).strict();

export const goHttpDebugSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
  path: z.string().trim().min(1).max(200).startsWith('/tasks'),
  body: z.string().max(10_000).optional(),
}).strict();
