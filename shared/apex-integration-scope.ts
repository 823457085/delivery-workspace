/**
 * 菜单筛选与自动执行共用本轮延期规则，分类独立于负责人和已有验收结果。
 * 按业务路径与明确菜单匹配，不按“订单/活动”字样泛匹配，避免暂停付款单、工单和提示文案配置。
 */
export interface IntegrationScopeItem { path: string; ui: { module: string; page: string } }
export type IntegrationScopeCategory = '本轮联调' | '暂不联调';

export function integrationDeferral(item: IntegrationScopeItem): string {
  if (item.ui.module === '数据监控' || /^\/admin\/v1\/data-monitoring(?:\/|$)/.test(item.path)) return '大数据 / 数据监控';
  if (['活动管理', '订单管理', '订单探针'].includes(item.ui.page)
    || /^\/admin\/v1\/(?:activity-trades|orders|order-probes)(?:\/|$)/.test(item.path)
    || /^\/admin\/v1\/merchants\/function-config\/(?:activity-limit-devices|update-activity-limit)(?:\/|$)/.test(item.path)) return '活动 / 订单';
  if (item.ui.page === '账单详情'
    || item.ui.module === '财务管理' && /^(?:账单管理|账单报表(?: · .+)?|余额统计)$/.test(item.ui.page)
    || /^\/admin\/v1\/finance\/(?:bills|profit-statistics|collection-statistics|merchant-balance-statistics)(?:\/|$)/.test(item.path)) return '财务账单 / 利润 / 统计';
  return '';
}

export function integrationScopeCategory(item: IntegrationScopeItem): IntegrationScopeCategory {
  return integrationDeferral(item) ? '暂不联调' : '本轮联调';
}
