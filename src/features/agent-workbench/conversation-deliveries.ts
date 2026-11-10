import { agentConversationRunRounds, type AgentConversation } from './conversation';
import type { AgentRun } from '../../../shared/agent-runtime';
import type { AdvancedTeamTask } from './team-api';
import { deliveryOutputPaths } from '../../../shared/delivery-report';

/** 群聊重试沿用原发言序号，展示最新有成果的尝试；普通会话保留原轮号和运行身份。 */
export function conversationDeliveries(conversation?: AgentConversation) {
  const rounds = conversation?.runRounds;
  const runRounds = agentConversationRunRounds(conversation);
  const deliveries = (conversation?.runs || []).map(run => ({ run, round: runRounds.get(run.id)! }))
    .filter(({ run }) => !!run.result.trim() || !run.syncedHistory && !!run.changedFiles?.length);
  const current = new Set(deliveries.filter(({ run }) => rounds?.[run.id]?.current).map(item => item.round));
  const seen = new Set<number>();
  return deliveries.reverse().filter(({ run }) => {
    const slot = rounds?.[run.id];
    if (!slot) return true;
    if (seen.has(slot.round) || current.has(slot.round) && !slot.current) return false;
    seen.add(slot.round); return true;
  });
}

/** 文件操作保留产出运行的身份；验证副本和审查记录不作为用户交付文件。 */
export function conversationFileDeliveries(conversation?: AgentConversation, task?: AdvancedTeamTask, teamRuns: AgentRun[] = []) {
  if (!conversation) return [];
  if (task?.parentConversationId !== conversation.id) task = undefined;
  const rounds = agentConversationRunRounds(conversation);
  const history = conversation.runs.map(run => ({ run, round: rounds.get(run.id)!, current: !task && run.id === conversation.latest.id }))
    .filter(({ run }) => !run.team && !run.syncedHistory && !!run.changedFiles?.length);
  if (!task || task.parentConversationId !== conversation.id) return history.reverse();
  const byId = new Map([...conversation.runs, ...teamRuns].map(run => [run.id, run]));
  const team = task.nodes.filter(node => ['implement', 'diagnose', 'architect', 'analyst'].includes(node.stage))
    .flatMap(node => {
      const run = node.runId ? byId.get(node.runId) : undefined;
      return run?.team?.taskId === task.id && run.team.nodeId === node.id && run.changedFiles?.length
        ? [{ run, round: node.round, current: node.round === task.round }] : [];
    });
  return [...history, ...team].reverse();
}

/** 结果区只提供本轮产出岗位已登记的交付文件，下载沿用所属运行的受限接口。 */
export function conversationResultDownloads(conversation?: AgentConversation, task?: AdvancedTeamTask, teamRuns: AgentRun[] = []) {
  const seen = new Set<string>();
  return conversationFileDeliveries(conversation, task, teamRuns).filter(item => item.current).flatMap(({ run }) => {
    const absolute = (file: string) => file.startsWith('/') ? file : `${run.workspacePath.replace(/\/$/, '')}/${file.replace(/^\.\//, '')}`;
    const declared = new Set(deliveryOutputPaths(run.result).map(absolute));
    return (run.changedFiles || []).filter(file => file.status !== 'deleted'
      && (declared.size ? declared.has(absolute(file.path)) : file.status === 'generated')).flatMap(file => {
      const key = absolute(file.path);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, name: file.path.split('/').at(-1)!,
        url: `/api/agent-runtimes/runs/${encodeURIComponent(run.id)}/download-file?path=${encodeURIComponent(file.path)}` }];
    });
  });
}
