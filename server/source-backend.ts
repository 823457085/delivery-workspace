/**
 * 设计说明：Delivery 必须在单一 Node 进程内拥有 Jira、自动化、追平和合入状态，
 * 不再通过 5188 HTTP 服务获取。这一层只负责加载本地凭据、启停调度器与将既有
 * IncomingMessage 交给内嵌处理器；业务契约仍由 jira-backend 模块维护，避免迁移时重写状态机。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JiraIssue, ProjectsData } from '../shared/hub.js';

interface JiraBackendModule {
  handleJiraTaskCalendarRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  startAutomationScheduler(): void;
  stopAutomationScheduler(): void;
  getCatchupMergeDashboard(refresh?: boolean): Promise<unknown>;
  readJiraFixIssue(reference: string): Promise<JiraIssue>;
  jiraFixHandoffRequest(key: string, suffix: string, method?: string, body?: unknown): Promise<unknown>;
  getLocalProjects(refresh?: boolean): Promise<ProjectsData>;
}

function loadCredentialEnvironment(filename: string) {
  try { process.loadEnvFile(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export function initializeSourceEnvironment(port: number, repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  process.env.DELIVERY_PORT = String(port);
  const credentials = process.env.DELIVERY_CREDENTIALS_FILE || path.join(repositoryRoot, '.env');
  loadCredentialEnvironment(credentials);
  process.env.DELIVERY_SOURCE_DATA_DIR ||= path.join(process.env.DELIVERY_DATA_DIR || path.join(repositoryRoot, '.data'), 'source');
  return { credentials, dataDirectory: process.env.DELIVERY_SOURCE_DATA_DIR };
}

export interface SourceBackend {
  handles(pathname: string): boolean;
  dispatch(request: IncomingMessage, response: ServerResponse, target: string): Promise<void>;
  readMergePlan(refresh?: boolean): Promise<unknown>;
  readJiraFixIssue(reference: string): Promise<JiraIssue>;
  jiraFixHandoffRequest(key: string, suffix: string, method?: string, body?: unknown): Promise<unknown>;
  readLocalProjects(): Promise<ProjectsData>;
  start(): void;
  close(): void;
}

export async function createSourceBackend(port: number): Promise<SourceBackend> {
  initializeSourceEnvironment(port);

  const specifier = new URL('./jira-backend/server.mjs', import.meta.url).href;
  const backend = await import(specifier) as JiraBackendModule;
  const prefixes = ['/api/automation', '/api/local-projects', '/api/meeting/'];
  const exact = new Set(['/api/config', '/api/issues', '/api/users', '/meeting-snapshot.json']);

  return {
    handles: (pathname) => exact.has(pathname) || prefixes.some((prefix) => pathname.startsWith(prefix)),
    dispatch: async (request, response, target) => {
      const originalUrl = request.url;
      request.url = target;
      response.setHeader('X-Delivery-Source', 'Delivery-Unified');
      try { await backend.handleJiraTaskCalendarRequest(request, response); }
      finally { request.url = originalUrl; }
    },
    readMergePlan: (refresh = false) => backend.getCatchupMergeDashboard(refresh),
    readJiraFixIssue: reference => backend.readJiraFixIssue(reference),
    jiraFixHandoffRequest: (key, suffix, method, body) => backend.jiraFixHandoffRequest(key, suffix, method, body),
    readLocalProjects: () => backend.getLocalProjects(false),
    start: () => backend.startAutomationScheduler(),
    close: () => backend.stopAutomationScheduler(),
  };
}
