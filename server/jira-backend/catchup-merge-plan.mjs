import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { catchupAdminExclusionReason, catchupAdminScopeReviewReason } from "./catchup-admin-scope.mjs";

/**
 * 设计说明：合入计划是交付编排元数据，不属于 Jira 事实，也不代表 Codex 执行完成。
 * 本模块只读 Git 引用判断分支是否已进入统一目标分支，并把既有追平事实中的功能范围与验收点拼成自测说明。
 * 所有已有独立交付分支和 MR 的需求均进入逐项审计；缺少业务数据或外部服务只允许局部 N/A，
 * 页面接线、交互和可由冻结 Demo 证明的业务规则缺口仍须修复。不使用 GitLab 写接口、不修改工作树。
 */

const execFileAsync = promisify(execFile);

export const CATCHUP_MERGE_TARGET_BRANCH = "feature/sync-demo-apex-master";
export const CATCHUP_GITLAB_PROJECT_URL = "https://gitlab.hahabianli.com/titan-project/titan-fe-project/ops/admin";
export const DEFAULT_CATCHUP_MERGE_REPOSITORY = path.join(homedir(), "Desktop", "apex admin", "admin");

function ready(
  requirementId,
  jiraKey,
  mrIid,
  order,
  slug,
  testPages,
  testFocus,
  conflictArea = "",
  verificationMode = "browser"
) {
  const exclusionReason = catchupAdminExclusionReason(requirementId);
  return {
    requirementId,
    jiraKey,
    mrIid,
    order,
    decision: exclusionReason ? "HOLD" : "READY",
    sourceBranch: `feature/${jiraKey}/${slug}`,
    testPages,
    testFocus,
    conflictArea,
    verificationMode,
    decisionNote: exclusionReason || "按计划顺序合入；前一项通过自测后再处理本项。"
  };
}

export const CATCHUP_MERGE_PLAN = [
  ready("REQ-030", "GBP-579", 63, 1, "country-region", ["系统配置 → 国家基础配置"], "编辑国家区域并保存，刷新后确认区域与国家筛选使用同一映射。", "国家基础配置：GBP-573、GBP-565"),
  ready("REQ-029", "GBP-573", 46, 2, "country-warranty", ["系统配置 → 国家基础配置"], "新增或编辑国家质保期，保存并刷新，确认列表与编辑回显一致。", "国家基础配置：GBP-579、GBP-565"),
  ready("REQ-010", "GBP-550", 75, 3, "double-door-mode", ["运营管理 → 设备监控 → 设备详情"], "在双门柜详情切换开门模式，保存后重新进入详情核对回显与按钮能力。", "设备详情：GBP-551、GBP-586"),
  ready("REQ-024", "GBP-586", 67, 4, "dual-temperature", ["运营管理 → 设备管理 → 设备详情 → 远程温控"], "分别设置左右门温度，确认校验、提交参数和详情回显互不串门。", "设备详情：GBP-550、GBP-551"),
  ready("REQ-CU-002", "GBP-574", 58, 5, "device-reliability", ["运营管理 → 设备监控"], "切换可靠性指标与筛选条件，核对表格字段、状态映射与导出数据。", "设备监控：GBP-571"),
  ready("REQ-028", "GBP-571", 57, 6, "warranty-filter", ["运营管理 → 设备监控"], "分别选择质保内、质保外与全部，确认请求参数、列表结果和重置行为。", "设备监控：GBP-574"),
  ready("REQ-CU-013", "GBP-562", 72, 7, "payment-refund", ["财务管理 → 支付订单列表", "支付订单详情"], "跨页勾选支付订单，验证批量退款、标记已支付、部分失败提示与失败明细。", "支付订单：GBP-597"),
  ready("REQ-CU-014", "GBP-588", 31, 8, "profit-cost-allocation", ["财务管理 → 利润统计"], "打开成本分摊与状态抽屉，核对筛选、金额字段、状态映射和详情数据。"),
  ready("REQ-CU-007", "GBP-582", 66, 9, "charge-rule-import", ["商户详情 → 服务费规则 → 批量导入"], "上传合法与非法文件，核对校验、上传结果、错误明细和导入后列表刷新。", "商户详情：GBP-580、GBP-584、GBP-587"),
  ready("REQ-017", "GBP-557", 70, 10, "installment-auto-debit", ["账单管理 → 商户月账单详情 → 创建付款"], "创建自动扣款付款单，核对余额、金额边界、提交结果和账单详情刷新。", "月账单：GBP-563"),
  ready("REQ-CU-016", "GBP-563", 40, 11, "monthly-bill-fees", ["系统配置 → 平台设置", "账单管理 → 商户月账单"], "核对费项配置、优惠字段与账单展示，保存后刷新并复查批量优惠口径。", "月账单：GBP-557"),
  ready("REQ-004", "GBP-589", 68, 12, "receipt-tax", ["消费者邮件链路，无新增 Admin 入口"], catchupAdminExclusionReason("REQ-004")),
  ready("REQ-CU-001", "GBP-561", 76, 13, "order-probe", ["开发者工具 → 订单探针"], "用有效与无效订单号查询链路，核对节点状态、诊断详情、刷新和错误提示。"),
  ready("REQ-CU-004", "GBP-572", 52, 14, "offline-version-test", ["数据监控 → 离线版本测试"], "创建测试任务并查看指标抽屉，核对筛选、状态流转、刷新与重复提交保护。", "数据监控路由：GBP-575、GBP-576、GBP-597"),
  ready("REQ-CU-003", "GBP-575", 59, 15, "video-observability", ["数据监控 → 视频上传质量"], "切换时间和维度筛选，核对质量指标、异常明细、空态与错误态。", "数据监控路由：GBP-572、GBP-576、GBP-597"),
  ready("REQ-CU-005", "GBP-576", 60, 16, "algorithm-recognition", ["数据监控 → 算法识别质量"], "切换指标与筛选条件，核对识别率、趋势、明细和数据监控 Tab 跳转。", "数据监控路由：GBP-572、GBP-575、GBP-597"),
  ready("REQ-CU-018", "GBP-597", 32, 17, "payment-confirming-order-drilldown", ["数据监控总览 → 支付确认中下钻"], "点击指标进入订单下钻，核对列、分页、活动详情关联、空态与返回行为。", "数据监控路由：GBP-572、GBP-575、GBP-576；支付订单：GBP-562"),
  ready("REQ-020", "GBP-560", 38, 18, "card-type-restriction", ["系统配置 → 全局配置 → 卡类型限制"], "新增、编辑、删除限制规则，核对卡类型互斥、保存、刷新与权限控制。", "系统配置路由：GBP-583"),
  ready("REQ-CU-015", "GBP-583", 48, 19, "pos-error-rules", ["系统配置 → 全局配置 → POS 错误时长"], "新增和编辑错误规则，核对时长边界、错误码关联、保存与列表刷新。", "系统配置路由：GBP-560"),
  ready("REQ-CU-008", "GBP-553", 54, 20, "merchant-switches", ["运营管理 → 商户详情 → 功能配置"], "逐项切换商户功能开关，保存后刷新，确认开关互不覆盖且失败时回滚。", "商户功能配置：GBP-555、GBP-559、GBP-568"),
  ready("REQ-019", "GBP-559", 39, 21, "adyen-balance-display", ["运营管理 → 商户详情 → 功能配置"], "仅核对 Admin 的 Adyen 余额展示开关：保存、刷新和接口回显；App 端不作为本 MR 自测通过条件。", "商户功能配置：GBP-553、GBP-555、GBP-568"),
  ready("REQ-CU-019", "GBP-585", 50, 22, "merchant-operations-profile", ["运营管理 → 商户列表"], "搜索并筛选商户，核对客户体量、突破阶段字段、排序、空值和分页。", "商户字段：GBP-580、GBP-581、GBP-587"),
  ready("REQ-CU-021", "GBP-587", 47, 23, "merchant-payout-entity-confirmation", ["运营管理 → 商户详情 → 打款主体确认"], "查看确认记录并执行允许的确认操作，核对状态、时间、操作者与刷新结果。", "商户详情：GBP-580、GBP-582、GBP-584"),
  ready("REQ-CU-020", "GBP-584", 51, 24, "merchant-email-suppression", ["运营管理 → 商户详情 → 邮箱抑制状态"], "查看抑制状态并执行解除，核对按钮条件、提交反馈和详情刷新。", "商户详情：GBP-580、GBP-582、GBP-587"),
  ready("REQ-031", "GBP-580", 64, 25, "merchant-smtp", ["运营管理 → 商户新增/编辑 → SMTP 配置"], "验证加密方式、端口和必填校验；保存后重新编辑，确认密钥掩码与配置回显。", "商户详情：GBP-582、GBP-584、GBP-587"),
  ready("REQ-CU-012", "GBP-549", 71, 26, "order-query-refresh-export", ["运营管理 → 订单列表"], "执行查询、重置、实时刷新与导出，核对分页条件、导出列、错误提示和重复请求。", "订单管理：GBP-554、GBP-564"),
  ready("REQ-027", "GBP-566", 41, 27, "activity-price-snapshot", ["运营管理 → 活动列表 → 活动详情", "运营管理 → 订单列表 → 活动摘要", "无视频工单详情"], "依次打开价格、模板和预授权快照，核对快照时点、字段、空值和多入口一致性。", "活动详情：GBP-558、GBP-567、GBP-568、GBP-570"),
  ready("REQ-003", "GBP-554", 34, 28, "deduction-repush", ["运营管理 → 订单列表", "活动详情 → 订单操作"], "对允许与禁止的订单执行重推扣款，核对按钮条件、金额、幂等和结果刷新。", "订单管理：GBP-549、GBP-564"),
  ready("REQ-CU-017", "GBP-564", 44, 29, "adyen-manual-retry", ["运营管理 → 订单列表", "运营管理 → 活动详情", "无视频工单详情"], "从三个入口执行人工重试，核对允许条件、提交参数、重复点击保护和状态刷新。", "订单/活动：GBP-549、GBP-554、GBP-566"),
  ready("REQ-CU-011", "GBP-570", 73, 30, "activity-failure-node", ["运营管理 → 活动详情 → 失败节点", "系统管理 → 通知配置 → POS 消息"], "查看失败节点并调整诊断配置，核对状态映射、保存、刷新和异常节点展示。", "活动详情：GBP-558、GBP-566、GBP-567、GBP-568"),
  ready("REQ-014", "GBP-558", 56, 31, "nayax-callback", ["运营管理 → 活动列表 → 活动详情"], "构造重复与正常 Nayax 回调结果，核对详情状态不重复推进且展示口径一致。", "活动详情：GBP-566、GBP-567、GBP-568、GBP-570"),
  ready("REQ-CU-010", "GBP-567", 45, 32, "work-order-claim", ["客服中心 → 工单列表/详情", "运营管理 → 活动详情"], "认领工单并关联客户，核对并发认领、状态刷新、详情跳转和活动关联。", "活动详情：GBP-558、GBP-566、GBP-568、GBP-570"),
  ready("REQ-CU-009", "GBP-551", 49, 33, "preauth-history", ["运营管理 → 设备监控 → 设备详情", "运营管理 → 活动详情"], "查看预授权快照与变更历史，核对时间顺序、操作者、前后值和跨入口一致性。", "设备详情：GBP-550、GBP-586；活动详情：GBP-566"),
  ready("REQ-007", "GBP-568", 74, 34, "top10-control", ["运营管理 → 活动详情 → Top10", "运营管理 → 商户详情 → 功能配置"], "切换商户开关并验证 Top10 互斥校验、标识、活动详情展示和刷新回显。", "商户功能配置：GBP-553、GBP-559；活动详情：GBP-566、GBP-570"),
  ready("REQ-023", "GBP-565", 43, 35, "screen-advertising", ["运营管理 → 广告投放", "系统配置 → 国家基础配置"], "创建广告并选择素材、商户与国家范围，核对校验、提交、列表状态和国家能力标识。", "国家基础配置：GBP-579、GBP-573；运营路由为本批最后合入"),

  ready("REQ-021", "GBP-595", 80, 36, "au-no-card", ["澳大利亚/新西兰 POS 首页，无新增 Admin 入口"], catchupAdminExclusionReason("REQ-021")),
  ready("REQ-026", "GBP-596", 79, 37, "merchant-menu", ["商家 App/PC 条件菜单，无新增 Admin 入口"], catchupAdminExclusionReason("REQ-026")),
  {
    ...ready("REQ-016", "GBP-555", 78, 38, "adyen-split", ["Admin 分账相关配置范围待复核"], "保留 Adyen 分账需求并复核真实 Admin 子范围：原始 MR !78 的 adyen_balance_display 三处增量与 REQ-019 / GBP-559 / MR !39 重复，不能据此认定分账完成；不要重做余额展示开关或把分账责任转给 Admin。", "商户功能配置：GBP-553、GBP-559、GBP-568"),
    alreadyMerged: true,
    decisionNote: "用户于 2026-09-14 确认 GBP-555 / MR !78 已合入统一目标分支；保留 Git、自测与审核历史，不再纳入待处理。"
  },
  ready("REQ-005", "GBP-590", 77, 39, "abnormal-product-template", ["外部 App/BFF 责任，无新增 Admin 页面"], catchupAdminExclusionReason("REQ-005")),
  ready("REQ-006", "GBP-591", 69, 40, "receipt-email", ["消费者 H5/订单服务/BFF，无新增 Admin 入口"], catchupAdminExclusionReason("REQ-006"), "", "code-only"),
  ready("REQ-CU-006", "GBP-581", 65, 41, "installment-discount", ["商户详情 → 分期方案新增/编辑"], "对比冻结 Demo 还原零首付、购买折扣、指标字段组合校验、保存和编辑回显；无可用分期数据时局部记 N/A。", "商户字段：GBP-580、GBP-585"),
  ready("REQ-025", "GBP-578", 62, 42, "user-system-v2", ["运营管理 → 活动列表", "运营管理 → 订单列表"], "对比冻结 Demo 还原 UID 查询、Payment 管理、身份字段和兼容展示；缺少新旧用户样本时局部记 N/A。", "活动/订单字段"),
  ready("REQ-008", "GBP-577", 61, 43, "abnormal-preprocess", ["运营管理 → 异常单预处理"], "冻结事实未定位 Demo 页面、接口或服务端菜单权限；核对当前分支 Page/Feature、授权门槛、商品库必选、四类场景与缓存失效，正式菜单、接口及跨系统执行链路记为后续待验证。", "运营路由", "code-only"),
  ready("REQ-011", "GBP-552", 55, 44, "hk-qr-payment", ["运营管理 → 订单列表"], "对比冻结 Demo 补齐香港扫码支付映射、筛选、列表和详情展示；缺少香港支付订单样本时局部记 N/A。", "订单管理：GBP-549、GBP-554、GBP-564"),
  ready("REQ-018", "GBP-556", 53, 45, "adyen-second-deduction", ["运营管理 → 订单列表", "运营管理 → 活动详情"], "以冻结 Demo 确认二次扣款与人工重试边界并还原可证明入口、条件、金额和状态刷新；真实扣款场景按安全与数据规则记 N/A。", "订单/活动：GBP-564"),
  ready("REQ-022", "GBP-569", 42, 46, "pin-member-groups", ["会员营销 → 积分/会员组管理"], "对比冻结 Demo 补齐 PIN 设备分组、会员组展示与增删改页面闭环；缺少可操作会员数据时局部记 N/A。"),
  ready("REQ-012", "GBP-593", 35, 47, "offline-message-retry", ["POS/消息服务，无新增 Admin 入口"], catchupAdminExclusionReason("REQ-012")),
  ready("REQ-013", "GBP-594", 33, 48, "preauth-release", ["活动交易/收付服务，无新增 Admin 入口"], catchupAdminExclusionReason("REQ-013")),
  ready("REQ-009", "GBP-592", 30, 49, "merchant-login-freeze", ["商家 App/PC 鉴权服务，不是 Admin 登录"], catchupAdminExclusionReason("REQ-009"))
];

export function validateCatchupMergePlan(plan = CATCHUP_MERGE_PLAN) {
  const requirementIds = new Set(plan.map((item) => item.requirementId));
  const jiraKeys = new Set(plan.map((item) => item.jiraKey));
  const mrIids = new Set(plan.map((item) => item.mrIid));
  const orders = plan.filter((item) => item.order != null).map((item) => item.order).sort((a, b) => a - b);
  const expectedOrders = Array.from({ length: orders.length }, (_, index) => index + 1);
  return {
    valid: plan.length === 49
      && requirementIds.size === plan.length
      && jiraKeys.size === plan.length
      && mrIids.size === plan.length
      && JSON.stringify(orders) === JSON.stringify(expectedOrders),
    total: plan.length,
    ready: plan.filter((item) => item.decision === "READY").length,
    hold: plan.filter((item) => item.decision === "HOLD").length,
    orders
  };
}

function parseRefLines(output) {
  return new Map(String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/, 2);
      return [ref, sha];
    })
    .filter(([ref, sha]) => ref && sha));
}

async function runGit(repositoryPath, args, { allowExitCodeOne = false, timeout = 15_000 } = {}) {
  try {
    const result = await execFileAsync("/usr/bin/git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout
    });
    return { ok: true, output: String(result.stdout || "").trim() };
  } catch (error) {
    if (allowExitCodeOne && error.code === 1) return { ok: false, output: "" };
    throw error;
  }
}

let cachedGitEvidence = null;
let cachedGitEvidenceAt = 0;

async function readGitEvidence(repositoryPath, { force = false } = {}) {
  const now = Date.now();
  if (!force && cachedGitEvidence && now - cachedGitEvidenceAt < 60_000) return cachedGitEvidence;

  const [localRefsResult, remoteRefsResult] = await Promise.all([
    runGit(repositoryPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin"]),
    runGit(repositoryPath, ["ls-remote", "--heads", "origin"], { timeout: 20_000 }).catch(() => ({ ok: false, output: "" }))
  ]);
  const localRefs = parseRefLines(localRefsResult.output);
  const remoteRefs = parseRefLines(remoteRefsResult.output);
  const targetRef = `refs/remotes/origin/${CATCHUP_MERGE_TARGET_BRANCH}`;
  const remoteTargetRef = `refs/heads/${CATCHUP_MERGE_TARGET_BRANCH}`;
  const targetLocalSha = localRefs.get(targetRef) || "";
  const targetRemoteSha = remoteRefs.get(remoteTargetRef) || "";

  const mergedBranches = new Set();
  await Promise.all(CATCHUP_MERGE_PLAN.map(async (item) => {
    const sourceRef = `refs/remotes/origin/${item.sourceBranch}`;
    const sourceSha = localRefs.get(sourceRef);
    if (!sourceSha || !targetLocalSha) return;
    const result = await runGit(
      repositoryPath,
      ["merge-base", "--is-ancestor", sourceSha, targetLocalSha],
      { allowExitCodeOne: true }
    );
    if (result.ok) mergedBranches.add(item.sourceBranch);
  }));

  cachedGitEvidence = {
    checkedAt: new Date().toISOString(),
    localRefs,
    remoteRefs,
    remoteChecked: Boolean(targetRemoteSha),
    targetLocalSha,
    targetRemoteSha,
    targetFresh: Boolean(targetRemoteSha) && targetRemoteSha === targetLocalSha,
    mergedBranches
  };
  cachedGitEvidenceAt = now;
  return cachedGitEvidence;
}

export function buildCatchupMergeDashboard(board, evidence) {
  const requirements = new Map((board?.requirements || []).map((item) => [item.id, item]));
  const items = CATCHUP_MERGE_PLAN.map((planItem) => {
    const requirement = requirements.get(planItem.requirementId) || {};
    const jiraUrl = requirement.session?.jiraUrl || "";
    const localSourceRef = `refs/remotes/origin/${planItem.sourceBranch}`;
    const remoteSourceRef = `refs/heads/${planItem.sourceBranch}`;
    const merged = planItem.alreadyMerged === true || evidence.mergedBranches.has(planItem.sourceBranch);
    const sourceRemotePresent = evidence.remoteRefs.has(remoteSourceRef);
    let status = planItem.decision === "HOLD" ? "HOLD" : "READY";
    if (planItem.decision !== "HOLD") {
      if (merged) status = "MERGED";
      else if (evidence.remoteChecked && !sourceRemotePresent) status = "VERIFY";
    }

    return {
      ...planItem,
      scopeReviewNote: planItem.alreadyMerged ? "" : catchupAdminScopeReviewReason(planItem.requirementId),
      title: requirement.title || planItem.jiraKey,
      functionSummary: [requirement.goal || requirement.title || "待补充功能范围", planItem.alreadyMerged ? "" : catchupAdminScopeReviewReason(planItem.requirementId)].filter(Boolean).join("；"),
      sessionWorkspacePath: requirement.session?.workspacePath || "",
      deliveryWorkspacePath: requirement.session?.workspacePath
        ? path.join(path.dirname(requirement.session.workspacePath), "delivery-admin")
        : "",
      acceptanceCriteria: (requirement.acceptanceCriteria || []).map((item) => ({
        id: item.id,
        text: item.text,
        url: item.url || jiraUrl
      })),
      factPages: requirement.architecturePlacement?.pages || [],
      status,
      merged,
      sourceLocalSha: evidence.localRefs.get(localSourceRef) || "",
      sourceRemoteSha: evidence.remoteRefs.get(remoteSourceRef) || "",
      mrUrl: `${CATCHUP_GITLAB_PROJECT_URL}/-/merge_requests/${planItem.mrIid}`,
      jiraUrl,
      sourceBranchUrl: sourceRemotePresent
        ? `${CATCHUP_GITLAB_PROJECT_URL}/-/commits/${encodeURIComponent(planItem.sourceBranch)}`
        : ""
    };
  });
  const merged = items.filter((item) => item.status === "MERGED").length;
  const holdCount = items.filter((item) => item.status === "HOLD").length;
  const readyCount = items.filter((item) => item.status === "READY").length;
  const verifyCount = items.filter((item) => item.status === "VERIFY").length;

  return {
    source: {
      checkedAt: evidence.checkedAt,
      remoteChecked: evidence.remoteChecked,
      targetFresh: evidence.targetFresh
    },
    target: {
      branch: CATCHUP_MERGE_TARGET_BRANCH,
      url: `${CATCHUP_GITLAB_PROJECT_URL}/-/commits/${encodeURIComponent(CATCHUP_MERGE_TARGET_BRANCH)}`,
      localSha: evidence.targetLocalSha,
      remoteSha: evidence.targetRemoteSha
    },
    summary: {
      total: items.length,
      merged,
      ready: readyCount,
      hold: holdCount,
      verify: verifyCount,
      progressPercent: items.length ? Math.round((merged / items.length) * 100) : 0
    },
    mergeRules: [
      "所有需求只合入 feature/sync-demo-apex-master，不直接合入 prod。",
      "严格按序号逐项处理；每项完成自动检查、可验证的功能逻辑与样式自测和 Chrome 截图。缺少业务数据、无法安全触发失败场景或外部 API/CORS/网络失败，可逐项说明理由并标记 N/A；登录/认证截图、页面不可达或交付分支缺少页面接线不能算功能证据，须恢复登录态或修复代码后重测。单项阻塞不占并发名额，也不得阻塞其他需求。",
      "每轮最多并行 8 个独立需求 task；正常流程须先自测并由用户审核截图、点击“确认通过”，才进入合入/提交/推送阶段。特殊环境无法自测时，用户可填写原因并二次确认“例外直接合入”，仅授权指定源 SHA，保留失败与未验证记录，不计自测通过，也不自动完成 Jira；Git 冲突与远端交付校验仍须完成。Git 已包含提交、Codex turn 结束或一次测试命令成功都不等于审核通过。",
      "有冲突时先把最新目标分支合入源分支，保留目标分支已有语义，再重放本需求增量；禁止整文件覆盖。",
      "保留全部 49 项审计记录，其中 41 项进入 Admin 交付；REQ-004/005/006/009/012/013/021/026 共 8 项已移出 Admin 交付，外部业务需求与历史保留。REQ-016 已由用户确认 Git 已合入，保留分账范围复核、Git、自测和审核历史，不再进入待处理或自动完成 Jira；REQ-028 保留既有质保筛选回归。冻结 Demo 可证明的页面、交互和业务规则缺口必须修复；缺少业务数据、外部服务或其他责任端运行证据时，可对对应局部用例说明理由并标记 N/A。"
    ],
    items
  };
}

export async function readCatchupMergeDashboard(board, {
  repositoryPath = process.env.APEX_CATCHUP_MERGE_REPOSITORY || DEFAULT_CATCHUP_MERGE_REPOSITORY,
  force = false
} = {}) {
  const validation = validateCatchupMergePlan();
  if (!validation.valid || validation.ready !== 41 || validation.hold !== 8) {
    throw new Error("INVALID_CATCHUP_MERGE_PLAN");
  }
  const evidence = await readGitEvidence(repositoryPath, { force });
  return buildCatchupMergeDashboard(board, evidence);
}
