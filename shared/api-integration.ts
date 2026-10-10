/** 契约快照与人工管理记录分开：状态更新不改接口文档，批次进度只从接口记录汇总。 */
export const integrationStatuses = ['待联调', '联调中', '阻塞', '通过', '不适用'] as const;
export type IntegrationStatus = typeof integrationStatuses[number];
export const bffIntegrationStatuses = ['待接入', '已接入', '不适用'] as const;
export type BffIntegrationStatus = typeof bffIntegrationStatuses[number];
export const integrationCategories = ['待 BFF 接入', 'BFF 已接入，待环境联调', '真实环境联调中', '真实环境已通过', '真实环境阻塞', '不适用'] as const;
export type IntegrationCategory = typeof integrationCategories[number];
export interface StageRecord { owner: string; startDate: string; endDate: string; notes: string; updatedAt: string }
export interface OperationRecord { bffStatus: BffIntegrationStatus; status: IntegrationStatus; notes: string; evidence: string; updatedAt: string }
export interface IntegrationState { stages: Record<string, StageRecord>; operations: Record<string, OperationRecord> }
export type IntegrationUpdate =
  | { kind: 'stage'; id: string; record: Omit<StageRecord, 'updatedAt'> }
  | { kind: 'operation'; id: string; record: Omit<OperationRecord, 'updatedAt'> };
export function integrationProgress(ids: string[], state: IntegrationState) {
  const statuses = ids.map(id => state.operations[id]?.status || '待联调');
  const passed = statuses.filter(s => s === '通过').length;
  const skipped = statuses.filter(s => s === '不适用').length;
  const blocked = statuses.filter(s => s === '阻塞').length;
  const running = statuses.filter(s => s === '联调中').length;
  const status = blocked ? '阻塞' : statuses.length && passed + skipped === statuses.length ? '已处理' : statuses.some(s => s !== '待联调') ? '联调中' : '待联调';
  return { passed, skipped, blocked, running, total: ids.length, status };
}
export function bffIntegrationProgress(ids: string[], state: IntegrationState) {
  const statuses = ids.map(id => state.operations[id]?.bffStatus || '待接入');
  const connected = statuses.filter(status => status === '已接入').length;
  const skipped = statuses.filter(status => status === '不适用').length;
  return { connected, skipped, pending: statuses.length - connected - skipped, total: ids.length };
}
export function integrationCategory(record?: OperationRecord): IntegrationCategory {
  if (!record || record.bffStatus === '待接入') return '待 BFF 接入';
  if (record.bffStatus === '不适用' || record.status === '不适用') return '不适用';
  if (record.status === '通过') return '真实环境已通过';
  if (record.status === '阻塞') return '真实环境阻塞';
  if (record.status === '联调中') return '真实环境联调中';
  return 'BFF 已接入，待环境联调';
}
export function integrationCategoryProgress(ids: string[], state: IntegrationState) {
  const counts = Object.fromEntries(integrationCategories.map(category => [category, 0])) as Record<IntegrationCategory, number>;
  ids.forEach(id => { counts[integrationCategory(state.operations[id])] += 1; });
  return counts;
}
