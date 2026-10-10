/** 只映射本机演示流程的合法下一步，不把运行状态扩展为 Git 或 Jira 写操作。 */
import type { RunView } from '../../../shared/types';

export type AgentWorkflowRunAction =
  | { kind: 'resume'; value: 'approve' | 'retest'; label: string }
  | { kind: 'rework'; label: string };

export function agentWorkflowRunAction(run: Pick<RunView, 'status' | 'gate'>): AgentWorkflowRunAction | null {
  if (run.status !== 'suspended' || !run.gate) return null;
  if (run.gate.kind === 'review') return { kind: 'resume', value: 'approve', label: '批准继续' };
  if (run.gate.kind === 'evidence') return { kind: 'resume', value: 'retest', label: '补测继续' };
  if (run.gate.kind === 'conflict') return { kind: 'rework', label: '重新预演' };
  return null;
}
