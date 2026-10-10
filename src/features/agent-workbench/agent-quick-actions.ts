/**
 * 设计说明：原页的高频入口在 Agent 页转换为“可审核的会话草稿”，而不是直接复制写操作。
 * 边界是只生成稳定标识和明确意图；不嵌入来源标题或描述，避免把外部内容当成指令。
 */
import type { AgentKnowledgeMatch, AgentKnowledgeScope, AgentSkillOption } from '../../../shared/agent-runtime';
import type { RunView } from '../../../shared/types';
import type { CatchupRequirement, JiraIssue, Job, LocalProject, MergeItem } from '../../../shared/hub';
import type { AgentInterfaceContext } from './agent-business-context';

export function jiraQuickPrompt(issue: Pick<JiraIssue, 'key'>) {
  return `@Jira:${issue.key} 请检查该需求的当前实现范围、风险和下一步，先只读分析。`;
}

export function projectQuickPrompt(project: Pick<LocalProject, 'projectId'>) {
  return `@项目:${project.projectId} 请检查当前分支、工作区变更和远端差异，给出下一步，先只读分析。`;
}

export function interfaceQuickPrompt(context: Pick<AgentInterfaceContext, 'page'>) {
  return `@接口:${context.page.id} 请检查该页面的接口联调进度、未通过项和阻塞原因，先只读分析。`;
}

export function deliveryJobQuickPrompt(job: Pick<Job, 'id' | 'issueKey'>) {
  const reference = job.issueKey ? `@Jira:${job.issueKey}` : `交付任务 ${job.id}`;
  return `${reference} 请检查该交付任务的当前状态、失败原因和下一步，先只读分析。`;
}

export function catchupQuickPrompt(item: Pick<CatchupRequirement, 'id'>) {
  return `@合入:${item.id} 请检查该追平任务的当前进度、阻塞和下一步，先只读分析。`;
}

export function mergeQuickPrompt(item: Pick<MergeItem, 'requirementId'>) {
  return `@合入:${item.requirementId} 请审核该分支的合入证据、阻塞原因和下一步；未经我明确确认不要执行合入。`;
}

export function knowledgeFileQuickPrompt(path: string) {
  const reference = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  return `${reference} 请读取这个文件，并结合当前问题给出结论。`;
}

export function knowledgeMatchQuickPrompt(match: Pick<AgentKnowledgeMatch, 'path' | 'line'>,
  scope?: Pick<AgentKnowledgeScope, 'branch' | 'headSha'>) {
  const version = scope?.headSha ? ` 检索版本：${scope.branch || 'detached HEAD'}@${scope.headSha.slice(0, 12)}。`
    : scope?.branch ? ` 检索分支：${scope.branch}。` : '';
  return `${knowledgeFileQuickPrompt(match.path)} 重点查看第 ${match.line} 行附近的内容。${version}`;
}

export function knowledgeSkillQuickPrompt(skill: Pick<AgentSkillOption, 'invocation'>) {
  return `$${skill.invocation} 请按这个 Skill 处理当前任务。`;
}

export function workflowQuickPrompt(run: Pick<RunView, 'runId' | 'requirement' | 'status'>) {
  return `工作流 ${run.runId}（${run.requirement.id}）当前状态为 ${run.status}。请读取现有运行证据，说明当前阶段、阻塞和下一步；未经我确认不要执行外部写操作。`;
}
