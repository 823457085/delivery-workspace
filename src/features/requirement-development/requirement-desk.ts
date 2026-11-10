import { requirementStages, requirementStageLabels, type RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import { overseasStageLabels, type OverseasRequirement } from '../../../shared/overseas-requirements';
import { repositoryKey, type CatalogSystem } from '../../../shared/system-catalog';
import type { GroupRoomSummary } from '../../../shared/agent-group-chat';

type RecordView = RequirementDevelopmentRecord & { runError?: string };
export type DeskFocus = 'attention' | 'running' | 'due' | 'acceptance' | 'all';
export function deskToday(now = new Date()) { return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' }); }
export function requirementDeskRow(item: OverseasRequirement, records: RecordView[], catalog: CatalogSystem[], today: string, groups: GroupRoomSummary[] = []) {
  const linked = records.filter(record => item.executionIds.includes(record.id)).sort((a, b) =>
    (b.progress?.updatedAt || b.createdAt).localeCompare(a.progress?.updatedAt || a.createdAt));
  const current = linked.filter(record => !!record.runId && record.progress?.sourceRunId === record.runId);
  const latest = current[0] || linked[0];
  const linkedGroups = groups.filter(group => item.groupRoomIds?.includes(group.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const runningGroup = linkedGroups.find(group => !group.paused && !group.waitingForLogin && ['queued', 'running'].includes(group.state));
  const failedGroup = linkedGroups.find(group => group.state === 'failed');
  const pausedGroup = linkedGroups.find(group => group.paused || group.waitingForLogin || group.state === 'cancelled');
  let groupTarget = failedGroup || pausedGroup || runningGroup || linkedGroups[0];
  const running = linked.filter(record => ['queued', 'running'].includes(record.groupProgress?.state || record.runStatus || '')
    || ['preparing', 'starting'].includes(record.status));
  const manualAccepted = item.stage === 'accepted' && !running.length && !runningGroup
    && !current.some(record => record.progress!.updatedAt > item.updatedAt)
    && !linkedGroups.some(group => group.updatedAt > item.updatedAt);
  const blockers = current.flatMap(record => requirementStages.filter(key => record.progress!.stages[key].status === 'blocked')
    .map(key => ({ record, stage: key, label: `${requirementStageLabels[key]}受阻`, evidence: record.progress!.stages[key].evidence })));
  const executionFailure = linked.find(record => record.status === 'failed' || record.runStatus === 'failed' || record.groupProgress?.state === 'failed');
  const paused = linked.find(record => ['paused', 'cancelled'].includes(record.groupProgress?.state || '')
    || ['interrupted', 'cancelled'].includes(record.runStatus || '') || record.status === 'uncertain');
  const days = item.endDate ? Math.round((Date.parse(item.endDate) - Date.parse(today)) / 86400000) : null;
  const overdue = !manualAccepted && days !== null && days < 0;
  const dueSoon = !manualAccepted && days !== null && days >= 0 && days <= 7;
  const repositories = new Set(linked.map(record => repositoryKey(record.input.repository)).filter(Boolean));
  const matchedSystems = catalog.filter(system => !!repositoryKey(system.repository) && repositories.has(repositoryKey(system.repository)));
  const systems = [...new Set([...item.systems.map(system => system.name), ...matchedSystems.map(system => system.name)])];
  const stages = latest?.progress?.sourceRunId === latest?.runId && latest?.runId
    ? requirementStages.map(key => ({ key, label: requirementStageLabels[key], ...latest.progress!.stages[key] })) : [];
  const progress = latest?.progress?.sourceRunId === latest?.runId ? latest?.progress : undefined;
  const unfinishedVerification = progress && ['in_progress', 'pending'].includes(progress.stages.verification.status)
    && progress.stages.development.status !== 'pending';
  let label = overseasStageLabels[item.stage] as string, nextStep = '核对需求范围、涉及系统与排期，再准备开发。';
  let action: 'detail' | 'edit' | 'develop' | 'team' = 'detail', actionLabel = '查看需求', priority = 0;
  let tone: 'blocked' | 'running' | 'review' | 'neutral' | 'accepted' = 'neutral';
  let target: RecordView | undefined = latest && (!item.groupRoomIds?.length
    || groupTarget && (latest.progress?.updatedAt || latest.createdAt) >= groupTarget.updatedAt) ? latest : undefined;
  if (!manualAccepted && (item.blocker.trim() || blockers.length || executionFailure || failedGroup)) {
    label = item.blocker.trim() ? '需要解除阻塞' : blockers[0]?.label || '执行遇到阻塞';
    nextStep = '先核对阻塞证据并处理未完成项，再继续验证与交付。';
    const blockedRecord = blockers[0]?.record || executionFailure;
    if (blockedRecord) target = blockedRecord;
    else if (failedGroup) { target = undefined; groupTarget = failedGroup; }
    action = target?.groupRoomId || target?.runId || !target && (groupTarget || item.groupRoomIds?.length) ? 'team' : 'detail'; actionLabel = action === 'team' ? '进入团队处理' : '查看阻塞';
    priority = 100; tone = 'blocked';
  } else if (running.length || runningGroup) {
    target = running[0]; groupTarget = runningGroup || groupTarget;
    const member = target?.groupProgress?.activeMember || runningGroup?.activeMember;
    label = member ? `${member}正在处理` : '团队正在执行';
    nextStep = '查看当前执行进展，有新结果后再核对验证与交付。';
    action = target?.groupRoomId || target?.runId || groupTarget ? 'team' : 'detail'; actionLabel = '查看执行进展'; priority = 30; tone = 'running';
  } else if (manualAccepted) {
    label = '已人工验收'; nextStep = '查看已登记的验收结论与交付证据。'; actionLabel = '查看交付'; tone = 'accepted';
  } else if (item.stage === 'accepted') {
    label = '新执行结果待复核'; nextStep = '验收后出现了新的阶段记录，请核对新结果是否影响原验收结论。';
    actionLabel = '核对最新结果'; priority = 65; tone = 'review';
  } else if (paused || pausedGroup) {
    target = paused; groupTarget = pausedGroup || groupTarget;
    const waitingForLogin = paused?.groupProgress?.waitingForLogin || pausedGroup?.waitingForLogin;
    label = waitingForLogin ? '等待登录测试环境' : '执行已暂停 / 中断';
    nextStep = waitingForLogin ? '进入团队查看登录请求，完成认证后继续验证。' : '核对当前执行记录，再决定继续执行或调整安排。';
    action = target?.groupRoomId || target?.runId || groupTarget ? 'team' : 'detail'; actionLabel = action === 'team' ? '查看待处理请求' : '核对执行状态'; priority = 75; tone = 'review';
  } else if (item.stage === 'acceptance') {
    label = '等待你验收'; nextStep = '核对各系统验证结果、多语言产物与验收标准，记录验收结论。';
    actionLabel = '查看交付并验收'; priority = 90; tone = 'review';
  } else if (unfinishedVerification) {
    target = latest;
    label = '验证尚未完成'; nextStep = '核对本轮验证记录，处理未完成项后再安排提测与验收。';
    action = target?.groupRoomId || target?.runId ? 'team' : 'detail'; actionLabel = action === 'team' ? '继续跟进验证' : '查看验证记录'; priority = 70; tone = 'review';
  } else if ((linked.length || linkedGroups.length) && item.stage === 'unconfirmed') {
    label = '执行结果待核对'; nextStep = '会话已有记录，核对阶段证据与交付结果后更新需求状态。';
    actionLabel = '核对执行结果'; priority = 65; tone = 'review';
  } else if (['intake', 'unconfirmed'].includes(item.stage)) {
    label = item.stage === 'intake' ? '需求待评审' : '需求信息待核对'; action = 'edit'; actionLabel = '完善需求信息'; priority = 50;
  } else if (item.stage === 'planned' || item.stage === 'development') {
    action = 'develop'; actionLabel = '准备 / 继续开发'; priority = 45;
  } else if (item.stage === 'verification' || item.stage === 'handoff') {
    nextStep = '核对验证证据与交接材料，确认具备验收条件。'; actionLabel = '查看交付记录'; priority = 65; tone = 'review';
  }
  const targetGroupId = target ? target.groupRoomId : groupTarget?.id || item.groupRoomIds?.[0];
  if ((groupTarget || item.groupRoomIds?.length) && targetGroupId && action !== 'edit' && !manualAccepted && item.stage !== 'acceptance') {
    action = 'team';
    if (tone === 'blocked') actionLabel = '进入团队处理';
    if (actionLabel === '查看交付记录' || actionLabel === '核对执行结果' || actionLabel === '准备 / 继续开发') actionLabel = '进入原群聊跟进';
  }
  const attention = !manualAccepted && priority >= 45 && !(priority < 65 && item.startDate && item.startDate > today);
  const executionLabel = running.length || runningGroup ? '正在执行' : executionFailure || failedGroup ? '执行失败' : paused || pausedGroup ? '执行待处理' : linked.length || linkedGroups.some(group => group.state === 'completed') ? '本轮执行已结束' : linkedGroups.length ? '已关联团队群聊' : item.groupRoomIds?.length ? '群聊状态待核对' : '尚未启动开发';
  return { item, linked, target, linkedGroups, targetGroupId, systems, matchedSystems, stages, blockers: manualAccepted ? [] : blockers,
    blocker: manualAccepted ? '' : item.blocker || blockers[0]?.evidence || executionFailure?.runError || executionFailure?.error || executionFailure?.groupProgress?.error || '',
    label, nextStep, action, actionLabel, priority, tone, attention, running: running.length > 0 || !!runningGroup,
    accepted: manualAccepted, awaitingAcceptance: !manualAccepted && item.stage === 'acceptance', overdue, dueSoon, days, executionLabel,
    evidenceAt: progress?.updatedAt || latest?.createdAt || item.updatedAt,
    staleReport: linked.some(record => record.progress && record.progress.sourceRunId !== record.runId) };
}
export type RequirementDeskRow = ReturnType<typeof requirementDeskRow>;
export function deskRows(items: OverseasRequirement[], records: RecordView[], catalog: CatalogSystem[], today: string, groups: GroupRoomSummary[] = []) {
  return items.map(item => requirementDeskRow(item, records, catalog, today, groups)).sort((a, b) =>
    b.priority - a.priority || Number(b.overdue) - Number(a.overdue) || (a.item.endDate || '9999').localeCompare(b.item.endDate || '9999')
    || b.evidenceAt.localeCompare(a.evidenceAt));
}
export function matchesDeskFocus(row: RequirementDeskRow, focus: DeskFocus) {
  return focus === 'all' || focus === 'attention' && row.attention || focus === 'running' && row.running
    || focus === 'due' && (row.overdue || row.dueSoon) || focus === 'acceptance' && row.awaitingAcceptance;
}
