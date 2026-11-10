/**
 * 设计说明：会话导出只投影用户消息、Agent 结果和必要的执行上下文，不包含 PID、
 * 工具诊断等本机运行细节。生成纯内容与浏览器下载分开，便于测试且避免组件持有文件逻辑。
 */
import { agentConversationRunRounds, type AgentConversation } from './conversation';
import { agentProviderLabels, isAgentImageAttachment } from '../../../shared/agent-runtime';
import type { GroupRoomDetail } from '../../../shared/agent-group-chat';
import { groupChatMessages } from './group-chat-messages';
import { groupTaskMessage } from './message-text';

function safeFilename(value: string) {
  return value.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'agent-conversation';
}

export function conversationMarkdown(conversation: AgentConversation) {
  const lines = [
    `# ${conversation.title}`,
    '',
    `> 执行器：${agentProviderLabels[conversation.latest.provider]}`,
    `> 工作区：${conversation.latest.workspacePath}`,
    `> 分支：${conversation.latest.branch || '未识别'}`,
    `> 导出时间：${new Date().toLocaleString()}`,
    '',
  ];
  const rounds = agentConversationRunRounds(conversation);
  conversation.runs.forEach(run => {
    const round = rounds.get(run.id)!;
    lines.push(`## 第 ${round} 轮 · 用户`, '', run.objective, '');
    if (run.attachments?.length) lines.push(...run.attachments.map((attachment) => `- ${isAgentImageAttachment(attachment) ? '图片' : '文件'}：${attachment.name}（${attachment.mimeType}，${attachment.size} bytes）`), '');
    for (const supplement of run.supplements || []) {
      lines.push('### 用户补充', '', supplement.objective, '', ...supplement.attachments.map(item => `- ${isAgentImageAttachment(item) ? '图片' : '文件'}：${item.name}`), '');
    }
    lines.push(`## 第 ${round} 轮 · ${agentProviderLabels[run.provider].replace(/ CLI$/, '')}`, '',
      run.result || run.error || '本轮没有保存最终回复', '', '---', '');
  });
  return lines.join('\n');
}

export function conversationJson(conversation: AgentConversation) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    id: conversation.id,
    title: conversation.title,
    source: conversation.source,
    workspacePath: conversation.latest.workspacePath,
    branch: conversation.latest.branch,
    turns: conversation.runs.map((run) => ({
      id: run.id,
      provider: run.provider,
      mode: run.mode,
      accessMode: run.accessMode,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      status: run.status,
      user: run.objective,
      attachments: run.attachments || [],
      supplements: (run.supplements || []).map(({ id, objective, attachments, createdAt }) => ({ id, objective, attachments, createdAt })),
      assistant: run.result,
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })),
  }, null, 2);
}

export function groupConversationExport(detail: GroupRoomDetail, format: 'markdown' | 'json') {
  const { room, runs, collaboration, collaborations } = detail;
  const tasks = (collaborations || (collaboration ? [collaboration] : [])).map(item => item.task);
  const runsById = new Map(runs.map(run => [run.id, run]));
  const attachmentsById = new Map(runs.flatMap(run => run.attachments || []).map(file => [file.id, file]));
  const attachments = (ids: string[] = []) => ids.map(id => {
    const file = attachmentsById.get(id);
    return file ? { id, name: file.name, mimeType: file.mimeType, size: file.size } : { id, name: '附件' };
  });
  const followups = groupChatMessages(tasks, runs);
  const exported = {
    exportedAt: new Date().toISOString(), id: room.id, title: room.title,
    workspaces: room.workspacePaths?.length ? room.workspacePaths : room.workspacePath ? [room.workspacePath] : [],
    rounds: room.rounds.map(round => {
      const task = tasks.find(item => item.id === round.automatic?.taskId);
      const delivery = task && ['completed', 'awaiting_acceptance', 'accepted'].includes(task.state)
        ? task.chat?.messages.filter(message => message.kind === 'delivery' && message.id.startsWith(`delivery:${task.id}:${task.round}:`)).at(-1)?.text : undefined;
      return {
        id: round.id, state: round.state, createdAt: round.createdAt, user: groupTaskMessage(round).text,
        attachments: attachments(round.attachmentIds),
        members: round.turns.map(turn => {
          const run = runsById.get(turn.runId);
          return { name: turn.member.name, status: run?.status || turn.status,
            result: run?.result ?? turn.result, error: run?.error ?? turn.error };
        }),
        messages: followups.filter(message => message.task.id === task?.id).map(message => ({
          role: message.role, name: message.role === 'user' ? '用户' : message.hostGenerated ? '工作台回执'
            : (message.profileId && task?.groupMembers?.[message.profileId]?.name) || '团队协调',
          text: message.text, createdAt: message.createdAt, attachments: attachments(message.attachmentIds),
        })),
        delivery,
      };
    }),
  };
  if (format === 'json') return JSON.stringify(exported, null, 2);
  const lines = [`# ${exported.title}`, '', ...exported.workspaces.map(path => `> 工作区：${path}`),
    `> 导出时间：${exported.exportedAt}`, ''];
  for (const [index, round] of exported.rounds.entries()) {
    lines.push(`## 第 ${index + 1} 轮 · ${round.createdAt}`, '', '### 用户', '', round.user, '',
      ...round.attachments.map(file => `- 附件：${file.name}`), '');
    for (const member of round.members) {
      lines.push(`### ${member.name}`, '', member.result || member.error || '尚无已保存回复', '');
    }
    for (const message of round.messages) {
      lines.push(`### ${message.name} · ${message.createdAt}`, '', message.text, '',
        ...message.attachments.map(file => `- 附件：${file.name}`), '');
    }
    if (round.delivery) lines.push('### 团队交付汇总', '', round.delivery, '');
  }
  return lines.join('\n');
}

function downloadExport(title: string, content: string, format: 'markdown' | 'json') {
  const extension = format === 'markdown' ? 'md' : 'json';
  const mime = format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8';
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFilename(title)}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadConversation(conversation: AgentConversation, format: 'markdown' | 'json') {
  downloadExport(conversation.title, format === 'markdown' ? conversationMarkdown(conversation) : conversationJson(conversation), format);
}

export function downloadGroupConversation(detail: GroupRoomDetail, format: 'markdown' | 'json') {
  downloadExport(detail.room.title, groupConversationExport(detail, format), format);
}
