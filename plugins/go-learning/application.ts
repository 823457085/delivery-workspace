import { createGoLearningService, stopGoLearningProcesses } from './service.js';
import { goHttpDebugSchema, goProgressUpdateSchema, goSandboxInitSchema, goSandboxRunSchema, goSandboxSaveFileSchema } from './types.js';
export async function createPlugin(host: { dataDirectory: string; workspaceDirectory: string }) {
  const service = await createGoLearningService(host.dataDirectory, { rootDir: host.workspaceDirectory });
  async function sandboxResult(result?: unknown) {
    const sandbox = await service.readSandboxFiles();
    return { ...(result === undefined ? {} : { result }), sandboxFiles: sandbox.files, tasksJsonContent: sandbox.tasksJsonContent };
  }
  return {
    async close() { stopGoLearningProcesses(); await service.close(); },
    async request(method: string, raw: unknown) {
      if (method === 'overview' || method === 'day') {
        const value = (raw as {day?: unknown})?.day;
        const day = value === undefined ? undefined : Number(value);
        if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 7)) throw new Error('请选择第 1～7 天');
        return method === 'overview' ? service.overview(day) : service.getDay(day || 1);
      }
      if (method === 'progress') return { progress: await service.updateProgress(goProgressUpdateSchema.parse(raw)) };
      if (method === 'sandbox/init') {
        const input = goSandboxInitSchema.parse(raw); await service.applySnapshot(input.snapshot);
        return { ...await sandboxResult(), activeSnapshot: input.snapshot, progress: (await service.overview()).progress };
      }
      if (method === 'sandbox/save-file') {
        const input = goSandboxSaveFileSchema.parse(raw);
        await service.saveSandboxFile(input.filePath, input.content); return sandboxResult();
      }
      if (method === 'sandbox/run') {
        const input = goSandboxRunSchema.parse(raw);
        return sandboxResult(await service.runCommand(input.action, input.args || []));
      }
      if (method === 'sandbox/http-debug') return sandboxResult(await service.debugHttpEndpoint(goHttpDebugSchema.parse(raw)));
      throw new Error('Go 实训操作不存在');
    },
  };
}
