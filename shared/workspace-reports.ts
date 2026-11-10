import { z } from 'zod';
import type { WecomPublicConfig } from './wecom-integration.js';

export const reportSourceLabels = { jira: 'Jira 任务', agent: 'Agent 会话', delivery: '研发交付', team: '团队协作', manual: '个人待办' } as const;
export const reportSectionLabels = { doing: '正在进行', todo: '接下来要做', blocked: '卡住了，需要处理', review: '需要你确认', completed: '今天已完成', next: '下一步怎么做', coverage: '本次检查范围' } as const;
export type ReportSource = keyof typeof reportSourceLabels;
export type ReportSection = keyof typeof reportSectionLabels;
export type ReportCategory = Exclude<ReportSection, 'next' | 'coverage'>;
export interface ReportTask {
  id: string; title: string; source: ReportSource; relatedSources?: ReportSource[]; category: ReportCategory; status: string;
  detail: string; nextAction?: string; updatedAt: string; completedAt?: string; dueDate?: string; url?: string; jiraUrl?: string; project?: string;
}
export interface ReportCoverage { source: ReportSource; label: string; available: boolean; detail?: string }
export interface ReportSnapshot { generatedAt: string; tasks: ReportTask[]; jiraTasks?: ReportTask[]; coverage: ReportCoverage[] }
const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; } };
const knownPlaceholder = /\{([^{}]+)\}/g;
export const reportPolicySchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/), name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false), kind: z.enum(['summary', 'overdue']).default('summary'),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  timeZone: z.string().trim().refine(validTimeZone, '请选择有效时区'),
  sources: z.array(z.enum(['jira', 'agent', 'delivery', 'team', 'manual'])).min(1).max(5),
  sections: z.array(z.enum(['doing', 'todo', 'blocked', 'review', 'completed', 'next', 'coverage'])).min(1).max(7),
  projectFilter: z.string().trim().max(200).default(''), maxItems: z.number().int().min(1).max(30).default(5),
  template: z.string().max(12000).default('').refine(value => [...value.matchAll(knownPlaceholder)].every(match => ['date', ...Object.keys(reportSectionLabels)].includes(match[1])), '模板包含未知占位符'),
  enabledAt: z.string().datetime().optional(),
}).strict();
export type ReportPolicy = z.infer<typeof reportPolicySchema>;
export const workspaceReportSettingsSchema = z.object({
  policies: z.array(reportPolicySchema).max(30), botTarget: z.enum(['integration', 'dedicated']),
  confirmedGroupName: z.string().trim().max(80).default(''),
}).strict().refine(value => new Set(value.policies.map(policy => policy.id)).size === value.policies.length, '策略标识不能重复');
export type WorkspaceReportSettings = z.infer<typeof workspaceReportSettingsSchema>;
export type ReportCounts = Record<ReportCategory, number>;
export interface ReportPreview {
  id: string; policyId: string; policyName: string; generatedAt: string; fullContent: string; content: string;
  counts: ReportCounts; coverage: ReportCoverage[]; botTarget: WorkspaceReportSettings['botTarget']; groupName: string;
  canSend: boolean; bytes: number; truncated: boolean;
  parts: { content: string; bytes: number }[];
}
export interface ReportRun {
  id: string; previewId: string; policyId: string; policyName: string; trigger: 'manual' | 'schedule'; slot: string;
  botTarget: WorkspaceReportSettings['botTarget']; groupName: string; status: 'sending' | 'sent' | 'failed' | 'unknown';
  attemptedAt: string; finishedAt: string; message: string;
  partCount?: number; sentParts?: number;
  parts?: { index: number; status: ReportRun['status']; attemptedAt: string; finishedAt: string; message: string }[];
}
export interface WorkspaceReportsDashboard {
  settings: WorkspaceReportSettings; bots: { integration: WecomPublicConfig; dedicated: WecomPublicConfig };
  history: ReportRun[]; running: boolean; scheduler: { online: boolean; note: string };
}
export function defaultReportPolicy(id = 'daily-summary'): ReportPolicy {
  return reportPolicySchema.parse({ id, name: '每日综合汇报', enabled: false, kind: 'summary', times: ['18:00'],
    weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: 'Asia/Singapore', sources: Object.keys(reportSourceLabels), sections: Object.keys(reportSectionLabels), projectFilter: '', maxItems: 5, template: '' });
}
