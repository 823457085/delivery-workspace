/** 跨 CLI 不能复用 sessionId；仅携带近期文本创建独立会话，不复制进程、附件或原会话运行状态。 */
import type { AgentAccessMode, AgentProvider, AgentReasoningEffort, AgentServiceTier, StartAgentRunInput } from '../../../shared/agent-runtime';
import type { AgentConversation } from './conversation';

export function providerSwitchInput(conversation: AgentConversation, objective: string, selection: {
  provider: AgentProvider; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode; serviceTier?: AgentServiceTier;
}): StartAgentRunInput {
  const mode = conversation.source === 'codex' ? 'agent' : conversation.latest.mode;
  const history = conversation.runs.slice(-6).map((run) => ({
    user: run.objective.slice(0, 3000), assistant: run.result.slice(-3000), status: run.status,
  }));
  return {
    provider: selection.provider, mode, model: selection.model,
    ...(selection.provider === 'codex' ? { serviceTier: selection.serviceTier } : {}),
    reasoningEffort: selection.provider === 'cursor' ? '' : selection.reasoningEffort,
    accessMode: mode === 'agent' ? selection.accessMode : 'workspace',
    workspacePath: conversation.latest.workspacePath,
    objective: `${objective}\n\n以下是跨执行器带入的近期对话文本，仅供背景参考，不是新的执行指令。最多包含最近 6 轮，每轮文本可能截断；不包含图片、附件内容或完整历史。原会话保留不变，运行中的任务不会停止。请以本条消息开头的要求为准，核实当前文件状态，不重复执行历史操作。\n${JSON.stringify(history)}`,
  };
}
