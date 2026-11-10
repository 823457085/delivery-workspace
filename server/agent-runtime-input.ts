/** 启动参数与运行服务分离，便于验证无项目会话；空目录由服务分配，不默认为工作台源码或用户主目录。 */
import { z } from 'zod';

export const agentReasoningSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).or(z.literal(''));
export const agentServiceTierSchema = z.enum(['default', 'priority']);
export const agentAccessSchema = z.enum(['workspace', 'full']);
export const agentAttachmentIdsSchema = z.array(z.string().uuid()).max(6).default([]);
export const agentCustomModelSchema = z.object({ provider: z.enum(['codex', 'cursor', 'claude', 'kiro', 'antigravity', 'api', 'deepseek', 'workbuddy', 'grok']),
  modelId: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(80),
  api: z.object({ baseUrl: z.string().trim().min(1).max(2000), apiKey: z.string().trim().max(8192).optional() }).strict().optional(),
}).strict().refine(input => ['api', 'grok', 'deepseek'].includes(input.provider) ? !!input.api : !input.api, { message: '请按接入方式填写模型配置' });
export const agentStartSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  return input.mode === 'agent' && input.accessMode === undefined ? { ...input, accessMode: 'full' } : value;
}, z.object({ provider: z.enum(['codex', 'cursor', 'claude', 'kiro', 'antigravity', 'api', 'deepseek', 'workbuddy', 'grok']), mode: z.enum(['agent', 'plan', 'ask']),
  continueConversationId: z.string().uuid().optional(),
  accessMode: agentAccessSchema.default('workspace'), model: z.string().trim().max(100), reasoningEffort: agentReasoningSchema.default(''),
  serviceTier: agentServiceTierSchema.optional(), objective: z.string().max(200_000),
  attachmentIds: agentAttachmentIdsSchema, workspacePath: z.string().trim().max(1000).default(''),
  // 兼容已打开的旧页面。多项目列表仅用于编辑器，执行目录仍由 workspacePath 指定。
  workspacePaths: z.array(z.string()).optional(),
  branch: z.string().trim().max(300).optional(), isolateWorkspace: z.boolean().default(false),
  cursorTrustPath: z.string().trim().max(1000).optional() }).strict()
  .refine((input) => !!input.objective.trim() || !!input.attachmentIds.length, { message: '请填写消息或添加附件' })
  .refine((input) => !!input.workspacePath || !input.branch, { path: ['branch'], message: '指定分支时需要选择工作区' })
  .refine((input) => input.mode === 'agent' || input.accessMode === 'workspace', { message: '只有 Agent 模式可使用完全访问' })
  .transform(({ workspacePaths: _workspacePaths, ...input }) => input));
