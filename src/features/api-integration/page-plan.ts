/**
 * 菜单页面联调映射
 *
 * 为什么需要：接口按模块批次展示时，无法判断某个菜单页面还缺哪些接口。
 * 边界：仅把既有 OpenAPI 操作映射到本地菜单页面；无法从当前端侧路由确认归属的操作明确保留为未绑定页面。
 * 替代方案：不把联调状态复制到页面配置中，继续复用操作 ID 的唯一人工记录。
 */

export interface PlannedOperation {
  operationId: string
  method: string
  path: string
  summary: string
  contractStatus: string
  stageId: string
  stageTitle: string
}

interface PlanStage {
  id: string
  title: string
  operations: ReadonlyArray<Omit<PlannedOperation, 'stageId' | 'stageTitle'>>
}

export interface MenuPagePlan {
  id: string
  menu: string
  title: string
  routes: string[]
  operations: PlannedOperation[]
}

interface PageDefinition extends Omit<MenuPagePlan, 'operations'> {
  matches: (path: string) => boolean
}

const prefix = (value: string) => (path: string) => path.startsWith(value)

const pages: PageDefinition[] = [
  { id: 'auth', menu: '登录', title: '登录与会话', routes: ['/login'], matches: path => path.startsWith('/admin/v1/auth/') || path === '/admin/v1/users/info' },
  { id: 'backend-users', menu: '系统配置', title: '后台用户', routes: ['/SystemConfig/BackendUserList', '/SystemConfig/BackendUserAdd', '/SystemConfig/BackendUserEdit'], matches: prefix('/admin/v1/system/users/') },
  { id: 'roles', menu: '系统配置', title: '角色管理', routes: ['/SystemConfig/RoleList', '/SystemConfig/RoleAdd', '/SystemConfig/RoleEdit', '/SystemConfig/RoleDetail'], matches: prefix('/admin/v1/system/roles/') },
  { id: 'error-codes', menu: '系统配置 / 全局配置', title: '追加预授权错误码、扣款错误码', routes: ['/SystemConfig/GlobalConfig/PreAuthConfig', '/SystemConfig/GlobalConfig/DeductionFailConfig'], matches: path => path.startsWith('/admin/v1/system/error-codes/') || path === '/admin/v1/common/enums' || path === '/admin/v1/system/countries/options' },
  { id: 'country-config', menu: '系统配置 / 全局配置', title: '国家基础配置', routes: ['/SystemConfig/GlobalConfig/CountryBaseConfig'], matches: prefix('/admin/v1/system/countries') },
  { id: 'date-style', menu: '系统配置 / 全局配置', title: '日期样式', routes: ['/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=1'], matches: prefix('/admin/v1/system/time-formats') },
  { id: 'currency-style', menu: '系统配置 / 全局配置', title: '货币样式', routes: ['/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=2'], matches: prefix('/admin/v1/system/currency-formats') },
  { id: 'address-management', menu: '系统配置 / 全局配置', title: '地址管理', routes: ['/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=3'], matches: path => path.startsWith('/admin/v1/system/address-formats') || path.startsWith('/admin/v1/system/areas/') },
  { id: 'card-bins', menu: '系统配置 / 全局配置', title: '卡 BIN 配置', routes: ['/SystemConfig/GlobalConfig/CardBinList'], matches: prefix('/admin/v1/system/card-bins') },
  { id: 'card-type-restriction', menu: '系统配置 / 全局配置', title: '限制卡类型消费', routes: ['/SystemConfig/GlobalConfig/CardTypeRestriction'], matches: prefix('/admin/v1/system/card-type-restrictions') },
  { id: 'service-fees', menu: '系统配置 / 全局配置', title: '费用规则', routes: ['/SystemConfig/GlobalConfig/ServiceFeeConfig'], matches: prefix('/admin/v1/system/country-fee-rules') },
  { id: 'email-templates', menu: '系统配置 / 全局配置', title: '邮件模板配置', routes: ['/SystemConfig/GlobalConfig/EmailTemplateConfig'], matches: prefix('/admin/v1/email/') },
  { id: 'platform-setting', menu: '系统配置 / 全局配置', title: '平台设置', routes: ['/SystemConfig/GlobalConfig/PlatformSetting'], matches: path => path.startsWith('/admin/v1/system/settings/') || path.includes('/formats') || path.startsWith('/admin/v1/system/translations/') },
  { id: 'pos-message', menu: '系统配置 / 全局配置', title: 'POS 提醒', routes: ['/SystemConfig/GlobalConfig/PosMessage'], matches: path => path.startsWith('/admin/v1/system/pos-messages/') || path.startsWith('/admin/v1/system/activity-fail-node-messages/') },
  { id: 'pos-error-time', menu: '系统配置 / 全局配置', title: 'POS 报错时间', routes: ['/SystemConfig/GlobalConfig/PosErrorTime'], matches: prefix('/admin/v1/system/error-display-rules/') },
  { id: 'app-notify', menu: '系统配置 / 全局配置', title: 'APP 通知', routes: ['/SystemConfig/GlobalConfig/AppNotifyConfig', '/SystemConfig/GlobalConfig/AppNotifyConfigAdd'], matches: prefix('/admin/v1/app-notify/') },
  { id: 'versions', menu: '系统配置 / 版本管理', title: '版本与发布管理', routes: ['/SystemConfig/VersionManage', '/SystemConfig/VersionManage/POSVersionManage', '/SystemConfig/VersionManage/MainControlVersionManage', '/SystemConfig/VersionManage/AppVersionManage', '/SystemConfig/VersionManage/VersionRelease'], matches: path => path.startsWith('/admin/v1/system/versions/') || path.startsWith('/admin/v1/system/version-release-plans/') },
  { id: 'merchant', menu: '运营管理', title: '商家管理', routes: ['/OperateManage/MerchantList', '/OperateManage/MerchantDetail'], matches: path => path.startsWith('/admin/v1/merchants/') && !path.includes('/onboarding-applications/') },
  { id: 'merchant-charge-rules', menu: '运营管理', title: '商家详情 · 收费规则', routes: ['/OperateManage/MerchantDetail'], matches: prefix('/admin/v1/pricing/charge-rules/') },
  { id: 'merchant-onboarding', menu: '运营管理', title: '商户进件', routes: ['/OperateManage/MerchantIdList', '/OperateManage/MerchantIdDetail'], matches: prefix('/admin/v1/merchants/onboarding-applications/') },
  { id: 'devices', menu: '运营管理', title: '设备管理', routes: ['/OperateManage/EquipmentMonitoring'], matches: prefix('/admin/v1/devices/') },
  { id: 'orders', menu: '运营管理', title: '订单管理', routes: ['/OperateManage/OrderList'], matches: prefix('/admin/v1/orders/') },
  { id: 'activities', menu: '运营管理', title: '活动管理', routes: ['/OperateManage/ActivityList'], matches: path => path.startsWith('/admin/v1/activities/') || path.startsWith('/admin/v1/activity-trades/activities/') },
  { id: 'products', menu: '客服管理', title: '商品管理', routes: ['/CustomerServiceManage/ProductList', '/CustomerServiceManage/ExclusiveProductList'], matches: path => path.startsWith('/admin/v1/products/') || path.startsWith('/admin/v1/product-') },
  { id: 'consumer-users', menu: '运营管理', title: '消费用户', routes: ['/OperateManage/UserList', '/OperateManage/UserDetail'], matches: prefix('/admin/v1/consumer-users/') },
  { id: 'finance', menu: '财务管理', title: '收付款、账单与财务统计', routes: ['/FinancialManagement/receipt/list', '/FinancialManagement/PayOrderList', '/FinancialManagement/FinancialList', '/FinancialManagement/billStatistics', '/FinancialManagement/BalanceStatistics', '/FinancialManagement/billManagement/list'], matches: path => path.startsWith('/admin/v1/payments/') || path.startsWith('/admin/v1/finance/') || path.startsWith('/admin/v1/bills/') || path.startsWith('/admin/v1/payouts/') || path.startsWith('/admin/v1/collections/') },
  { id: 'work-orders', menu: '工单管理', title: '售后工单', routes: ['/WorkOrder', '/WorkOrder/detail'], matches: prefix('/admin/v1/work-orders/') },
  { id: 'customer-service', menu: '客服管理', title: '客服售后与异常事件', routes: ['/CustomerServiceManage/AfterSalesWorkOrder', '/CustomerServiceManage/CustomerServiceWorkOrder', '/CustomerServiceManage/AbnormalEventManagement'], matches: prefix('/admin/v1/customer-service/') },
  { id: 'data-monitoring', menu: '数据监控', title: '数据监控', routes: ['/DataMonitoring'], matches: prefix('/admin/v1/data-monitoring/') },
  { id: 'order-probe', menu: '开发工具', title: '订单探针', routes: ['/DeveloperTools/OrderProbeDashboard'], matches: prefix('/admin/v1/order-probes/') },
  { id: 'content', menu: '客服管理', title: 'APP 公告与视频教程', routes: ['/CustomerServiceManage/AnnouncementList', '/CustomerServiceManage/VideoTutorial'], matches: path => path.startsWith('/admin/v1/notifications/') || path.startsWith('/admin/v1/video-tutorials/') },
  { id: 'workbench', menu: '工作台', title: '工作台', routes: ['/Workbench'], matches: prefix('/admin/v1/workbench/') },
  { id: 'advertising', menu: '运营管理', title: '广告管理', routes: ['/OperateManage/AdManage'], matches: prefix('/admin/v1/advertising/') },
]

export function buildMenuPagePlans(stages: ReadonlyArray<PlanStage>): MenuPagePlan[] {
  const result = pages.map(({ matches: _matches, ...page }) => ({ ...page, operations: [] as PlannedOperation[] }))
  const unbound = new Map<string, MenuPagePlan>()

  for (const stage of stages) {
    for (const operation of stage.operations) {
      const item: PlannedOperation = { ...operation, stageId: stage.id, stageTitle: stage.title }
      const matched = result.filter(page => pages.find(definition => definition.id === page.id)?.matches(item.path))
      if (matched.length > 0) {
        matched.forEach(page => page.operations.push(item))
        continue
      }

      const resource = item.path.split('/').slice(3, 5).join('/') || item.path
      const id = `unbound-${stage.id}-${resource.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      const page = unbound.get(id) ?? { id, menu: '未绑定本地菜单', title: resource, routes: [], operations: [] }
      page.operations.push(item)
      unbound.set(id, page)
    }
  }

  return [...result.filter(page => page.operations.length > 0), ...unbound.values()]
}
