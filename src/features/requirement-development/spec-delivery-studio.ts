export type SpecRecordBucket = 'running' | 'completed' | 'failed' | 'ready';

export interface SpecRecordLike {
  status: string;
  runStatus?: string;
  error?: string;
  runError?: string;
  progressSyncError?: string;
}

export interface SpecRecordsTelemetry {
  total: number;
  running: number;
  completed: number;
  failed: number;
}

/**
 * Maps heterogeneous Requirement Development / Jira Fix execution records into 4 clear operational buckets
 * (inspired by GitHub Spec-Kit & OpenHands run telemetry).
 */
export function classifyDeliveryRecordState(record: SpecRecordLike): SpecRecordBucket {
  if (
    record.status === 'failed' ||
    record.status === 'uncertain' ||
    record.runStatus === 'failed' ||
    record.runStatus === 'interrupted' ||
    Boolean(record.error || record.runError)
  ) {
    return 'failed';
  }
  if (
    record.status === 'preparing' ||
    record.status === 'starting' ||
    record.runStatus === 'queued' ||
    record.runStatus === 'running'
  ) {
    return 'running';
  }
  if (record.runStatus === 'completed') {
    return 'completed';
  }
  return 'ready';
}

export function summarizeDeliveryRecords(records: readonly SpecRecordLike[]): SpecRecordsTelemetry {
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const item of records) {
    const state = classifyDeliveryRecordState(item);
    if (state === 'running') running++;
    else if (state === 'completed') completed++;
    else if (state === 'failed') failed++;
  }
  return {
    total: records.length,
    running,
    completed,
    failed,
  };
}

/**
 * Computes Spec-Driven Development checkpoint progress across requirement stages.
 */
export function computeSpecStageProgress(
  stages?: Record<string, { status: string }> | null,
  stageOrder: readonly string[] = ['schedule', 'design', 'implementation', 'verification'],
): { completedCount: number; activeCount: number; totalCount: number; percent: number } {
  const totalCount = Math.max(1, stageOrder.length);
  if (!stages) {
    return { completedCount: 0, activeCount: 0, totalCount, percent: 0 };
  }
  let completedCount = 0;
  let activeCount = 0;
  for (const key of stageOrder) {
    const st = stages[key]?.status;
    if (st === 'completed' || st === 'done' || st === 'passed' || st === 'not_applicable') {
      completedCount++;
    } else if (st === 'in_progress' || st === 'running') {
      activeCount++;
    }
  }
  const percent = Math.round((completedCount / totalCount) * 100);
  return { completedCount, activeCount, totalCount, percent };
}
