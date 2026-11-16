/**
 * 设计说明：已撤销的 Admin 交付不能被历史队列重新建立；执行、领取与 Jira 共用同一边界。
 * 这里只记录用户确认的 Admin 排除，不删除外部端业务需求、冻结事实或历史状态。
 * 不修改历史 JSON 的状态，以免把范围撤销误记为完成或丢失审计记录。
 */
export function catchupAdminExclusionReason(requirementId) {
  switch (requirementId) {
    case "REQ-004":
      return "已移出 Admin 交付：GBP-589 / MR !68 的消费邮件税费由消费者邮件链路负责；Admin 模板样例预览不等于实际邮件交付，仅保留既有契约与审计历史。";
    case "REQ-005":
      return "已移出 Admin 交付：保留外部 App/BFF 业务需求与审计历史，不再自动处理误建的 GBP-590 / MR !77。";
    case "REQ-006":
      return "已移出 Admin 交付：GBP-591 / MR !69 的扫码填邮箱与账单邮件由消费者 H5、订单服务/BFF 负责；未接入的端口函数不等于邮件链路交付，保留业务需求与历史。";
    case "REQ-009":
      return "已移出 Admin 交付：GBP-592 / MR !30 的登录冻结属于商家 App/PC 与鉴权服务；Admin 登录的客户端计数不等于商家跨端冻结，保留业务需求与历史。";
    case "REQ-012":
      return "已移出 Admin 交付：GBP-593 / MR !35 的六天离线消息重发属于 POS/消息服务；Admin 重推扣款防重与 REQ-003 重叠，不能算六天重发实现，保留契约回归与历史。";
    case "REQ-013":
      return "已移出 Admin 交付：GBP-594 / MR !33 的预授权释放补偿属于活动交易/收付服务；未调用的资格函数不执行取消预授权，仅保留状态契约与历史。";
    case "REQ-021":
      return "已移出 Admin 交付：GBP-595 / MR !80 的澳大利亚、新西兰刷卡提示属于 POS 首页/BFF；Admin POS 通知与配置导航不等于该终端策略，保留业务需求与历史。";
    case "REQ-026":
      return "已移出 Admin 交付：GBP-596 / MR !79 的条件菜单属于商家 App/PC/BFF；Admin 动态路由测试与责任注释不等于商家菜单实现，保留契约回归与历史。";
    default:
      return "";
  }
}

export function catchupAdminScopeReviewReason(requirementId) {
  return requirementId === "REQ-016"
    ? "交付范围待复核：GBP-555 / MR !78 的原始余额展示增量与 REQ-019 / GBP-559 / MR !39 重复，不代表 Adyen 分账完成；保留需求、Git 与审核历史，暂停仅凭 Git 已包含自动同步 Jira 完成。"
    : "";
}
