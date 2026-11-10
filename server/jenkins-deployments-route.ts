import type http from 'node:http';
import { z } from 'zod';
import type { createJenkinsDeployments } from './jenkins-deployments.js';
import type { createYunxiaoDeployments } from './yunxiao-deployments.js';

type Service = Pick<Awaited<ReturnType<typeof createJenkinsDeployments>>, 'snapshot' | 'saveConfig' | 'checkConnection' | 'jobs'
  | 'saveBinding' | 'saveManualBinding' | 'deleteBinding' | 'startRun' | 'getRun' | 'log'>;
export function createJenkinsDeploymentsRoute(service: Service, yunxiao?: Awaited<ReturnType<typeof createYunxiaoDeployments>>) {
  return async (request: http.IncomingMessage, response: http.ServerResponse, port: number) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
        || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) {
        send(403, { message: '仅接受本机工作台请求' }); return;
      }
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) { send(403, { message: '请求来源不匹配' }); return; }
      const url = new URL(request.url || '/', origin);
      if (url.pathname !== '/api/deployments' && !url.pathname.startsWith('/api/deployments/')) {
        send(404, { message: '部署接口不存在' }); return;
      }
      if (request.method === 'GET') {
        if (url.pathname === '/api/deployments') {
          const [dashboard, cloud] = await Promise.all([service.snapshot(), yunxiao?.snapshot()]);
          send(200, cloud ? { ...dashboard, yunxiao: cloud.config, runs: [...dashboard.runs, ...cloud.runs] } : dashboard); return;
        }
        if (url.pathname === '/api/deployments/jobs') { send(200, await service.jobs()); return; }
        if (url.pathname === '/api/deployments/links') { send(200, yunxiao ? await yunxiao.links() : []); return; }
        const cloudRun = url.pathname.match(/^\/api\/deployments\/yunxiao\/runs\/([a-f0-9-]{36})(\/log)?$/i);
        if (cloudRun && yunxiao) {
          const id = z.uuid().parse(cloudRun[1]);
          if (!cloudRun[2]) { send(200, await yunxiao.getRun(id)); return; }
          const jobId = url.searchParams.get('jobId') || '', offset = url.searchParams.get('start') || '0';
          if (!/^[1-9]\d*$/.test(jobId) || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
            send(400, { message: '日志任务编号或偏移不正确' }); return;
          }
          send(200, await yunxiao.log(id, jobId, Number(offset))); return;
        }
        const run = url.pathname.match(/^\/api\/deployments\/runs\/([a-f0-9-]{36})(\/log)?$/i);
        if (run) {
          const id = z.uuid().parse(run[1]);
          if (!run[2]) { send(200, await service.getRun(id)); return; }
          const offset = url.searchParams.get('start') || '0';
          if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) { send(400, { message: '日志偏移必须为非负整数' }); return; }
          send(200, await service.log(id, Number(offset))); return;
        }
        send(404, { message: '部署接口不存在' }); return;
      }
      if (request.method !== 'POST') { send(405, { message: '请求方法不支持' }); return; }
      if (request.headers.origin !== origin || request.headers['x-delivery-confirmed'] !== 'yes') {
        send(403, { message: '请在当前工作台确认部署操作' }); return;
      }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        send(415, { message: '请发送 JSON' }); return;
      }
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 100_000) { send(413, { message: '请求内容过大' }); return; } }
      const input: unknown = JSON.parse(raw || '{}');
      if (url.pathname === '/api/deployments/bindings/manual') {
        const data = z.object({ projectId: z.string().min(1).max(2000), environment: z.string().trim().min(1).max(100),
          url: z.string().trim().min(1).max(2000) }).strict().parse(input);
        let address: URL;
        try { address = new URL(data.url); } catch { throw new Error('请输入完整的流水线地址'); }
        if (address.origin === 'https://flow.aliyun.com') {
          if (!yunxiao) throw new Error('云效部署服务尚未启用');
          const project = (await service.snapshot()).projects.find(item => item.id === data.projectId);
          send(200, { provider: 'yunxiao', binding: await yunxiao.saveManualBinding(data, project) }); return;
        }
        send(200, { provider: 'jenkins', binding: await service.saveManualBinding(data) }); return;
      }
      if (yunxiao && url.pathname === '/api/deployments/yunxiao/config') { send(200, await yunxiao.saveConfig(input)); return; }
      if (yunxiao && url.pathname === '/api/deployments/yunxiao/prepare') { send(200, await yunxiao.prepare(input)); return; }
      if (yunxiao && url.pathname === '/api/deployments/yunxiao/runs') { send(202, await yunxiao.startRun(input)); return; }
      if (url.pathname === '/api/deployments/config') { send(200, await service.saveConfig(input)); return; }
      if (url.pathname === '/api/deployments/connection/check') {
        z.object({}).strict().parse(input); send(200, await service.checkConnection()); return;
      }
      if (url.pathname === '/api/deployments/bindings') { send(200, await service.saveBinding(input)); return; }
      if (url.pathname === '/api/deployments/bindings/delete') { send(200, await service.deleteBinding(input)); return; }
      if (url.pathname === '/api/deployments/runs') { send(202, await service.startRun(input)); return; }
      send(404, { message: '部署接口不存在' });
    } catch (error) {
      send(400, { message: error instanceof z.ZodError || error instanceof SyntaxError ? '输入格式不正确'
        : error instanceof Error ? error.message : '部署请求未完成' });
    }
  };
}
