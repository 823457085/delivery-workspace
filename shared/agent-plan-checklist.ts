/**
 * Agent Plan-to-Build Interactive Checklist Engine
 *
 * 借鉴 OpenCode (sst/opencode) Plan → Build 双阶段推进、Claude Code TodoWrite 清单追踪与 taskmd (driangle/taskmd)：
 * - 从 Agent 回复（尤其是 Plan 只读规划轮或含 `- [ ]` 的多步方案）中精准提取可执行清单（自动跳过代码块围栏）；
 * - 支持用户在界面勾选已完成项、点选单个或若干子步骤「分步推进 Agent 实施」，避免单轮全量改动引发上下文退化；
 * - 支持一键导出带 YAML Frontmatter 的 `taskmd` / `TODO.md` 本地追踪文档。
 */

import type { AgentRunMode } from './agent-runtime.js';

export interface PlanChecklistItem {
  id: string;
  index: number;
  text: string;
  cleanTitle: string;
  checkedByModel: boolean;
  phase?: string;
  fileRefs: string[];
}

export interface ExtractedPlanChecklist {
  actionable: boolean;
  sourceKind: 'checkbox' | 'numbered_plan' | 'none';
  items: PlanChecklistItem[];
}

function stripInlineMarkdownFormatting(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInlineFileRefs(raw: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const regex = /`([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?)`/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const candidate = match[1]!.trim();
    if (!candidate || candidate.startsWith('http') || seen.has(candidate)) continue;
    seen.add(candidate);
    refs.push(candidate);
    if (refs.length >= 6) break;
  }
  return refs;
}

/**
 * 从 Markdown 回复正文中提取结构化计划步骤（严格忽略 ``` / ~~~ 代码围栏内部文本）。
 */
export function extractMarkdownPlanChecklist(
  markdown: string,
  options: { mode?: AgentRunMode } = {},
): ExtractedPlanChecklist {
  if (!markdown || !markdown.trim()) {
    return { actionable: false, sourceKind: 'none', items: [] };
  }

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let activeFence = '';
  let currentHeading = '';

  const checkboxItems: PlanChecklistItem[] = [];
  const numberedCandidates: PlanChecklistItem[] = [];

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!activeFence) {
        activeFence = marker;
      } else if (marker === activeFence && /^\s*(`{3,}|~{3,})\s*$/.test(line)) {
        activeFence = '';
      }
      continue;
    }
    if (activeFence) continue;

    const headingMatch = /^\s*#{1,4}\s+(.+?)\s*#*$/.exec(line);
    if (headingMatch) {
      currentHeading = stripInlineMarkdownFormatting(headingMatch[1]!);
      continue;
    }

    const checkboxMatch = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~-])\]\s+(.+)$/.exec(line);
    if (checkboxMatch) {
      const mark = checkboxMatch[1]!.toLowerCase();
      const rawText = checkboxMatch[2]!.trim();
      const cleanTitle = stripInlineMarkdownFormatting(rawText);
      if (cleanTitle.length >= 3) {
        const index = checkboxItems.length + 1;
        checkboxItems.push({
          id: `step-${index}`,
          index,
          text: rawText,
          cleanTitle,
          checkedByModel: mark === 'x',
          ...(currentHeading ? { phase: currentHeading } : {}),
          fileRefs: extractInlineFileRefs(rawText),
        });
      }
      continue;
    }

    if (options.mode === 'plan') {
      const numberedMatch = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
      if (numberedMatch && numberedMatch[1]!.length <= 3) {
        const rawText = numberedMatch[3]!.trim();
        const cleanTitle = stripInlineMarkdownFormatting(rawText);
        if (cleanTitle.length >= 6 && !/^https?:\/\//i.test(cleanTitle)) {
          const index = numberedCandidates.length + 1;
          numberedCandidates.push({
            id: `step-${index}`,
            index,
            text: rawText,
            cleanTitle,
            checkedByModel: false,
            ...(currentHeading ? { phase: currentHeading } : {}),
            fileRefs: extractInlineFileRefs(rawText),
          });
        }
      }
    }
  }

  if (checkboxItems.length >= 2) {
    const capped = checkboxItems.slice(0, 24);
    return {
      actionable: true,
      sourceKind: 'checkbox',
      items: capped,
    };
  }

  if (options.mode === 'plan' && numberedCandidates.length >= 2) {
    const capped = numberedCandidates.slice(0, 20);
    return {
      actionable: true,
      sourceKind: 'numbered_plan',
      items: capped,
    };
  }

  return { actionable: false, sourceKind: 'none', items: [] };
}

/**
 * 基于用户勾选状态构造分步受控的 Agent 执行提示词，防止长计划单轮失焦。
 */
export function buildPlanStepExecutionPrompt(input: {
  items: readonly PlanChecklistItem[];
  targetIds: readonly string[];
  completedIds: readonly string[];
  originalObjective?: string;
}): string {
  const completedSet = new Set(input.completedIds);
  const explicitTargetSet = new Set(input.targetIds.filter(id => !completedSet.has(id)));

  let targetItems = input.items.filter(item => explicitTargetSet.has(item.id));
  if (targetItems.length === 0) {
    const firstPending = input.items.find(item => !completedSet.has(item.id));
    if (firstPending) targetItems = [firstPending];
  }

  const completedItems = input.items.filter(item => completedSet.has(item.id));
  const targetIdSet = new Set(targetItems.map(item => item.id));
  const deferredItems = input.items.filter(item => !completedSet.has(item.id) && !targetIdSet.has(item.id));

  const lines: string[] = [
    `请切换到实施状态，严格聚焦执行以下选定的计划步骤（控制变更边界，避免无关重构）：`,
  ];

  const cleanObjective = (input.originalObjective || '').replace(/\s+/g, ' ').trim();
  if (cleanObjective) {
    lines.push(
      ``,
      `> 背景目标：${cleanObjective.length > 160 ? `${cleanObjective.slice(0, 157)}...` : cleanObjective}`,
    );
  }

  if (completedItems.length > 0) {
    lines.push(``, `### 已完成步骤（保持兼容，无需重复改动）`);
    for (const item of completedItems) {
      lines.push(`- [x] 步骤 ${item.index}：${item.cleanTitle}`);
    }
  }

  lines.push(``, `### 本轮需实施的目标步骤（共 ${targetItems.length} 步）`);
  const touchedFiles = new Set<string>();
  for (const item of targetItems) {
    for (const f of item.fileRefs) touchedFiles.add(f);
    const phasePrefix = item.phase ? `[${item.phase}] ` : '';
    lines.push(`- [ ] 步骤 ${item.index}：${phasePrefix}${item.text}`);
  }

  if (touchedFiles.size > 0) {
    lines.push(``, `重点关联文件：${Array.from(touchedFiles).map(f => `\`${f}\``).join('、')}`);
  }

  if (deferredItems.length > 0) {
    lines.push(
      ``,
      `### 暂缓步骤（本轮暂不展开，留待下一轮验证通过后推进：共 ${deferredItems.length} 步）`,
    );
    for (const item of deferredItems.slice(0, 6)) {
      lines.push(`- 暂缓步骤 ${item.index}：${item.cleanTitle}`);
    }
  }

  lines.push(
    ``,
    `实施完成后请运行对应的类型检查或单元测试验证，并在回复末尾用 \`- [x]\` 标记本轮已完成的步骤。`,
  );

  return lines.join('\n');
}

/**
 * 导出兼容 taskmd / planning-with-files 规范的带 YAML Frontmatter 的本地任务追踪 Markdown。
 */
export function formatPlanChecklistTaskMarkdown(input: {
  title: string;
  runId: string;
  items: readonly PlanChecklistItem[];
  completedIds: readonly string[];
}): string {
  const completedSet = new Set(input.completedIds);
  const doneCount = input.items.filter(item => completedSet.has(item.id)).length;
  const totalCount = input.items.length;
  const status = totalCount > 0 && doneCount === totalCount
    ? 'completed'
    : doneCount > 0
      ? 'in_progress'
      : 'todo';
  const safeTitle = (input.title || 'AI 执行计划清单').replace(/[\r\n"]+/g, ' ').trim().slice(0, 120);

  const lines: string[] = [
    `---`,
    `task_id: "${input.runId.slice(0, 8)}"`,
    `title: "${safeTitle}"`,
    `status: "${status}"`,
    `progress: "${doneCount}/${totalCount}"`,
    `---`,
    ``,
    `# ${safeTitle}`,
    ``,
    `## 执行计划追踪 (${doneCount}/${totalCount})`,
  ];

  let lastPhase = '';
  for (const item of input.items) {
    if (item.phase && item.phase !== lastPhase) {
      lastPhase = item.phase;
      lines.push(``, `### ${lastPhase}`);
    }
    const mark = completedSet.has(item.id) ? 'x' : ' ';
    lines.push(`- [${mark}] ${item.text}`);
  }

  return `${lines.join('\n')}\n`;
}
