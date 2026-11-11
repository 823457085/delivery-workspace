/**
 * 设计说明：Delivery 必须在单一 Node 进程内拥有 Jira、自动化、追平和合入状态，
 * 不再通过 5188 HTTP 服务获取。这一层只负责加载本地凭据、启停调度器与将既有
 * IncomingMessage 交给内嵌处理器；业务契约仍由 jira-backend 模块维护，避免迁移时重写状态机。
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutomationData, CatchupData, IssueResponse, JiraDevScanPreview, JiraIssue, PlanItem, ProjectsData } from '../shared/hub.js';
import { managedPluginCredential } from './plugins/store.mjs';

type PrepareJiraDevPreviews = (plan: PlanItem[], limit: number, mode?: 'preview' | 'start', mayStart?: () => Promise<boolean>) => Promise<JiraDevScanPreview[]>;

interface JiraBackendModule {
  connectJiraDevPreviews(handler: PrepareJiraDevPreviews): void;
  handleJiraTaskCalendarRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  startAutomationScheduler(): void;
  stopAutomationScheduler(): void;
  holdAutomationForRestart(): () => void;
  automationIdleForRestart(): boolean;
  getCatchupMergeDashboard(refresh?: boolean): Promise<unknown>;
  getAutomationDashboard(): Promise<AutomationData>;
  readWorkspaceReportIssues(): Promise<IssueResponse>;
  getCatchupDashboard(): Promise<CatchupData>;
  readJiraFixIssue(reference: string): Promise<JiraIssue>;
  jiraFixHandoffRequest(key: string, suffix: string, method?: string, body?: unknown): Promise<unknown>;
  jiraIssueRequest(resource: string, method?: string, body?: unknown): Promise<Response>;
  confluenceReadRequest(resource: string): Promise<Response>;
  confluencePublishRequest?(resource: string, method: 'POST' | 'PUT', body: unknown): Promise<Response>;
  getLocalProjects(refresh?: boolean): Promise<ProjectsData>;
}

function loadCredentialEnvironment(filename: string) {
  let values: ReturnType<typeof parseEnv>;
  try { values = parseEnv(readFileSync(filename, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Plugin bootstrap removes credentials for the previous site before starting the server.
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && process.env[key] === undefined && !managedPluginCredential(key)) process.env[key] = value;
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
  readAutomation(): Promise<AutomationData>;
  readIssues(): Promise<IssueResponse>;
  readCatchup(): Promise<CatchupData>;
  readJiraFixIssue(reference: string): Promise<JiraIssue>;
  jiraFixHandoffRequest(key: string, suffix: string, method?: string, body?: unknown): Promise<unknown>;
  jiraIssueRequest(resource: string, method?: string, body?: unknown): Promise<Response>;
  confluenceReadRequest(resource: string): Promise<Response>;
  confluencePublishRequest?(resource: string, method: 'POST' | 'PUT', body: unknown): Promise<Response>;
  readLocalProjects(refresh?: boolean): Promise<ProjectsData>;
  connectJiraDevPreviews(handler: PrepareJiraDevPreviews): void;
  start(): void;
  close(): void;
  holdForRestart(): () => void;
  isIdle(): boolean;
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
    readAutomation: () => backend.getAutomationDashboard(),
    readIssues: () => backend.readWorkspaceReportIssues(),
    readCatchup: () => backend.getCatchupDashboard(),
    readJiraFixIssue: reference => backend.readJiraFixIssue(reference),
    jiraFixHandoffRequest: (key, suffix, method, body) => backend.jiraFixHandoffRequest(key, suffix, method, body),
    jiraIssueRequest: (resource, method, body) => backend.jiraIssueRequest(resource, method, body),
    confluenceReadRequest: resource => backend.confluenceReadRequest(resource),
    confluencePublishRequest: (resource, method, body) => {
      if (!backend.confluencePublishRequest) throw new Error('当前 Confluence 连接不支持方案发布');
      return backend.confluencePublishRequest(resource, method, body);
    },
    readLocalProjects: (refresh = false) => backend.getLocalProjects(refresh),
    connectJiraDevPreviews: handler => backend.connectJiraDevPreviews(handler),
    start: () => backend.startAutomationScheduler(),
    close: () => backend.stopAutomationScheduler(),
    holdForRestart: () => backend.holdAutomationForRestart(),
    isIdle: () => backend.automationIdleForRestart(),
  };
}
