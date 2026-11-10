/** 在同一对话切换执行器；历史交接由服务端处理，不能跨 CLI 复用原生 sessionId。 */
import type { AgentAccessMode, AgentProvider, AgentReasoningEffort, AgentRunMode, AgentServiceTier, StartAgentRunInput } from '../../../shared/agent-runtime';
import { agentConversationContinuation, type AgentConversation } from './conversation';

export function providerSwitchInput(conversation: AgentConversation, objective: string, selection: {
  provider: AgentProvider; mode?: AgentRunMode; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode; serviceTier?: AgentServiceTier;
}): StartAgentRunInput {
  const source = agentConversationContinuation(conversation);
  const mode = selection.mode ?? (conversation.source === 'codex' ? 'agent' : source.mode);
  return {
    continueConversationId: conversation.id,
    provider: selection.provider, mode, model: selection.model,
    ...(selection.provider === 'codex' ? { serviceTier: selection.serviceTier } : {}),
    reasoningEffort: selection.provider !== 'cursor' ? selection.reasoningEffort : '',
    accessMode: mode === 'agent' ? selection.accessMode : 'workspace',
    workspacePath: source.continuation?.workspacePath || source.workspacePath,
    objective,
  };
}
