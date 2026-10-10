/** 启动参数与运行服务分离，便于验证无项目会话；空目录由服务分配，不默认为工作台源码或用户主目录。 */
import { z } from 'zod';

export const agentReasoningSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).or(z.literal(''));
export const agentServiceTierSchema = z.enum(['default', 'priority']);
export const agentAccessSchema = z.enum(['workspace', 'full']);
export const agentAttachmentIdsSchema = z.array(z.string().uuid()).max(6).default([]);
export const agentStartSchema = z.object({ provider: z.enum(['codex', 'cursor']), mode: z.enum(['agent', 'plan', 'ask']),
  accessMode: agentAccessSchema.default('workspace'), model: z.string().trim().max(100), reasoningEffort: agentReasoningSchema.default(''),
  serviceTier: agentServiceTierSchema.optional(), objective: z.string().max(200_000),
  attachmentIds: agentAttachmentIdsSchema, workspacePath: z.string().trim().max(1000).default(''),
  branch: z.string().trim().max(300).optional(), isolateWorkspace: z.boolean().default(false),
  cursorTrustPath: z.string().trim().max(1000).optional() }).strict()
  .refine((input) => !!input.objective.trim() || !!input.attachmentIds.length, { message: '请填写消息或添加附件' })
  .refine((input) => !!input.workspacePath || !input.branch, { path: ['branch'], message: '指定分支时需要选择工作区' })
  .refine((input) => input.mode === 'agent' || input.accessMode === 'workspace', { message: '只有 Agent 模式可使用完全访问' });
