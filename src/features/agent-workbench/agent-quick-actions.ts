/**
 * 设计说明：原页的高频入口在 Agent 页转换为“可审核的会话草稿”，而不是直接复制写操作。
 * 边界是只生成稳定标识和明确意图；不嵌入来源标题或描述，避免把外部内容当成指令。
 */
import type { AgentKnowledgeMatch, AgentKnowledgeScope, AgentSkillOption } from '../../../shared/agent-runtime';
import type { RunView } from '../../../shared/types';
import type { CatchupRequirement, JiraIssue, Job, MergeItem } from '../../../shared/hub';
import type { AgentInterfaceContext } from './agent-business-context';

export function jiraQuickPrompt(issue: Pick<JiraIssue, 'key'>) {
  return `帮我看看 Jira 事项 ${issue.key} 目前做到哪了，还有哪些问题，下一步该做什么。先只查看。`;
}

export function projectWorkspaceReviewDraft(path: string) {
  return `帮我看看这个工作区的情况：\n${path}\n\n请告诉我现在在哪个分支、有没有未提交的改动、和远端分支差了哪些提交，并建议下一步怎么做。先只查看，不要修改文件、提交或合并。`;
}

export function interfaceQuickPrompt(context: Pick<AgentInterfaceContext, 'page'>) {
  return `帮我看看「${context.page.title}」的接口联调进展。哪些接口还没通过，卡在哪里？先只查看。\n\n接口页编号：${context.page.id}`;
}

export function deliveryJobQuickPrompt(job: Pick<Job, 'id' | 'issueKey'>) {
  const reference = job.issueKey ? `Jira 事项 ${job.issueKey}` : `交付任务 ${job.id}`;
  return `帮我看看 ${reference} 目前进展如何，已经有什么结果。如果卡住了，请说明原因，并建议下一步怎么做。先只查看。`;
}

export function catchupQuickPrompt(item: Pick<CatchupRequirement, 'id'>, issueKey = '') {
  const issue = issueKey ? `（Jira ${issueKey}）` : '';
  return `帮我核对追平任务 ${item.id}${issue} 的交付结果，告诉我还缺什么、下一步该做什么。先只查看。`;
}

export function mergeQuickPrompt(item: Pick<MergeItem, 'requirementId'>, issueKey = '') {
  const issue = issueKey ? `（Jira ${issueKey}）` : '';
  return `帮我核对合入任务 ${item.requirementId}${issue} 的测试结果和准备情况，告诉我还有哪些问题。先只查看，未经我明确确认不要执行合入。`;
}

export function knowledgeFileQuickPrompt(path: string) {
  const reference = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  return `${reference}\n请读一下这个文件，看看它能不能帮助回答当前问题。`;
}

export function knowledgeMatchQuickPrompt(match: Pick<AgentKnowledgeMatch, 'path' | 'line'>,
  scope?: Pick<AgentKnowledgeScope, 'branch' | 'headSha'>) {
  const version = scope?.headSha ? `\n检索时的版本：${scope.branch || '未切到分支'}，提交 ${scope.headSha.slice(0, 12)}。`
    : scope?.branch ? `\n检索时的分支：${scope.branch}。` : '';
  return `${knowledgeFileQuickPrompt(match.path)}\n请重点看第 ${match.line} 行附近。${version}`;
}

export function knowledgeSkillQuickPrompt(skill: Pick<AgentSkillOption, 'invocation'>) {
  return `$${skill.invocation}\n请用这个 Skill 帮我处理当前任务。`;
}

export function workflowQuickPrompt(run: Pick<RunView, 'runId' | 'requirement' | 'status'>) {
  return `工作流 ${run.runId}（${run.requirement.id}）当前状态为 ${run.status}。请读取现有运行证据，说明当前阶段、阻塞和下一步；未经我确认不要执行外部写操作。`;
}
