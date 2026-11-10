import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { createAgentGroupChat } from './agent-group-chat.js';
import { groupMemberSchema, groupSendSchema, groupReviseSchema, groupActionSchema, groupSteerSchema } from '../shared/agent-group-chat.js';
export function createAgentGroupChatRoutes(service: Awaited<ReturnType<typeof createAgentGroupChat>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void; body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}, delivery?: { preview(id: string): Promise<unknown>; submit(id: string, raw: unknown): Promise<unknown>;
  downloadArtifact?(id: string, artifactId: string, sha256: string): Promise<{ name: string; data: Buffer }> }) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const route = url.pathname.slice('/api/agent-runtimes/group-chat'.length);
    if (!url.pathname.startsWith('/api/agent-runtimes/group-chat') || route && !route.startsWith('/')) return false;
    if (request.method !== 'GET' && (request.headers['x-delivery-confirmed'] !== 'yes'
      || ![`http://localhost:${io.port}`, `http://127.0.0.1:${io.port}`].includes(request.headers.origin || ''))) {
      io.json(response, 403, { message: '请从当前工作台发起团队群聊操作' }); return true;
    }
    let result: unknown;
    if (!route && request.method === 'GET') result = service.dashboard();
    else if (route === '/config' && request.method === 'PUT') result = await service.saveConfig(z.object({
      expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(100), members: z.array(groupMemberSchema),
    }).strict().parse(await io.body(request)));
    else if (route === '/template' && request.method === 'GET') result = service.template();
    else if (route === '/import' && request.method === 'POST') {
      const input = z.object({ expectedRevision: z.number().int().positive(), template: z.unknown() }).strict().parse(await io.body(request));
      result = await service.importTemplate(input.template, input.expectedRevision);
    } else if (route === '/messages' && request.method === 'POST') result = await service.send(groupSendSchema.parse(await io.body(request)));
    else {
      const steer = /^\/rooms\/([0-9a-f-]{36})\/messages\/steer$/.exec(route);
      if (steer && request.method === 'POST') {
        result = await service.steerMessage(steer[1], groupSteerSchema.parse(await io.body(request)));
        io.json(response, 200, result); return true;
      }
      const message = /^\/rooms\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/(pause-edit|revise)$/.exec(route);
      if (message && request.method === 'POST') {
        if (message[3] === 'revise') result = await service.reviseMessage(message[1], message[2], groupReviseSchema.parse(await io.body(request)));
        else { z.object({}).strict().parse(await io.body(request)); result = await service.pauseMessage(message[1], message[2]); }
        io.json(response, 200, result); return true;
      }
      const artifact = /^\/rooms\/([0-9a-f-]{36})\/artifacts\/(i18n-(?:0|[1-9]\d*)|review-0)$/.exec(route);
      if (artifact && delivery?.downloadArtifact && request.method === 'GET') {
        const input = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(Object.fromEntries(url.searchParams));
        const file = await delivery.downloadArtifact(artifact[1], artifact[2], input.sha256);
        response.writeHead(200, { 'Content-Type': artifact[2] === 'review-0' ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Length': file.data.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(file.data); return true;
      }
      const room = /^\/rooms\/([0-9a-f-]{36})(?:\/(action|trust|retry|fallback|delivery|resume-login|delete|title))?$/.exec(route);
      if (room && !room[2] && request.method === 'GET') result = service.detail(room[1]);
      else if (room?.[2] === 'title' && request.method === 'POST') result = await service.rename(room[1], z.object({ title: z.string().trim().min(1).max(300), expectedTitle: z.string().max(300) }).strict().parse(await io.body(request)));
      else if (room?.[2] === 'delete' && request.method === 'POST') { z.object({}).strict().parse(await io.body(request)); result = await service.remove(room[1]); }
      else if (room?.[2] === 'delivery' && delivery && request.method === 'GET') result = await delivery.preview(room[1]);
      else if (room?.[2] === 'delivery' && delivery && request.method === 'POST') result = await delivery.submit(room[1], await io.body(request));
      else if (room?.[2] === 'trust' && request.method === 'POST') result = await service.trustAndContinue(room[1], z.object({ turnId: z.string().uuid(), runId: z.string().uuid(), workspacePath: z.string().min(1).max(2000), accessMode: z.enum(['workspace', 'full']).optional() }).strict().parse(await io.body(request)));
      else if (room?.[2] === 'retry' && request.method === 'POST') result = await service.retryAndContinue(room[1], z.object({ turnId: z.string().uuid(), runId: z.string().uuid(), accessMode: z.enum(['workspace', 'full']).optional() }).strict().parse(await io.body(request)));
      else if (room?.[2] === 'fallback' && request.method === 'POST') result = await service.fallbackAndContinue(room[1], z.object({ turnId: z.string().uuid(), runId: z.string().uuid(), accessMode: z.enum(['workspace', 'full']).optional() }).strict().parse(await io.body(request)));
      else if (room?.[2] === 'resume-login' && request.method === 'POST') {
        const input = z.object({ roundId: z.uuid(), runId: z.uuid(), accessMode: z.enum(['workspace', 'full']).optional() }).strict().parse(await io.body(request));
        result = await service.resumeLogin(room[1], input);
      }
      else if (room?.[2] === 'action' && request.method === 'POST') {
        const input = groupActionSchema.parse(await io.body(request));
        result = await service.action(room[1], input.action, input.action === 'rerun' ? { requestId: input.requestId, roundId: input.roundId, ...(input.accessMode ? { accessMode: input.accessMode } : {}) }
          : input.action === 'continue' && input.accessMode ? { accessMode: input.accessMode } : undefined);
      }
    }
    if (result === undefined) io.json(response, 405, { message: '请求方法不支持' }); else io.json(response, 200, result);
    return true;
  };
}
