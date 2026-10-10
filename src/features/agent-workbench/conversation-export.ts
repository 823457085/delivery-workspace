/**
 * 设计说明：会话导出只投影用户消息、Agent 结果和必要的执行上下文，不包含 PID、
 * 工具诊断等本机运行细节。生成纯内容与浏览器下载分开，便于测试且避免组件持有文件逻辑。
 */
import type { AgentConversation } from './conversation';
import { isAgentImageAttachment } from '../../../shared/agent-runtime';

function safeFilename(value: string) {
  return value.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'agent-conversation';
}

export function conversationMarkdown(conversation: AgentConversation) {
  const lines = [
    `# ${conversation.title}`,
    '',
    `> 执行器：${conversation.latest.provider === 'codex' ? 'Codex CLI' : 'Cursor CLI'}`,
    `> 工作区：${conversation.latest.workspacePath}`,
    `> 分支：${conversation.latest.branch || '未识别'}`,
    `> 导出时间：${new Date().toLocaleString()}`,
    '',
  ];
  conversation.runs.forEach((run, index) => {
    lines.push(`## 第 ${index + 1} 轮 · 用户`, '', run.objective, '');
    if (run.attachments?.length) lines.push(...run.attachments.map((attachment) => `- ${isAgentImageAttachment(attachment) ? '图片' : '文件'}：${attachment.name}（${attachment.mimeType}，${attachment.size} bytes）`), '');
    for (const supplement of run.supplements || []) {
      lines.push('### 用户补充', '', supplement.objective, '', ...supplement.attachments.map(item => `- ${isAgentImageAttachment(item) ? '图片' : '文件'}：${item.name}`), '');
    }
    lines.push(`## 第 ${index + 1} 轮 · ${run.provider === 'codex' ? 'Codex' : 'Cursor'}`, '',
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

export function downloadConversation(conversation: AgentConversation, format: 'markdown' | 'json') {
  const content = format === 'markdown' ? conversationMarkdown(conversation) : conversationJson(conversation);
  const extension = format === 'markdown' ? 'md' : 'json';
  const mime = format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8';
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFilename(conversation.title)}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
