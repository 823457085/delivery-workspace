/**
 * 交付就绪度风险评分卡（0-100）与分类发布说明（Release Drafter）纯函数引擎。
 *
 * 设计借鉴自 GitHub 开源项目：
 * - PrePr / AgentGuard：确定性多维 PR 风险量化评分（0-100）与五维交付门禁（AST 契约兼容、凭据卫生、测试信号、高敏规则、体积可控度）
 * - release-drafter/release-drafter & orhun/git-cliff：基于提交语义 + Diff 契约/路径信号的自动分类变更日志生成
 */
import type { DiffHygieneWarning } from './diff-review-hygiene.js';

export type ReadinessRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ReadinessGateStatus = 'pass' | 'warn' | 'block';

export interface ReadinessGateItem {
  id: 'contract-compatibility' | 'hygiene-security' | 'test-signal' | 'sensitive-surface' | 'scope-complexity';
  label: string;
  status: ReadinessGateStatus;
  detail: string;
}

export interface ReadinessRiskFactor {
  id: string;
  label: string;
  points: number;
  severity: 'info' | 'medium' | 'high' | 'critical';
  detail: string;
}

export interface DeliveryReadinessScorecard {
  /** 风险分（0-100，越低越安全） */
  riskScore: number;
  /** 就绪分（0-100，等于 100 - riskScore，越高越就绪） */
  readinessScore: number;
  riskLevel: ReadinessRiskLevel;
  riskLabel: string;
  summary: string;
  gates: ReadinessGateItem[];
  factors: ReadinessRiskFactor[];
}

export interface DeliveryReadinessInput {
  totals: {
    files: number;
    additions: number;
    deletions: number;
    binaryFiles?: number;
  };
  sourceFiles?: number;
  testFiles?: number;
  generatedFiles?: number;
  missingTestsWarning?: boolean;
  largeDiffTriggered?: boolean;
  behindTargetCommits?: number;
  canFastForward?: boolean;
  triageRisks?: {
    category: string;
    label: string;
    severity: 'high' | 'medium';
    file: string;
    line?: number | null;
    reason: string;
  }[];
  hygieneWarnings?: DiffHygieneWarning[];
  blastRadius?: {
    touchedExports: {
      file: string;
      name: string;
      changeKind: 'removed' | 'signature-modified' | 'body-modified';
    }[];
    unchangedDependents: {
      file: string;
      importedSymbols: string[];
      matchedTouchedExports?: string[];
      risk?: 'high' | 'medium' | 'low';
    }[];
    impactedTests: {
      file: string;
      updatedInDiff?: boolean;
    }[];
  };
}

export type ReleaseNotesCategoryKey = 'breaking' | 'features' | 'fixes' | 'security' | 'engineering';

export interface ReleaseNotesCommitInput {
  sha?: string;
  subject: string;
  author?: string;
}

export interface ReleaseNotesDraftInput {
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  commits?: ReleaseNotesCommitInput[];
  files?: { path: string; status?: string }[];
  triageRisks?: { category: string; label: string; file: string; reason: string }[];
  breakingExports?: { file: string; name: string; changeKind: 'removed' | 'signature-modified' | 'body-modified' }[];
}

export interface CategorizedReleaseNotes {
  title: string;
  sections: {
    key: ReleaseNotesCategoryKey;
    heading: string;
    items: string[];
  }[];
  markdown: string;
}

/**
 * 评估 PR / 分支合入 / 会话交付的量化风险评分卡与 5 项就绪门禁。
 */
export function evaluateDeliveryReadinessScorecard(input: DeliveryReadinessInput): DeliveryReadinessScorecard {
  const factors: ReadinessRiskFactor[] = [];
  const hygieneWarnings = input.hygieneWarnings || [];
  const triageRisks = input.triageRisks || [];
  const blastRadius = input.blastRadius;

  // 1. 提交与凭据卫生门禁 (hygiene-security)
  const conflictWarnings = hygieneWarnings.filter(item => item.category === 'conflict-markers');
  const secretBlockers = hygieneWarnings.filter(item => item.severity === 'blocker' && item.category !== 'conflict-markers');
  const minorHygiene = hygieneWarnings.filter(item => item.severity !== 'blocker');

  let hygieneStatus: ReadinessGateStatus = 'pass';
  let hygieneDetail = '未检出冲突标记、硬编码密钥或高敏文件误入';

  if (conflictWarnings.length > 0) {
    hygieneStatus = 'block';
    hygieneDetail = `检出 ${conflictWarnings.length} 处未解决 Git 冲突标记`;
    factors.push({
      id: 'conflict-markers',
      label: '残留合并冲突标记',
      points: 45,
      severity: 'critical',
      detail: `${conflictWarnings.map(w => w.file).slice(0, 3).join('、')} 存在冲突标记`,
    });
  }
  if (secretBlockers.length > 0) {
    hygieneStatus = 'block';
    hygieneDetail = conflictWarnings.length > 0
      ? `${hygieneDetail}；另检出 ${secretBlockers.length} 项凭据/敏感路径阻断项`
      : `检出 ${secretBlockers.length} 项硬编码凭据或敏感路径阻断项`;
    factors.push({
      id: 'secret-or-sensitive-file',
      label: '凭据或敏感文件风险',
      points: 40,
      severity: 'critical',
      detail: secretBlockers.slice(0, 2).map(w => `${w.file}: ${w.label}`).join('；'),
    });
  }
  if (minorHygiene.length > 0) {
    if (hygieneStatus === 'pass') {
      hygieneStatus = 'warn';
      hygieneDetail = `存在 ${minorHygiene.length} 项调试语句或待办卫生提醒`;
    }
    factors.push({
      id: 'minor-hygiene',
      label: '调试残留与代码卫生',
      points: Math.min(12, minorHygiene.length * 4),
      severity: 'medium',
      detail: `包含 ${minorHygiene.length} 处调试输出/大体积或待办标记`,
    });
  }

  // 2. AST 导出契约与下游爆炸半径门禁 (contract-compatibility)
  const hardBreaking = (blastRadius?.touchedExports || []).filter(
    item => item.changeKind === 'removed' || item.changeKind === 'signature-modified',
  );
  const unchangedCallers = blastRadius?.unchangedDependents || [];

  let contractStatus: ReadinessGateStatus = 'pass';
  let contractDetail = '未发现破坏性导出删除或未同步的下游调用方';

  if (hardBreaking.length > 0 && unchangedCallers.length > 0) {
    contractStatus = 'block';
    contractDetail = `${hardBreaking.length} 个导出符号删除/签名变更，且有 ${unchangedCallers.length} 个下游调用文件未同步修改`;
    factors.push({
      id: 'breaking-export-unchanged-callers',
      label: '破坏性导出影响未改动调用方',
      points: 30,
      severity: 'critical',
      detail: `涉及 ${hardBreaking.slice(0, 3).map(b => b.name).join(', ')} -> 未同步调用方 ${unchangedCallers.slice(0, 3).map(c => c.file).join('、')}`,
    });
  } else if (hardBreaking.length > 0) {
    contractStatus = 'warn';
    contractDetail = `${hardBreaking.length} 个导出符号签名变更/移除（直接调用方已同步或无仓库内引用）`;
    factors.push({
      id: 'breaking-export-synced',
      label: '公共导出契约变更',
      points: 12,
      severity: 'medium',
      detail: `涉及导出符号 ${hardBreaking.slice(0, 4).map(b => `${b.name}(${b.changeKind === 'removed' ? '移除' : '签名变更'})`).join('、')}`,
    });
  } else if (unchangedCallers.length >= 4) {
    contractStatus = 'warn';
    contractDetail = `改动模块被 ${unchangedCallers.length} 个未改动下游文件依赖，建议回归核对`;
    factors.push({
      id: 'wide-downstream-fanout',
      label: '高扇出共享模块改动',
      points: 8,
      severity: 'info',
      detail: `影响 ${unchangedCallers.length} 个下游依赖文件`,
    });
  }

  // 3. 高敏表面静态规则门禁 (sensitive-surface)
  const highRisks = triageRisks.filter(item => item.severity === 'high');
  const mediumRisks = triageRisks.filter(item => item.severity === 'medium');
  const criticalRuleHit = highRisks.some(
    item => item.category === 'secret-hygiene' || item.category === 'destructive-migration',
  );

  let surfaceStatus: ReadinessGateStatus = 'pass';
  let surfaceDetail = '未命中鉴权、命令执行或破坏性迁移高敏规则';

  if (highRisks.length > 0) {
    surfaceStatus = criticalRuleHit ? 'block' : 'warn';
    surfaceDetail = `命中 ${highRisks.length} 项高关注静态规则（${[...new Set(highRisks.map(r => r.label))].join('、')}）`;
    factors.push({
      id: 'high-triage-risks',
      label: '高敏架构/安全面改动',
      points: Math.min(28, highRisks.length * 14),
      severity: criticalRuleHit ? 'critical' : 'high',
      detail: highRisks.slice(0, 3).map(r => `${r.file}${r.line ? `:${r.line}` : ''} (${r.label})`).join('；'),
    });
  }
  if (mediumRisks.length > 0) {
    if (surfaceStatus === 'pass') {
      surfaceStatus = 'warn';
      surfaceDetail = `命中 ${mediumRisks.length} 项中关注规则（${[...new Set(mediumRisks.map(r => r.label))].join('、')}）`;
    }
    factors.push({
      id: 'medium-triage-risks',
      label: '运行时配置与依赖关注点',
      points: Math.min(12, mediumRisks.length * 4),
      severity: 'medium',
      detail: mediumRisks.slice(0, 3).map(r => `${r.file} (${r.label})`).join('；'),
    });
  }

  // 4. 测试覆盖信号门禁 (test-signal)
  const sourceCount = input.sourceFiles ?? 0;
  const testCount = input.testFiles ?? 0;
  const missingTests = input.missingTestsWarning ?? (sourceCount > 0 && testCount === 0);
  const impactedTests = (blastRadius?.impactedTests || []).filter(item => !item.updatedInDiff).map(item => item.file);

  let testStatus: ReadinessGateStatus = 'pass';
  let testDetail = testCount > 0
    ? `已同步更新 ${testCount} 个测试文件`
    : sourceCount === 0
      ? '仅涉及非源码/文档配置变更'
      : '测试覆盖信号正常';

  if (missingTests) {
    testStatus = 'warn';
    const extraBlastHint = impactedTests.length > 0
      ? `（关联测试待跑：${impactedTests.slice(0, 2).join('、')}）`
      : '';
    testDetail = `改动了 ${sourceCount} 个源码文件但未包含测试文件更新${extraBlastHint}`;
    factors.push({
      id: 'missing-test-updates',
      label: '源码改动缺少配套测试变更',
      points: impactedTests.length > 0 ? 18 : 14,
      severity: 'medium',
      detail: testDetail,
    });
  }

  // 5. 变更体积与分支偏离门禁 (scope-complexity)
  const totalLines = (input.totals.additions || 0) + (input.totals.deletions || 0);
  const totalFiles = input.totals.files || 0;
  const behind = input.behindTargetCommits || 0;

  let scopeStatus: ReadinessGateStatus = 'pass';
  let scopeDetail = `${totalFiles} 个文件（+${input.totals.additions || 0} / -${input.totals.deletions || 0}），粒度适中`;

  if (input.largeDiffTriggered || totalFiles > 30 || totalLines > 800) {
    scopeStatus = 'warn';
    scopeDetail = `大体积变更：${totalFiles} 个文件，净改动 ${totalLines} 行，建议分批核对`;
    factors.push({
      id: 'large-diff-volume',
      label: '大体积变更复杂度',
      points: 12,
      severity: 'medium',
      detail: scopeDetail,
    });
  } else if (totalLines > 300 || totalFiles > 15) {
    scopeDetail = `中等规模变更：${totalFiles} 个文件，净改动 ${totalLines} 行`;
    factors.push({
      id: 'moderate-diff-volume',
      label: '中等变更规模',
      points: 6,
      severity: 'info',
      detail: scopeDetail,
    });
  }

  if (behind > 0 && input.canFastForward === false) {
    factors.push({
      id: 'branch-divergence',
      label: '目标分支已有新提交',
      points: Math.min(8, 4 + Math.floor(behind / 5) * 2),
      severity: 'info',
      detail: `落后目标分支 ${behind} 个提交，合入需创建合并提交或先行变基`,
    });
  }

  const rawPoints = factors.reduce((sum, item) => sum + item.points, 0);
  const riskScore = Math.min(100, Math.max(0, rawPoints));
  const readinessScore = 100 - riskScore;

  const gates: ReadinessGateItem[] = [
    { id: 'contract-compatibility', label: '契约兼容', status: contractStatus, detail: contractDetail },
    { id: 'hygiene-security', label: '凭据卫生', status: hygieneStatus, detail: hygieneDetail },
    { id: 'test-signal', label: '测试信号', status: testStatus, detail: testDetail },
    { id: 'sensitive-surface', label: '高敏核对', status: surfaceStatus, detail: surfaceDetail },
    { id: 'scope-complexity', label: '体积可控', status: scopeStatus, detail: scopeDetail },
  ];

  const hasBlockerGate = gates.some(gate => gate.status === 'block');
  let riskLevel: ReadinessRiskLevel;
  let riskLabel: string;
  if (hasBlockerGate || riskScore >= 70) {
    riskLevel = 'critical';
    riskLabel = '极高风险 · 阻断预警';
  } else if (riskScore >= 45) {
    riskLevel = 'high';
    riskLabel = '高风险 · 重点审查';
  } else if (riskScore >= 20) {
    riskLevel = 'medium';
    riskLabel = '中风险 · 建议复核';
  } else {
    riskLevel = 'low';
    riskLabel = '低风险 · 就绪';
  }

  const blockedLabels = gates.filter(g => g.status === 'block').map(g => g.label);
  const warnLabels = gates.filter(g => g.status === 'warn').map(g => g.label);
  const summary = blockedLabels.length > 0
    ? `就绪度 ${readinessScore}/100（风险分 ${riskScore}）：存在 ${blockedLabels.join('、')} 阻断预警，请消缺后再合入。`
    : warnLabels.length > 0
      ? `就绪度 ${readinessScore}/100（风险分 ${riskScore}）：整体可控，建议合入前复核 ${warnLabels.join('、')}。`
      : `就绪度 ${readinessScore}/100（风险分 ${riskScore}）：五项工程门禁全部通过，可安全推进合入。`;

  return {
    riskScore,
    readinessScore,
    riskLevel,
    riskLabel,
    summary,
    gates,
    factors,
  };
}

function classifyCommitSubject(subject: string): { category: ReleaseNotesCategoryKey; cleanText: string; isBreaking: boolean } {
  const trimmed = subject.trim();
  const conventional = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(trimmed);
  if (conventional) {
    const type = conventional[1]!.toLowerCase();
    const scope = conventional[2]?.trim();
    const bang = Boolean(conventional[3]);
    const rest = conventional[4]!.trim();
    const formatted = scope ? `**${scope}**：${rest}` : rest;
    if (bang || /breaking[\s-]*change/i.test(trimmed)) {
      return { category: 'breaking', cleanText: formatted, isBreaking: true };
    }
    if (['feat', 'feature', 'perf', 'ui', 'ux'].includes(type)) {
      return { category: 'features', cleanText: formatted, isBreaking: false };
    }
    if (['fix', 'bugfix', 'hotfix', 'revert'].includes(type)) {
      return { category: 'fixes', cleanText: formatted, isBreaking: false };
    }
    if (['sec', 'security', 'auth'].includes(type)) {
      return { category: 'security', cleanText: formatted, isBreaking: false };
    }
    return { category: 'engineering', cleanText: formatted, isBreaking: false };
  }

  if (/破坏性|不兼容|breaking/i.test(trimmed)) {
    return { category: 'breaking', cleanText: trimmed, isBreaking: true };
  }
  if (/^(?:安全|鉴权|权限|凭据|脱敏)/.test(trimmed)) {
    return { category: 'security', cleanText: trimmed, isBreaking: false };
  }
  if (/^(?:修复|解决|修正|处理|规避|兼容|fix)/i.test(trimmed)) {
    return { category: 'fixes', cleanText: trimmed, isBreaking: false };
  }
  if (/^(?:新增|支持|实现|优化|增强|升级|补充|引入|完善|添加)/i.test(trimmed)) {
    return { category: 'features', cleanText: trimmed, isBreaking: false };
  }
  return { category: 'engineering', cleanText: trimmed, isBreaking: false };
}

/**
 * 自动生成 Release Drafter 风格的分类变更发布说明（支持提交记录 + AST 契约变更 + 路径兜底归纳）。
 */
export function draftCategorizedReleaseNotes(input: ReleaseNotesDraftInput): CategorizedReleaseNotes {
  const buckets: Record<ReleaseNotesCategoryKey, string[]> = {
    breaking: [],
    features: [],
    fixes: [],
    security: [],
    engineering: [],
  };

  const pushUnique = (key: ReleaseNotesCategoryKey, text: string) => {
    const normalized = text.trim();
    if (!normalized) return;
    if (!buckets[key].includes(normalized)) buckets[key].push(normalized);
  };

  // 1. 归类提交历史
  for (const commit of input.commits || []) {
    if (!commit.subject?.trim()) continue;
    const classified = classifyCommitSubject(commit.subject);
    const shaSuffix = commit.sha ? ` (\`${commit.sha.slice(0, 7)}\`)` : '';
    pushUnique(classified.category, `${classified.cleanText}${shaSuffix}`);
  }

  // 2. AST 破坏性导出变更自动补入「破坏性变更与升级注意」（即使 commit 未写 !）
  for (const exp of input.breakingExports || []) {
    if (exp.changeKind === 'removed' || exp.changeKind === 'signature-modified') {
      const actionLabel = exp.changeKind === 'removed' ? '移除了导出符号' : '调整了导出函数/类型签名';
      pushUnique('breaking', `\`${exp.file}\` ${actionLabel} \`${exp.name}\`，升级时请核对下游调用方兼容性`);
    }
  }

  // 3. 高敏安全与鉴权风险提示自动补入「安全、权限与配置」
  for (const risk of input.triageRisks || []) {
    if (['auth-permission', 'secret-hygiene', 'destructive-migration', 'runtime-config'].includes(risk.category)) {
      pushUnique('security', `\`${risk.file}\` 涉及${risk.label}（${risk.reason}）`);
    }
  }

  // 4. 若无 commit 记录（例如工作区未提交的会话交付场景），按改动文件自动归纳摘要
  if (!(input.commits && input.commits.length > 0) && input.files && input.files.length > 0) {
    const added = input.files.filter(f => f.status === 'added' || f.status === 'A');
    const modified = input.files.filter(f => !f.status || f.status === 'modified' || f.status === 'M');
    const deleted = input.files.filter(f => f.status === 'deleted' || f.status === 'D');
    if (added.length > 0) {
      pushUnique('features', `新增 ${added.length} 个模块/文件：${added.slice(0, 5).map(f => `\`${f.path}\``).join('、')}${added.length > 5 ? ' 等' : ''}`);
    }
    if (modified.length > 0) {
      pushUnique('engineering', `更新 ${modified.length} 个现有文件：${modified.slice(0, 5).map(f => `\`${f.path}\``).join('、')}${modified.length > 5 ? ' 等' : ''}`);
    }
    if (deleted.length > 0) {
      pushUnique('engineering', `清理/移除 ${deleted.length} 个文件：${deleted.slice(0, 4).map(f => `\`${f.path}\``).join('、')}${deleted.length > 4 ? ' 等' : ''}`);
    }
  }

  const sectionMeta: { key: ReleaseNotesCategoryKey; heading: string }[] = [
    { key: 'breaking', heading: '⚠️ 破坏性变更与升级注意' },
    { key: 'features', heading: '🚀 新增特性与体验优化' },
    { key: 'fixes', heading: '🐛 问题修复' },
    { key: 'security', heading: '🔒 安全、权限与运行配置' },
    { key: 'engineering', heading: '🧱 重构、测试与工程治理' },
  ];

  const sections = sectionMeta
    .filter(meta => buckets[meta.key].length > 0)
    .map(meta => ({
      key: meta.key,
      heading: meta.heading,
      items: buckets[meta.key],
    }));

  const headerTitle = input.title?.trim()
    || (input.sourceBranch && input.targetBranch
      ? `变更发布说明（${input.sourceBranch} → ${input.targetBranch}）`
      : '变更发布说明');

  const lines: string[] = [`## ${headerTitle}`, ''];
  if (sections.length === 0) {
    lines.push('- 暂无可归类的代码或提交变更。', '');
  } else {
    for (const section of sections) {
      lines.push(`### ${section.heading}`, '');
      for (const item of section.items) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  return {
    title: headerTitle,
    sections,
    markdown: lines.join('\n').trim(),
  };
}
