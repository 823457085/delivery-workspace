/** 高级团队固定接口；浏览器不能传任意执行器参数、命令或原生会话 ID。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { createAgentTeamService } from './agent-team-service.js';
import type { createAgentTeamGovernance } from './agent-team-governance.js';
import type { createAgentUsageStore } from './agent-usage.js';
import { teamModelChoiceSchema, teamProfileIds, teamProfileSchema } from '../shared/agent-team.js';
import { teamTemplateIds } from '../shared/agent-task-plan.js';
const requestId = z.string().min(1).max(150), id = z.string().uuid();
const planInput = z.object({ expectedRevision: z.number().int().nonnegative(), action: z.enum(['confirm', 'replan', 'cancel']), requestId,
  plan: z.unknown().optional(), answers: z.array(z.object({ questionId: z.string().min(1).max(40), text: z.string().trim().min(1).max(12000) }).strict()).max(30).optional() }).strict();
const decisionInput = z.object({ action: z.enum(['retry', 'retry_review_codex', 'extend', 'escalate', 'takeover', 'cancel', 'resolve_conflicts', 'ask_leader']), requestId, nodeId: id.optional(), accessMode: z.enum(['workspace', 'full']).optional() }).strict()
  .refine(input => input.accessMode === undefined || ['retry', 'retry_review_codex'].includes(input.action), '只有重试操作可以选择访问权限');
export function createAgentTeamRoutes(team: Awaited<ReturnType<typeof createAgentTeamService>>, governance: Awaited<ReturnType<typeof createAgentTeamGovernance>>,
  usage: Awaited<ReturnType<typeof createAgentUsageStore>>, io: { json(response: ServerResponse, status: number, value: unknown): void;
    body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number }) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const prefix = '/api/agent-runtimes', route = url.pathname.slice(prefix.length);
    if (!/^\/(?:team-chat|team-tasks|agent-profiles|agent-usage|agent-evaluations)(?:\/|$)/.test(route) && !/^\/runs\/[0-9a-f-]+\/team-task$/.test(route)) return false;
    if (request.method !== 'GET' && (request.headers['x-delivery-confirmed'] !== 'yes'
      || ![`http://localhost:${io.port}`, `http://127.0.0.1:${io.port}`].includes(request.headers.origin || ''))) {
      io.json(response, 403, { message: '请从当前工作台明确发起团队操作' }); return true;
    }
    if (route === '/team-tasks/events' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`event: ready\ndata: ${JSON.stringify({ revision: team.revision() })}\n\n`);
      const unsubscribe = team.subscribe(event => { if (!response.destroyed) response.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
      const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
      request.on('close', () => { clearInterval(heartbeat); unsubscribe(); }); return true;
    }
    let value: unknown;
    if (route === '/team-chat' && request.method === 'POST') value = await team.chat(z.object({
      objective: z.string().trim().max(200000), attachmentIds: z.array(z.string().max(100)).max(6).default([]),
      requestId: z.string().min(1).max(120), parentRunId: id.optional(), taskId: id.optional(), workspacePath: z.string().trim().max(2000).optional(),
      accessMode: z.enum(['workspace', 'full']).default('full'),
    }).strict().parse(await io.body(request)));
    else if (route === '/team-tasks' && request.method === 'GET') value = { tasks: team.list() };
    else if (route === '/team-tasks' && request.method === 'POST') value = await team.create('', z.object({ objective: z.string().trim().min(1).max(200000), workspacePath: z.string().min(1).max(2000),
      attachmentIds: z.array(z.string().max(100)).max(6).default([]), requestId, templateId: z.enum(teamTemplateIds).optional() }).strict().parse(await io.body(request)));
    else if (route === '/agent-profiles' && request.method === 'GET') value = { config: team.profiles.read(), instructions: Object.fromEntries(await Promise.all(teamProfileIds.map(async id => [id, await team.profiles.instruction(id)]))) };
    else if (route === '/agent-profiles' && request.method === 'PUT') {
      const current = team.profiles.read();
      const parsed = z.object({ expectedRevision: z.number().int().positive(), profiles: z.array(teamProfileSchema), reviewRouting: z.unknown(), options: z.unknown() }).strict().parse(await io.body(request));
      value = await team.profiles.save({ ...parsed, reviewRouting: parsed.reviewRouting as typeof current.reviewRouting, options: parsed.options as typeof current.options });
    } else if (route === '/agent-usage' && request.method === 'GET') value = { summary: usage.summary({ days: 30 }) };
    else if (route === '/agent-evaluations' && request.method === 'GET') value = { evaluations: governance.evaluations.list().map(item => ({ ...item, metrics: governance.evaluations.metrics(item.id) })) };
    else if (route === '/agent-evaluations' && request.method === 'POST') value = await governance.createEvaluation(z.object({ taskIds: z.array(id).min(1).max(10), profileId: z.enum(['engineer', 'frontend', 'batch', 'reviewer']),
      models: z.tuple([teamModelChoiceSchema, teamModelChoiceSchema]), confirmed: z.literal(true), requestId }).strict().parse(await io.body(request)));
    else {
      const artifact = route.match(/^\/team-tasks\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})$/);
      if (artifact && request.method === 'GET') {
        io.json(response, 200, await team.readArtifact(artifact[1], artifact[2])); return true;
      }
      const start = route.match(/^\/runs\/([0-9a-f-]{36})\/team-task$/), taskRoute = route.match(/^\/team-tasks\/([0-9a-f-]{36})(?:\/(plan|decision|messages|cancel|draft|second-opinion))?$/);
      const resumeEvaluation = route.match(/^\/agent-evaluations\/([0-9a-f-]{36})\/resume$/);
      if (resumeEvaluation && request.method === 'POST') {
        z.object({ confirmedResume: z.literal(true) }).strict().parse(await io.body(request));
        void governance.evaluations.run(resumeEvaluation[1], { confirmedResume: true }).catch(() => {});
        io.json(response, 202, governance.evaluations.get(resumeEvaluation[1])); return true;
      }
      const annotation = route.match(/^\/agent-evaluations\/([0-9a-f-]{36})\/annotate$/);
      if (start && request.method === 'POST') value = await team.create(start[1], z.object({ objective: z.string().trim().min(1).max(200000), attachmentIds: z.array(z.string().max(100)).max(6).default([]),
        requestId, templateId: z.enum(teamTemplateIds).optional() }).strict().parse(await io.body(request)));
      else if (annotation && request.method === 'POST') {
        const input = z.object({ variantId: id, findingId: z.string().min(1).max(100), annotation: z.enum(['true_issue', 'false_positive']), note: z.string().max(6000).default('') }).strict().parse(await io.body(request));
        value = await governance.evaluations.annotate(annotation[1], input.variantId, input.findingId, input.annotation, input.note);
      } else if (taskRoute) {
        const [, taskId, action] = taskRoute;
        if (!action && request.method === 'GET') value = { ...await team.room(taskId, Math.max(0, Number(url.searchParams.get('sinceRevision')) || 0)), opinions: governance.drafts.opinions(taskId) };
        else if (action === 'plan' && request.method === 'POST') value = await team.plan(taskId, planInput.parse(await io.body(request)));
        else if (action === 'decision' && request.method === 'POST') value = await team.decide(taskId, decisionInput.parse(await io.body(request)));
        else if (action === 'cancel' && request.method === 'POST') { const input = z.object({ requestId }).strict().parse(await io.body(request)); value = await team.decide(taskId, { action: 'cancel', ...input }); }
        else if (action === 'messages' && request.method === 'POST') value = await team.answer(taskId, z.object({ correlationId: z.string().min(1).max(100), text: z.string().trim().min(1).max(20000), attachmentIds: z.array(z.string().max(100)).max(6).optional(), accessMode: z.enum(['workspace', 'full']).optional(), requestId }).strict().parse(await io.body(request)));
        else if (action === 'draft') {
          if (request.method === 'GET') value = governance.drafts.get(taskId) || { revision: 0, text: '' };
          else if (request.method === 'POST') { const input = z.object({ requestId: requestId.optional() }).strict().parse(await io.body(request)); value = await governance.drafts.generate(taskId, input.requestId); }
          else if (request.method === 'PUT') { const input = z.object({ expectedRevision: z.number().int().nonnegative(), text: z.string().max(100000) }).strict().parse(await io.body(request)); value = await governance.drafts.save(taskId, input.expectedRevision, input.text); }
        } else if (action === 'second-opinion' && request.method === 'POST') { const input = z.object({ requestId: requestId.optional() }).strict().parse(await io.body(request)); value = await governance.secondOpinion(taskId, input.requestId); }
      }
    }
    if (value === undefined) io.json(response, 405, { message: '请求方法不支持' }); else io.json(response, 200, value);
    return true;
  };
}
