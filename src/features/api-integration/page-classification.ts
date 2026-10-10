/**
 * 为什么需要：工作簿的“业务/业务模块”是后端能力分类，不等于 APEX 菜单页面。
 * 边界：只标注已从本地路由与 Page 组合核对过的页面归属，不推断接口已在页面实际调用。
 * 替代方案：不覆盖原工作簿字段；公共或未定位接口保留独立归属，避免猜测路由。
 */
import type { ApexBffInterface } from '../../../shared/apex-bff-review';

export interface InterfacePage {
  module: string;
  page: string;
  route: string;
  kind: 'route' | 'shared' | 'multiple' | 'unmapped';
}

const on = (module: string, page: string, route: string): InterfacePage => ({ module, page, route, kind: 'route' });
const shared = (page: string): InterfacePage => ({ module: '公共能力', page, route: '', kind: 'shared' });
const multiple = (module: string, page: string): InterfacePage => ({ module, page, route: '', kind: 'multiple' });
const unmapped = (module: string, page: string): InterfacePage => ({ module, page, route: '', kind: 'unmapped' });

const pages: Record<string, InterfacePage> = {
  '后台用户': on('系统配置', '后台用户', '/SystemConfig/BackendUserList'),
  '角色管理': on('系统配置', '角色管理', '/SystemConfig/RoleList'),
  '商家平台账户': on('运营管理', '商家详情 · 平台账户', '/OperateManage/MerchantDetail'),
  '设备商户号管理': on('运营管理', '设备管理 · 商户号', '/OperateManage/EquipmentMonitoring'),
  '商户管理': on('运营管理', '商家管理', '/OperateManage/MerchantList'),
  '设备监控': on('运营管理', '设备管理', '/OperateManage/EquipmentMonitoring'),
  '商品管理': on('客服管理', '商品列表', '/CustomerServiceManage/ProductList'),
  '订单管理': on('运营管理', '订单管理', '/OperateManage/OrderList'),
  '付款单': on('财务管理', '付款单', '/FinancialManagement/PayOrderList'),
  '提现': on('财务管理', '提现管理', '/FinancialManagement/FinancialList'),
  '收款单': on('财务管理', '收款单', '/FinancialManagement/receipt/list'),
  '工单管理': on('工单管理', '工单管理', '/WorkOrder'),
  '消费者售后': on('客服管理', '售后工单', '/CustomerServiceManage/AfterSalesWorkOrder'),
  '商家异常单': on('客服管理', '商家工单', '/CustomerServiceManage/MerchantAbnormalOrderList'),
  '商家收费规则': on('运营管理', '商家详情 · 收费规则', '/OperateManage/MerchantDetail'),
  '商家分期计划': on('运营管理', '商家详情 · 分期计划', '/OperateManage/MerchantDetail'),
  '商家质保服务': on('运营管理', '商家详情 · 质保服务', '/OperateManage/MerchantDetail'),
  '商家功能配置': on('运营管理', '商家详情 · 功能配置', '/OperateManage/MerchantDetail'),
  '商家 API 凭证': unmapped('运营管理', '商家 API 凭证 · 待定位'),
  'POS 消息配置': on('系统配置', '错误码提示文案配置', '/SystemConfig/GlobalConfig/PosMessage'),
  '带屏设备配置': unmapped('系统配置', '带屏设备配置 · 待定位'),
  'POS报错时间': on('系统配置', 'POS 报错时间', '/SystemConfig/GlobalConfig/PosErrorTime'),
  '商品互斥': unmapped('客服管理', '商品互斥 · 待定位'),
  '点位管理': on('运营管理', '商家详情 · 点位管理', '/OperateManage/MerchantDetail'),
  '会员组管理': on('运营管理', '商家详情 · 会员组', '/OperateManage/MerchantDetail'),
  '活动管理': on('运营管理', '活动管理', '/OperateManage/ActivityList'),
  '消费用户': on('运营管理', '消费用户', '/OperateManage/UserList'),
  '利润统计': on('财务管理', '账单报表 · 利润统计', '/FinancialManagement/billStatistics'),
  '收款/服务费统计': on('财务管理', '账单报表 · 收款统计', '/FinancialManagement/billStatistics'),
  '商家余额统计': on('财务管理', '余额统计', '/FinancialManagement/BalanceStatistics'),
  '无视频工单': on('客服管理', '无视频工单', '/CustomerServiceManage/CustomerServiceWorkOrder'),
  '异常事件': on('客服管理', '异常事件管理', '/CustomerServiceManage/AbnormalEventManagement'),
  '通知公告': on('客服管理', '通知公告', '/CustomerServiceManage/AnnouncementList'),
  '模版邮件配置': on('系统配置', '邮件模板配置', '/SystemConfig/GlobalConfig/EmailTemplateConfig'),
  'APP 通知配置': on('系统配置', 'APP 通知', '/SystemConfig/GlobalConfig/AppNotifyConfig'),
  '数据监控': on('数据监控', '数据监控看板', '/DataMonitoring'),
  '工作台': on('工作台', '工作台', '/Workbench'),
  '视频教程': on('客服管理', '视频教程', '/CustomerServiceManage/VideoTutorial'),
  '验证码运营': on('客服管理', '查验证码', '/CustomerServiceManage/VerifyCodeList'),
};

const systemPages: Record<string, InterfacePage> = {
  '地址格式': on('系统配置', '地址管理', '/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=3'),
  '货币格式': on('系统配置', '货币样式', '/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=2'),
  '时间格式': on('系统配置', '日期样式', '/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=1'),
  '全局设置': on('系统配置', '平台功能设置', '/SystemConfig/GlobalConfig/PlatformSetting'),
  '国家费率规则': on('系统配置', '费用规则', '/SystemConfig/GlobalConfig/ServiceFeeConfig'),
  '国家配置': on('系统配置', '国家基础配置', '/SystemConfig/GlobalConfig/CountryBaseConfig'),
  '区域管理': on('系统配置', '地址管理', '/SystemConfig/GlobalConfig/CountryBaseAttribute?tab=3'),
  '卡 BIN 管理': on('系统配置', '卡 BIN 管理', '/SystemConfig/GlobalConfig/CardBinList'),
};

export function classifyApexInterface(item: ApexBffInterface): InterfacePage {
  if (item.module === '系统配置') return systemPages[item.pageModule] || unmapped('系统配置', `${item.pageModule} · 待定位`);
  if (item.module === '公共依赖') return shared('公共枚举 · 跨页面');
  if (item.module === '对象存储') return shared('文件上传 · 跨页面');
  if (item.module === '认证管理') return item.path.endsWith('/change-password')
    ? on('账号与权限', '修改密码', '/change-password') : on('账号与权限', '登录与会话', '/login');
  if (item.module === '商家管理') {
    if (item.path.endsWith('/users/list')) return on('运营管理', '商家详情 · 商户用户', '/OperateManage/MerchantDetail');
    if (item.path.endsWith('/create')) return on('运营管理', '新增商家', '/OperateManage/MerchantAdd');
    if (item.path.endsWith('/detail')) return on('运营管理', '商家详情', '/OperateManage/MerchantDetail');
    return on('运营管理', '商家管理', '/OperateManage/MerchantList');
  }
  if (item.module === '商家进件') return item.path.endsWith('/detail')
    ? on('运营管理', '商家进件详情', '/OperateManage/MerchantIdDetail')
    : on('运营管理', '商家进件', '/OperateManage/MerchantIdList');
  if (item.module === '账单') {
    if (item.pageModule === '账单统计') return on('财务管理', '账单报表 · 账单统计', '/FinancialManagement/billStatistics');
    if (item.pageModule === '账户余额') return on('财务管理', '余额统计', '/FinancialManagement/BalanceStatistics');
    return on('财务管理', '账单管理', '/FinancialManagement/billManagement/list');
  }
  if (item.module === '系统版本管理') return item.pageModule === '版本发布计划'
    ? on('系统配置', '发布管理', '/SystemConfig/VersionManage/VersionRelease')
    : on('系统配置', '版本管理', '/SystemConfig/VersionManage');
  if (item.module === '错误码配置') return multiple('系统配置', '预授权/扣款错误码 · 多页面');
  return pages[item.module] || unmapped('待定位模块', `${item.module} · 待定位`);
}
