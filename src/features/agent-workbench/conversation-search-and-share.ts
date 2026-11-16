/**
 * 设计说明：借鉴 GitHub 标杆项目 Zed / Cherry Studio / Open WebUI：
 * 1. 会话内搜索不仅过滤匹配项，还统计总命中次数并支持 `↑ / ↓` 或回车逐轮快速定位；
 * 2. 一键将整场对话整理为「飞书 / Confluence / Obsidian 友好」的清爽 Markdown 纪要（含改动文件清单与各轮问答）直接复制到剪贴板。
 */
import { agentProviderLabels } from '../../../shared/agent-runtime';
import { agentConversationRunRounds, type AgentConversation } from './conversation';

export function countKeywordOccurrences(text: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return 0;
  const hay = text.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = hay.indexOf(needle, pos);
    if (idx < 0) break;
    count++;
    pos = idx + Math.max(1, needle.length);
  }
  return count;
}

export function stepSearchMatchIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return 0;
  const normalized = ((current % total) + total) % total;
  return (normalized + delta + total) % total;
}

export function buildConversationClipboardDigest(conversation: AgentConversation): string {
  const providerLabel = agentProviderLabels[conversation.latest.provider] || conversation.latest.provider;
  const changedSet = new Set<string>();
  for (const run of conversation.runs) {
    for (const file of run.changedFiles || []) {
      if (file.path) changedSet.add(`${file.path}（${file.status}）`);
    }
  }

  const lines: string[] = [
    `# ${conversation.title || 'AI 协作纪要'}`,
    '',
    `- **执行器**：${providerLabel}`,
  ];
  if (conversation.latest.workspacePath) {
    lines.push(`- **项目目录**：\`${conversation.latest.workspacePath}\``);
  }
  if (conversation.latest.branch) {
    lines.push(`- **分支**：\`${conversation.latest.branch}\``);
  }
  lines.push(`- **轮次数**：共 ${conversation.runs.length} 轮`);

  if (changedSet.size > 0) {
    lines.push('', '## 涉及改动文件', '');
    for (const item of [...changedSet].slice(0, 30)) {
      lines.push(`- \`${item}\``);
    }
    if (changedSet.size > 30) {
      lines.push(`- …及其他 ${changedSet.size - 30} 个文件`);
    }
  }

  lines.push('', '## 对话问答记录', '');
  const rounds = agentConversationRunRounds(conversation);
  for (const run of conversation.runs) {
    const round = rounds.get(run.id) || 1;
    lines.push(`### 第 ${round} 轮`, '', '**提问：**', '', run.objective.trim() || '（附件消息）', '');
    for (const sup of run.supplements || []) {
      if (sup.objective.trim()) {
        lines.push(`> 补充：${sup.objective.trim().replace(/\n+/g, ' ')}`, '');
      }
    }
    const reply = (run.result || run.error || '').trim();
    lines.push('**回复：**', '', reply || '（尚无最终文本回复）', '');
  }

  return lines.join('\n').trim();
}
