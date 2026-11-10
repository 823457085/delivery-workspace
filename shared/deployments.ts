/** 工作台部署只调用已关联的 Jenkins 任务；排队与构建使用本次触发返回的标识。 */
export type DeploymentStatus = 'dispatching' | 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';
export interface JenkinsConnection { baseUrl: string; username: string; hasToken: boolean }
export interface DeploymentProject { id: string; name: string; repository: string; paths: string[]; branches: string[] }
export interface DeploymentBinding { id: string; projectId: string; environment: string; jobFullName: string }
export interface JenkinsParameter { name: string; description: string; type: 'string' | 'boolean' | 'choice' | 'password' | 'unsupported'; defaultValue?: string | boolean; choices?: string[] }
export interface JenkinsJob { fullName: string; name: string; url: string; buildable: boolean; parameters: JenkinsParameter[] }
export interface DeploymentRun {
  id: string; requestId: string; bindingId: string; projectId: string; projectName: string; environment: string;
  jobFullName: string; status: DeploymentStatus; createdAt: string; updatedAt: string;
  queueId?: number; buildNumber?: number; buildUrl?: string; result?: string; error?: string;
  provider?: 'yunxiao'; organizationId?: string; pipelineId?: string; pipelineRunId?: string;
  steps?: { name: string; status: string; jobId?: string }[];
}
export interface DeploymentDashboard { config: JenkinsConnection; projects: DeploymentProject[]; bindings: DeploymentBinding[]; runs: DeploymentRun[]; yunxiao?: { hasToken: boolean } }
export interface YunxiaoPipeline { name: string; sources: { repo: string; branch: string }[] }
export interface DeploymentLog { text: string; nextOffset: number; moreData: boolean }
export interface DeploymentStart { bindingId: string; requestId: string; parameters: Record<string, string | boolean>; acknowledgeUnknown?: boolean }
