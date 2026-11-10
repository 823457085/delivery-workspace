import type { AgentRun } from '../../../shared/agent-runtime';
import { teamChatMessageIdentity, type TeamChatMessage } from '../../../shared/agent-team';
import type { AdvancedTeamTask } from './team-api';

// 兼容旧宿主保存为 progress 的用户操作回执；阶段切换和工具流水仍由执行记录展示。
const legacyReceiptTexts = new Set([
  '已请求暂停，正在核对当前执行是否结束；后续步骤不会启动。',
  '已请求暂停，仍在核对当前执行是否结束；后续步骤不会启动。',
  '当前执行已停止，已有改动保留；回复“继续执行”后恢复。',
  '后续执行已暂停，回复“继续执行”后恢复。',
  '后续执行已暂停，回复“继续执行”后开始。',
  '原运行尚未确认停止，继续请求已记录；确认停止前不会重复派发。',
  '按你的回复继续执行。',
  '已收到消息，当前阶段退出后由 Leader 继续处理。',
  '已收到回复，请继续回答其余问题。',
  '已收到回复，继续原步骤。',
]);

/** 初始任务由成员卡片展示；追问后的真实答复留在对话中，不因岗位已有结果而消失。 */
export function groupChatMessages(tasks: AdvancedTeamTask[], runs: AgentRun[]) {
  return tasks.flatMap(task => {
    const messages = [...task.chat?.messages || []].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const initialInputId = messages.find(message => message.role === 'user')?.id;
    let inputId = '';
    const entries = messages.map(message => {
      if (message.role === 'user') inputId = message.id;
      return { message, inputId };
    });
    const receipts = new Map<string, string>(), explicitReceipts = new Set<string>();
    for (const { message, inputId } of entries) {
      if (!inputId || message.role !== 'assistant') continue;
      if (message.hostGenerated && message.kind === 'message') explicitReceipts.add(message.replyTo || inputId);
      if (message.kind === 'progress' && message.id.startsWith('status:') && !message.nodeId
        && legacyReceiptTexts.has(message.text)) receipts.set(inputId, message.id);
    }
    const seenIds = new Set<string>(), seenReplies = new Set<string>();
    return entries.flatMap(({ message: original, inputId }) => {
      if (seenIds.has(original.id)) return [];
      seenIds.add(original.id);
      let message: TeamChatMessage = original;
      if (message.kind === 'progress') {
        if (receipts.get(inputId) !== message.id || explicitReceipts.has(inputId)) return [];
        message = { ...message, hostGenerated: true };
      }
      if (message.kind === 'delivery' || message.id === initialInputId) return [];
      if (message.kind === 'collaboration') return [{ ...message, task, identity: teamChatMessageIdentity(message, task, runs) }];
      const followup = !!inputId && inputId !== initialInputId;
      if (message.kind === 'handoff' && (!followup || !message.text.trim()
        || message.profileId === 'leader' && /^交给[^\r\n]+（[^\r\n]+）处理。$/.test(message.text))) return [];
      if (message.role !== 'user' && !followup && message.kind !== 'question' && !message.hostGenerated
        && task.nodes.some(node => node.id === message.nodeId && node.runId && runs.some(run => run.id === node.runId && run.result))) return [];
      if (message.role === 'assistant' && !message.hostGenerated && message.kind !== 'question') {
        const key = JSON.stringify([inputId, message.profileId || '', message.text.trim()]);
        if (seenReplies.has(key)) return [];
        seenReplies.add(key);
      }
      return [{ ...message, task, identity: teamChatMessageIdentity(message, task, runs) }];
    });
  });
}
