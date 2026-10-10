import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createService } from './service.js';
import { proxySource } from './source-proxy.js';
import { createSourceBackend } from './source-backend.js';
import { createDesignExecutor } from './design-executor/service.js';
import { createCliQueue } from './cli-queue.js';
import { createAgentRuntimeService } from './agent-runtime.js';
import { agentAccessSchema, agentAttachmentIdsSchema, agentReasoningSchema, agentServiceTierSchema, agentStartSchema } from './agent-runtime-input.js';
import { createAgentRuntimeStream } from './agent-runtime-stream.js';
import { createAgentAttachmentStore } from './agent-attachments.js';
import { isAgentImageAttachment } from '../shared/agent-runtime.js';
import { listCodexSkills } from './codex-skills.js';
import { createWorkspacePickerRoute } from './workspace-picker.js';
import { createWorkspaceTerminalRoute } from './workspace-terminal.js';
import { createIntegrationStore } from './api-integration.js';
import { createApexBffReviewStore } from './apex-bff-review.js';
import { initializeExecutionProgress } from '../scripts/integration-execution-progress.js';
import { createWecomIntegration } from './wecom-integration.js';
import { createCodexUsageReader } from './codex-usage.js';
import { createAgentNoteStore } from './agent-notes.js';
import { createRequirementDevelopmentService } from './requirement-development.js';
import { createJiraFixService } from './jira-fix.js';
import { createJiraFixHandoffService } from './jira-fix-handoff.js';
import { createJiraHandoffClient } from './jira-handoff-client.js';
import { jiraReferenceSchema } from '../shared/jira-fix.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 5199);
const dataDirectory = process.env.DELIVERY_DATA_DIR ?? path.join(root, '.data');
const sourceBackend = await createSourceBackend(port);
const service = await createService(dataDirectory, {
  model: process.env.DELIVERY_MODEL || undefined,
  readSource: () => sourceBackend.readMergePlan(false),
});
const designExecutor = await createDesignExecutor(path.join(dataDirectory, 'design-executor'));
const cliQueue = await createCliQueue(dataDirectory);
const agentAttachments = await createAgentAttachmentStore(path.join(dataDirectory, 'agent-runtimes', 'attachments'));
const agentNotes = await createAgentNoteStore(path.join(dataDirectory, 'agent-notes'));
const agentRuntimes = await createAgentRuntimeService(path.join(dataDirectory, 'agent-runtimes'), {
  resolveKnowledge: agentNotes.resolveReferences,
  resolveAttachments: agentAttachments.resolve,
  removeAttachments: agentAttachments.remove,
});
const workspacePicker = createWorkspacePickerRoute();
const workspaceTerminal = createWorkspaceTerminalRoute();
const requirementDevelopment = await createRequirementDevelopmentService(path.join(dataDirectory, 'requirement-development'), agentRuntimes);
const jiraFix = await createJiraFixService(path.join(dataDirectory, 'jira-fix'), agentRuntimes, sourceBackend);
const jiraFixHandoff = await createJiraFixHandoffService(path.join(dataDirectory, 'jira-fix-handoffs'), id => {
  const record = jiraFix.list().find(item => item.id === id);
  return record ? { record, run: agentRuntimes.findJiraFix(id), history: agentRuntimes.jiraFixResults(id) } : undefined;
}, createJiraHandoffClient(sourceBackend.jiraFixHandoffRequest));
const integration = await createIntegrationStore(dataDirectory);
const apexBffReview = await createApexBffReviewStore(dataDirectory);
await initializeExecutionProgress(root);
const wecomIntegration = await createWecomIntegration(dataDirectory);
const readCodexUsage = createCodexUsageReader();
const vite = process.argv.includes('--dev') ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
const workflowContextSchema = z.object({ conversationId: z.string().trim().min(1).max(200), agentRunId: z.string().trim().min(1).max(200),
  workspacePath: z.string().trim().min(1).max(1000), branch: z.string().trim().max(300), provider: z.enum(['codex', 'cursor']) }).strict();
const startSchema = z.object({ requirementId: z.string().regex(/^REQ-(?:CU-)?\d{3}$/), scenario: z.enum(['standard', 'missing-evidence', 'merge-conflict']),
  context: workflowContextSchema.optional() }).strict();
const resumeSchema = z.object({ action: z.enum(['approve', 'retest']) });
const agentResumeSchema = z.object({ objective: z.string().max(200_000), attachmentIds: agentAttachmentIdsSchema,
  model: z.string().trim().max(100).optional(), reasoningEffort: agentReasoningSchema.optional(), serviceTier: agentServiceTierSchema.optional(), accessMode: agentAccessSchema.optional(),
  queuePlacement: z.enum(['append', 'next']).default('append') }).strict()
  .refine((input) => !!input.objective.trim() || !!input.attachmentIds.length, { message: '请填写消息或添加附件' });
const agentSpawnSchema = z.object({ title: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(200_000),
  role: z.enum(['worker', 'reviewer']).default('worker'),
  dependsOnConversationIds: z.array(z.string().trim().min(1).max(200)).max(12).default([]) }).strict();
const agentTaskWorkflowSchema = z.object({ templateId: z.literal('implement-review'),
  objective: z.string().trim().min(1).max(200_000), model: z.string().trim().max(100).optional(),
  reasoningEffort: agentReasoningSchema.optional(), serviceTier: agentServiceTierSchema.optional(), accessMode: agentAccessSchema.optional(),
  attachmentIds: agentAttachmentIdsSchema }).strict();
const agentAttachmentUploadSchema = z.object({ name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(100).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  data: z.string().min(1).max(14_000_000) }).strict();
const agentCustomModelSchema = z.object({ provider: z.enum(['codex', 'cursor']), modelId: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(80) }).strict();
const agentConversationTitleSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();

async function body(request: http.IncomingMessage, limit = 300_000): Promise<unknown> {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > limit) throw new Error('请求内容过大'); }
  return JSON.parse(text || '{}');
}
function json(response: http.ServerResponse, code: number, value: unknown) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/workspace/select') { await workspacePicker(request, response, port); return; }
      if (url.pathname === '/api/workspace/terminal') { await workspaceTerminal(request, response, port); return; }
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) { json(response, 403, { message: '请求来源不匹配' }); return; }
        if (!request.headers['content-type']?.includes('application/json')) { json(response, 415, { message: '请发送 JSON' }); return; }
      }
      if (url.pathname === '/api/integration-catalog' && request.method === 'GET') { json(response, 200, integration.catalog); return; }
      if (url.pathname === '/api/refactor-integration') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET') { json(response, 200, integration.snapshot()); return; }
        if (request.method === 'POST') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          json(response, 200, await integration.update(await body(request))); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (url.pathname.startsWith('/api/integration-wecom')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
        if (url.pathname === '/api/integration-wecom/config') {
          if (request.method === 'GET') { json(response, 200, wecomIntegration.config()); return; }
          if (request.method === 'POST') { json(response, 200, await wecomIntegration.configure(await body(request, 30_000))); return; }
        }
        if (url.pathname === '/api/integration-wecom/reports' && request.method === 'GET') { json(response, 200, wecomIntegration.history(url.searchParams.get('interfaceId') || '')); return; }
        if (url.pathname === '/api/integration-wecom/preview' && request.method === 'POST') { json(response, 200, wecomIntegration.preview(await body(request, 60_000))); return; }
        if (url.pathname === '/api/integration-wecom/send' && request.method === 'POST') {
          if (request.headers['x-delivery-confirmed'] !== 'yes') { json(response, 403, { message: '请先预览并确认发送到企业微信群' }); return; }
          json(response, 200, await wecomIntegration.send(await body(request, 60_000))); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (url.pathname === '/api/apex-bff-review') {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'GET') { json(response, 200, apexBffReview.snapshot()); return; }
        if (request.method === 'POST') {
          if (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '请求来源不匹配' }); return; }
          json(response, 200, await apexBffReview.update(await body(request, 50_000))); return;
        }
        json(response, 405, { message: '请求方法不支持' }); return;
      }
      if (url.pathname.startsWith('/api/cli-executor')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '') || request.headers['x-delivery-confirmed'] !== 'yes')) { json(response, 403, { message: '请在当前面板确认 CLI 执行操作' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/cli-executor') { json(response, 200, await cliQueue.dashboard()); return; }
        if (request.method === 'POST' && ['/api/cli-executor/start', '/api/cli-executor/pause'].includes(url.pathname)) {
          z.object({}).strict().parse(await body(request));
          const starting = url.pathname.endsWith('/start');
          const state = await (starting ? cliQueue.start() : cliQueue.pause());
          json(response, 200, { ...state, message: starting ? 'Codex CLI 队列已启动，仅领取已授权任务' : '已暂停新任务领取，正在执行的任务会继续完成' }); return;
        }
        json(response, 404, { message: 'CLI 执行接口不存在' }); return;
      }
      if (url.pathname.startsWith('/api/agent-runtimes')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && (![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '') || request.headers['x-delivery-confirmed'] !== 'yes')) {
          json(response, 403, { message: '请在当前面板确认本机 Agent 操作' }); return;
        }
        if (url.pathname === '/api/agent-runtimes/jira-fix/resolve' && request.method === 'POST') {
          const input = z.object({ issueKey: jiraReferenceSchema }).strict().parse(await body(request));
          json(response, 200, await jiraFix.resolve(input.issueKey)); return;
        }
        if (url.pathname === '/api/agent-runtimes/jira-fix') {
          if (request.method === 'GET') { json(response, 200, { records: jiraFix.list().map(record => ({ ...record, handoff: jiraFixHandoff.state(record.id) })) }); return; }
          if (request.method === 'POST') { json(response, 202, jiraFix.start(await body(request))); return; }
        }
        const draft = url.pathname.match(/^\/api\/agent-runtimes\/jira-fix\/([0-9a-f-]{36})\/handoff\/draft$/);
        if (draft && request.method === 'POST') {
          const controller = new AbortController();
          const abort = () => { if (!response.writableEnded) controller.abort(); };
          response.once('close', abort);
          try { json(response, 200, await jiraFixHandoff.generate(draft[1], await body(request), controller.signal)); }
          finally { response.off('close', abort); }
          return;
        }
        const statusChange = url.pathname.match(/^\/api\/agent-runtimes\/jira-fix\/([0-9a-f-]{36})\/handoff\/status$/);
        if (statusChange && request.method === 'POST') {
          json(response, 200, await jiraFixHandoff.applyStatus(statusChange[1], await body(request))); return;
        }
        const handoff = url.pathname.match(/^\/api\/agent-runtimes\/jira-fix\/([0-9a-f-]{36})\/handoff$/);
        if (handoff) {
          if (request.method === 'GET') { json(response, 200, await jiraFixHandoff.context(handoff[1])); return; }
          if (request.method === 'POST') { json(response, 200, await jiraFixHandoff.submit(handoff[1], await body(request))); return; }
        }
        if (url.pathname === '/api/agent-runtimes/requirement-development') {
          if (request.method === 'GET') { json(response, 200, { records: requirementDevelopment.list() }); return; }
          if (request.method === 'POST') { json(response, 202, await requirementDevelopment.start(await body(request))); return; }
        }
        if (url.pathname === '/api/agent-runtimes/obsidian/config') {
          if (request.method === 'GET') { json(response, 200, await agentNotes.config()); return; }
          if (request.method === 'POST') {
            const input = z.object({ path: z.string().trim().max(1000) }).strict().parse(await body(request));
            json(response, 200, await agentNotes.configure(input.path)); return;
          }
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/obsidian/folders') {
          json(response, 200, await agentNotes.folders()); return;
        }
        if (url.pathname === '/api/agent-runtimes/obsidian/notes') {
          if (request.method === 'GET') {
            const input = z.object({ q: z.string().trim().max(200).default('') }).parse(Object.fromEntries(url.searchParams));
            json(response, 200, await agentNotes.search(input.q)); return;
          }
          if (request.method === 'POST') {
            const input = z.object({ filename: z.string().min(1).max(180), content: z.string().min(1).max(256_000), vaultId: z.string().regex(/^[a-f0-9]{16}$/), folder: z.string().max(1000).default('') }).strict().parse(await body(request));
            json(response, 201, await agentNotes.create(input.filename, input.content, input.vaultId, input.folder)); return;
          }
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/obsidian/note') {
          const input = z.object({ reference: z.string().min(1).max(2000) }).parse(Object.fromEntries(url.searchParams));
          json(response, 200, await agentNotes.read(input.reference)); return;
        }
        const agentAttachment = url.pathname.match(/^\/api\/agent-runtimes\/attachments\/([0-9a-f-]{36})$/);
        if (request.method === 'GET' && agentAttachment) {
          const item = await agentAttachments.read(agentAttachment[1]);
          response.writeHead(200, { 'Content-Type': item.attachment.mimeType, 'Content-Length': item.content.length,
            ...(isAgentImageAttachment(item.attachment) ? {} : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.attachment.name)}` }),
            'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
          response.end(item.content); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/attachments') {
          const input = agentAttachmentUploadSchema.parse(await body(request, 14_100_000));
          json(response, 201, await agentAttachments.upload(input)); return;
        }
        const removeAgentAttachment = url.pathname.match(/^\/api\/agent-runtimes\/attachments\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && removeAgentAttachment) {
          z.object({}).strict().parse(await body(request));
          await agentAttachments.remove([removeAgentAttachment[1]]);
          json(response, 200, { deleted: true }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes') {
          const [dashboard, codexUsage] = await Promise.all([agentRuntimes.dashboard(), readCodexUsage()]);
          json(response, 200, { ...dashboard, codexUsage }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const currentRevision = agentRuntimes.revision();
          response.write(`id: ${currentRevision}\nevent: ready\ndata: ${JSON.stringify({ revision: currentRevision })}\n\n`);
          const lastRevision = Number(request.headers['last-event-id'] || 0);
          if (Number.isFinite(lastRevision) && lastRevision > 0 && lastRevision < currentRevision) {
            response.write(`id: ${currentRevision}\nevent: refresh\ndata: ${JSON.stringify({ revision: currentRevision, recovered: true })}\n\n`);
          }
          const stream = createAgentRuntimeStream((frame) => { if (!response.destroyed) response.write(frame); }, url.searchParams.get('updates') === 'runs');
          const unsubscribe = agentRuntimes.subscribe(stream.update);
          const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15_000);
          request.on('close', () => { clearInterval(heartbeat); stream.close(); unsubscribe(); });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/codex-sessions/sync') {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.syncCodexSessions()); return;
        }
        const codexSession = url.pathname.match(/^\/api\/agent-runtimes\/codex-sessions\/([0-9a-f-]{36})$/);
        if (request.method === 'GET' && codexSession) {
          json(response, 200, await agentRuntimes.codexSession(codexSession[1])); return;
        }
        const resumeCodexSession = url.pathname.match(/^\/api\/agent-runtimes\/codex-sessions\/([0-9a-f-]{36})\/resume$/);
        if (request.method === 'POST' && resumeCodexSession) {
          const input = agentResumeSchema.parse(await body(request));
          json(response, 202, await agentRuntimes.resumeCodexSession(resumeCodexSession[1], input.objective, input.model,
            input.reasoningEffort, input.attachmentIds, input.accessMode, input.serviceTier)); return;
        }
        const removeCodexSession = url.pathname.match(/^\/api\/agent-runtimes\/codex-sessions\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && removeCodexSession) {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.removeCodexSession(removeCodexSession[1])); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/files') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000), q: z.string().trim().max(200).default('') })
            .parse(Object.fromEntries(url.searchParams));
          json(response, 200, await agentRuntimes.workspaceFiles(input.workspacePath, input.q)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/mentions') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000), provider: z.enum(['codex', 'cursor']),
            q: z.string().trim().max(200).default('') }).parse(Object.fromEntries(url.searchParams));
          const files = await agentRuntimes.workspaceFiles(input.workspacePath, input.q);
          const skills = input.provider === 'codex' ? await listCodexSkills(files.workspacePath, input.q) : [];
          json(response, 200, { ...files, skills }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/knowledge') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000), provider: z.enum(['codex', 'cursor']),
            q: z.string().trim().max(200).default('') }).parse(Object.fromEntries(url.searchParams));
          const [files, contents, skills] = await Promise.all([
            agentRuntimes.workspaceFiles(input.workspacePath, input.q),
            agentRuntimes.workspaceKnowledge(input.workspacePath, input.q),
            input.provider === 'codex' ? listCodexSkills(input.workspacePath, input.q) : [],
          ]);
          json(response, 200, { ...files, ...contents, skills }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent-runtimes/branches') {
          const input = z.object({ workspacePath: z.string().trim().min(1).max(1000) }).parse(Object.fromEntries(url.searchParams));
          json(response, 200, await agentRuntimes.workspaceBranches(input.workspacePath)); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/models') {
          json(response, 201, await agentRuntimes.addCustomModel(agentCustomModelSchema.parse(await body(request)))); return;
        }
        const agentModel = url.pathname.match(/^\/api\/agent-runtimes\/models\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && agentModel) {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.removeCustomModel(agentModel[1])); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/runs') {
          json(response, 202, await agentRuntimes.start(agentStartSchema.parse(await body(request)))); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/agent-runtimes/conversation-ids/migrate') {
          const input = z.object({ assignments: z.array(z.object({ runId: z.string().uuid(), conversationId: z.string().uuid(),
            codexTurnId: z.string().uuid().optional() }).strict()).min(1).max(100) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.migrateConversationIds(input.assignments)); return;
        }
        const prepareIsolation = url.pathname.match(/^\/api\/agent-runtimes\/conversations\/([0-9a-f-]{36})\/prepare-isolation$/);
        if (request.method === 'POST' && prepareIsolation) {
          const input = z.object({ preparedWorkspacePath: z.string().trim().min(1).max(1000).optional() }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.prepareConversationIsolation(prepareIsolation[1], input.preparedWorkspacePath)); return;
        }
        const spawnAgentTask = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/spawn$/);
        if (request.method === 'POST' && spawnAgentTask) {
          json(response, 202, await agentRuntimes.spawn(spawnAgentTask[1], agentSpawnSchema.parse(await body(request)))); return;
        }
        const orchestrateAgentTask = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/orchestrate$/);
        if (request.method === 'POST' && orchestrateAgentTask) {
          json(response, 202, await agentRuntimes.orchestrate(orchestrateAgentTask[1], agentTaskWorkflowSchema.parse(await body(request)))); return;
        }
        const openAgentFile = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/open-file$/);
        if (request.method === 'POST' && openAgentFile) {
          const input = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.openChangedFile(openAgentFile[1], input.path)); return;
        }
        const revealAgentFile = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/reveal-file$/);
        if (request.method === 'POST' && revealAgentFile) {
          const input = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.revealChangedFile(revealAgentFile[1], input.path)); return;
        }
        const openAgentFileInBrowser = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/open-browser$/);
        if (request.method === 'POST' && openAgentFileInBrowser) {
          const input = z.object({ path: z.string().trim().min(1).max(1000) }).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.openChangedFileInBrowser(openAgentFileInBrowser[1], input.path)); return;
        }
        const agentRun = url.pathname.match(/^\/api\/agent-runtimes\/runs\/([0-9a-f-]{36})\/(stop|pause-edit|revise|steer|resume|fork|retry|delete)$/);
        if (request.method === 'POST' && agentRun) {
          const [, id, action] = agentRun;
          if (action === 'delete') { z.object({}).strict().parse(await body(request)); json(response, 200, await agentRuntimes.removeQueuedRun(id)); return; }
          if (action === 'pause-edit') { z.object({}).strict().parse(await body(request)); json(response, 200, await agentRuntimes.pauseForEdit(id)); return; }
          if (action === 'revise') {
            const input = z.object({ objective: z.string().max(200_000), cursorTrustPath: z.string().trim().min(1).max(1000).optional() }).strict().parse(await body(request));
            json(response, 202, await agentRuntimes.revise(id, input.objective, input.cursorTrustPath)); return;
          }
          if (action === 'stop') { z.object({}).strict().parse(await body(request)); json(response, 202, await agentRuntimes.stop(id)); return; }
          if (action === 'steer') { z.object({}).strict().parse(await body(request)); json(response, 202, await agentRuntimes.steer(id)); return; }
          if (action === 'retry') {
            const input = z.object({ cursorTrustPath: z.string().trim().min(1).max(1000).optional() }).strict().parse(await body(request));
            json(response, 202, await agentRuntimes.retry(id, input.cursorTrustPath)); return;
          }
          const input = agentResumeSchema.parse(await body(request));
          json(response, 202, action === 'fork'
            ? await agentRuntimes.fork(id, input.objective, input.model, input.reasoningEffort, input.attachmentIds, input.serviceTier)
            : await agentRuntimes.resume(id, input.objective, input.model, input.reasoningEffort, input.attachmentIds, input.accessMode,
              input.queuePlacement, input.serviceTier)); return;
        }
        const agentConversation = url.pathname.match(/^\/api\/agent-runtimes\/conversations\/([0-9a-f-]{36})\/delete$/);
        if (request.method === 'POST' && agentConversation) {
          z.object({}).strict().parse(await body(request));
          json(response, 200, await agentRuntimes.removeConversation(agentConversation[1])); return;
        }
        const agentConversationTitle = url.pathname.match(/^\/api\/agent-runtimes\/conversations\/([0-9a-f-]{36})\/title$/);
        if (request.method === 'POST' && agentConversationTitle) {
          const input = agentConversationTitleSchema.parse(await body(request));
          json(response, 200, await agentRuntimes.updateConversationTitle(agentConversationTitle[1], input.title)); return;
        }
        json(response, 404, { message: 'Agent 执行接口不存在' }); return;
      }
      if (url.pathname.startsWith('/api/design-executor')) {
        if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) { json(response, 403, { message: '仅接受本机看板请求' }); return; }
        if (request.method === 'POST' && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin || '')) { json(response, 403, { message: '自动执行命令必须来自本机看板' }); return; }
        if (request.method === 'POST' && request.headers['x-delivery-confirmed'] !== 'yes') { json(response, 403, { message: '必须先确认自动执行对 Confluence 和 Jira 的影响' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/design-executor') { json(response, 200, await designExecutor.dashboard()); return; }
        if (request.method === 'POST' && url.pathname === '/api/design-executor/runs') { json(response, 202, await designExecutor.start(await body(request))); return; }
        const execution = url.pathname.match(/^\/api\/design-executor\/runs\/([0-9a-f-]{36})\/(resume|stop|snapshot|desktop|claim|submit)$/);
        if (execution) {
          const [, id, action] = execution;
          if (request.method === 'GET' && action === 'desktop') { json(response, 200, designExecutor.desktop(id)); return; }
          if (request.method === 'POST' && action === 'claim') { json(response, 200, await designExecutor.claim(id, await body(request))); return; }
          if (request.method === 'POST' && action === 'submit') { json(response, 200, await designExecutor.submit(id, await body(request))); return; }
          if (request.method === 'GET' && action === 'snapshot') { json(response, 200, await designExecutor.snapshot(id)); return; }
          if (request.method === 'POST' && action === 'resume') { json(response, 202, await designExecutor.resume(id, await body(request))); return; }
          if (request.method === 'POST' && action === 'stop') { const data = z.object({ revision: z.number().int() }).strict().parse(await body(request)); json(response, 202, await designExecutor.stop(id, data.revision)); return; }
        }
        json(response, 404, { message: '自动执行接口不存在' }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/source/refresh') { json(response, 200, await service.refreshSource()); return; }
      if (url.pathname.startsWith('/api/source/')) { await proxySource(request, response, url, sourceBackend); return; }
      if (sourceBackend.handles(url.pathname)) { await sourceBackend.dispatch(request, response, `${url.pathname}${url.search}`); return; }
      if (request.method === 'GET' && url.pathname === '/api/health') { json(response, 200, { ok: true, app: 'Delivery Workspace', source: 'embedded', labEngine: 'Mastra', labDemoOnly: true, designExecutor: 'Codex desktop session' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') { json(response, 200, await service.dashboard()); return; }
      if (request.method === 'GET' && url.pathname === '/api/workflow/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const currentRevision = service.revision();
        response.write(`id: ${currentRevision}\nevent: ready\ndata: ${JSON.stringify({ revision: currentRevision })}\n\n`);
        const lastRevision = Number(request.headers['last-event-id'] || 0);
        if (Number.isFinite(lastRevision) && lastRevision > 0 && lastRevision < currentRevision) {
          response.write(`id: ${currentRevision}\nevent: refresh\ndata: ${JSON.stringify({ revision: currentRevision, recovered: true })}\n\n`);
        }
        const unsubscribe = service.subscribe((eventRevision) => {
          if (!response.destroyed) response.write(`id: ${eventRevision}\nevent: refresh\ndata: ${JSON.stringify({ revision: eventRevision })}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15_000);
        request.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const data = startSchema.parse(await body(request)); json(response, 202, await service.start(data.requirementId, data.scenario, undefined, data.context)); return;
      }
      const match = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{36})(?:\/(resume|rework|snapshot))?$/);
      if (match) {
        const [, runId, action] = match;
        if (request.method === 'GET' && !action) { json(response, 200, await service.getRun(runId)); return; }
        if (request.method === 'GET' && action === 'snapshot') { json(response, 200, await service.rawSnapshot(runId)); return; }
        if (request.method === 'POST' && action === 'resume') { const data = resumeSchema.parse(await body(request)); json(response, 202, await service.resume(runId, data.action)); return; }
        if (request.method === 'POST' && action === 'rework') { json(response, 202, await service.rework(runId)); return; }
      }
      json(response, 404, { message: '接口不存在' }); return;
    }
    if (sourceBackend.handles(url.pathname)) { await sourceBackend.dispatch(request, response, `${url.pathname}${url.search}`); return; }
    if (vite) { vite.middlewares(request, response); return; }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, 'dist', relative || 'index.html');
    if (!file.startsWith(`${path.join(root, 'dist')}${path.sep}`)) { response.writeHead(404); response.end(); return; }
    try {
      const spa = !path.extname(relative);
      const content = await fs.readFile(spa ? path.join(root, 'dist', 'index.html') : file);
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      response.writeHead(200, { 'Content-Type': spa ? mime['.html'] : mime[path.extname(file)] ?? 'application/octet-stream' }); response.end(content);
    } catch { response.writeHead(404); response.end('Not found'); }
  } catch (error) {
    json(response, 400, { message: error instanceof z.ZodError ? '输入格式不正确' : error instanceof Error ? error.message : String(error) });
  }
});
server.listen(port, '127.0.0.1', () => {
  if (process.env.DELIVERY_SCHEDULER_DISABLED !== '1') sourceBackend.start();
  console.log(`Delivery Workspace: http://localhost:${port} · unified backend · Mastra lab /lab`);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => {
  server.close(); sourceBackend.close(); await Promise.all([requirementDevelopment.close(), jiraFix.close(), jiraFixHandoff.close()]); await Promise.all([cliQueue.close(), agentRuntimes.close(), designExecutor.close(), integration.close(), apexBffReview.close(), wecomIntegration.close()]); await vite?.close(); await service.close(); process.exit(0);
});
