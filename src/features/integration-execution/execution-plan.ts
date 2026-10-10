/**
 * 设计说明：执行计划沿用菜单、负责人和已有现场台账，运行交给工作台原有 Agent 队列。
 * 这里只定义授权范围和回测基线，不发请求、不复制执行器；人工审核与自动检查各自保留。
 */
import type { AgentRun, AgentRuntimeHealth, StartAgentRunInput } from '../../../shared/agent-runtime';
import { workbenchRuntime } from '../../../shared/agent-runtime';
import { reviewLabel, type ApexBffReviewState } from '../../../shared/apex-bff-review';
import { integrationDeferral, integrationScopeCategory, type IntegrationScopeCategory } from '../../../shared/apex-integration-scope';
import type { ReviewCatalogItem } from '../api-integration/review-catalog';

export const executionMarker = '[工作台联调自动执行]';
export const progressUrl = '/integration-runs/execution-plan.json';
// 由自动执行计划和正在运行的会话补充要求共用，避免新旧批次采用不同反馈规则。
export const integrationFeedbackInstructions = `按用户已授权的联调及群反馈范围执行。先排除网络原因，对经真实请求和页面确认的问题登记唯一问题ID。群里只推送需要后端修复的问题，以及核实后需要后端补测试数据或确认权限的阻塞；前端问题自行修复并回测，仅更新工作台，不首发、不补图、不发修复或回测群通知。取得同次页面上下文及原生Network截图后及时反馈，不等整批结束。缺图先记工作台为“待采集页面上下文和Network截图，未推送”。未实际调用的业务接口不能声称都失败。
判定以真实页面能否完成预期功能为准，不能只检查接口是否报错。列表需要检查默认查询、页面实际支持的单项筛选、重置和分页，记录操作前后真实参数及返回差异。前端没传参数、参数类型或字段映射错误先自行修复；参数符合最新契约但筛选不生效、返回不相关记录、分页排序不正确，属于需反馈的后端问题。HTTP200也要检查必填字段、类型、值、接口文案和实际页面，不符合契约不能通过。
下拉问题必须先从具体控件的绑定变量沿composable/query、API和mapper查明真实数据源、参数及响应字段，再用该页面同次Network和最新契约核对；不能根据页面名称套用列表接口，也不能凭下拉形式猜测独立选项接口。来源未证实先记“待核对数据源，未推送”；前端漏调选项接口、读错字段或未绑定先自行修复回归，来源已证实而返回不符合约定才反馈该源接口。工作台保留源文件、函数及字段消费链；群消息“请求”写实际选项源接口，“实际”写对应完整响应字段路径及值，让截图控件与接口一一对应。
默认列表无可用测试数据、缺详情关联ID或缺必要页面权限，核对地区、筛选、分页和账号权限后仍无法验收时，登记“联调阻塞／需补测试数据”或“联调阻塞／需确认权限”，说明所缺具体样本和受影响功能，取得空列表或实际入口关键截图后也必须反馈，不能只写台账后结束。合理空列表不直接判为后端缺陷；缺数据阻断验证仍不是通过。未调用的目标接口注明未调用，引用实际入口请求证明阻塞；不猜ID、不绕过权限、不造数据。同一个已证实数据或权限原因阻塞多个接口时作为一个独立问题关联这些接口，不伪造各接口失败。前端问题自行修复回归，仅更新工作台；后端问题和数据准备阻塞分别配图反馈。
网络问题不推送群消息：断网、DNS/TLS/连接失败、VPN/代理连通性、网络超时或请求取消导致的问题只记工作台台账，notification写“不推送：网络问题，仅台账记录”，不首发、不补发、不补图、不发恢复或回测群通知。没有取得真实HTTP或业务响应、原因尚不能区分网络与接口缺陷时，先记网络/环境待定位，不发群；恢复网络后正常复验，确认接口本身有独立缺陷才按新事实反馈。不能仅凭超时、net::ERR或代理网关连接错误认定后端接口失败；真实接口返回的400/404/业务错误或字段缺失，不因它是请求异常就一概排除。已发送的历史网络消息保留原回执，不重发也不宣称撤回。
每个问题单独一条消息、一个问题ID、一份描述及独立回执；同一个接口有多个可独立修复和验收的问题，也必须分别登记、分别发送，不能按接口、页面或模块合并成一条汇总。每条只描述该问题的影响、实际结果和预期，不把其他问题顺带写入；截图和后续修复/回测结论沿用该问题ID。重复观察到同一问题不新建ID、不重复首发。
消息重点沿用用户参考图的行内代码样式：用反引号突出1至3处后端需关注的异常字段/值及具体处理要求，例如“实际：HTTP200/code1000；\`data.externalIntegration 缺失\`，页面配置无法确认”“预期：后端请\`补齐 externalIntegration 的真实配置\`，前端按返回展示”。接口字段、L码、message及值原样保留，不把整条请求或整段正文全部高亮，不为染色改写返回。markdown_v2官方不支持font颜色语法，使用客户端自身的行内代码显示（参考客户端呈红字灰底，其他客户端颜色不能保证），禁止font/span/CSS伪造指定红色。前端参数或映射错误仍由Agent修复，不能标成后端待处理；已修复问题不重复首发。
原生Network配图：后端问题发群前由Agent自己打开真实Chrome DevTools → Network，先确认原生窗口URL及账号属于本会话，再用页面正常操作触发请求，选中对应实际数据源的同一次请求。截图必须保留页面导航或页签、相关筛选/表头及问题区域，让同事一眼识别页面；Network同时保留请求列表中的选中行及详情面板。参数问题截Payload/Query String Parameters，返回问题截Response/Preview，必要时补Headers中的URL、方法和状态。可以同框，也可将完整页面与对应Network详情分别内嵌同一条消息，不能只截一个输入框、字段或一小块返回。页面问题位置与Network异常字段/状态用红色空心框标注；仅加框和敏感信息遮盖，保留原图，不改写真实页面、请求或返回。截图中的接口、参数、返回和traceId必须与正文一致。不能使用Console报错、CDP/JSON/HTML生成图或别的请求代替原生Network，不能把报告截图当作原生Network图发群。输入或取图失败时释放自己的短锁并记录具体原因，继续本标签网页核验；缺合格原生Network图时不发群，不写已采集，也不让用户代为打开控制台。
每条文案固定为5至6行：首行“问题ID｜页面：具体异常”；“请求：GET /实际路径?必要实际参数（脱敏）”；“实际：HTTP/code＋与问题直接相关的真实返回片段（字段名、值或缺失字段）＋页面影响”；“预期：具体预期结果”；“traceId：实际链路编号”，必要时加一行“参数：关键上下文头或Body＋采集时间”。请求路径、参数、关键返回、预期和问题点截图必须直接放在同一条群消息里，让同事不用打开链接也能核对；不放证据/报告链接，不写“见链接”“详见报告”代替事实，HTML/JSON和原始详细记录仅留工作台。发送器会拦截正文链接、缺失上述字段或过长的结构。文案针对配图中的具体缺陷，先说页面影响，再给接口事实；不发启动通知、普通进度、成功接口记录或截图通道验证，不能把这些当作问题反馈。内嵌截图地址使用 automation.evidenceBaseUrl 配置的可访问地址，只用于消息内展示图片，不作为正文证据链接。每条消息仅对应一个独立问题，不@，不发测试或占位消息，不把所有说明画进图里。5个会话共用机器人，各会话每条至少间隔15秒；限流失败记录通知状态，不死循环重试。
截图是发群的硬性前提，采用页面上下文截图加对应原生Network截图，通常1至2张、最多3张，同条内嵌。原生Chrome DevTools Network截图必须取自真实控制台。每张图保留能识别页面及问题的上下文：页面名/导航或页签、相关表头或筛选、异常区域；Network保留选中请求行和Headers/Payload/Response等相关详情。可以截完整可见视口或适度裁剪，但不裁掉页面身份，不只发关键局部图，不将整页缩成不可读小图。用红色空心框框选具体问题点，原图与标注图都留工作台；只添加框与脱敏遮盖，不重绘、不改写、不用AI重建证据。各会话按自己的tabId、隔离账号及域名并行核验和网页截图，原生窗口操作仅短时间协调。使用同批次、页面URL、requestId/traceId及采集时间关联图文，不能用旧图、成功页或独立curl/API调用冒充本次问题现场。截图前折叠或遮盖Authorization/Cookie、密码、Token和私人联系方式；网络失败、无真实响应、页面未验证或截图串页均不合格。
网页操作和CDP网页截图不需要共享锁：创建本会话专属标签页、导航、正常登录、页面菜单/筛选和请求核对均按标签页目标并行，不得因其他会话持原生锁而等待。每次先核对自己的tabId、URL及页面账号，使用tab.playwright的定位器click/fill等页面操作与本标签受支持的cdp能力；避免桌面坐标、系统剪贴板、原生快捷键和Page.bringToFront，不切换其他会话的标签。截图直接对本标签调用Page.captureScreenshot（format=png、fromSurface=true、captureBeyondViewport=true，clip从真实DOM矩形读取），不截当前前台窗口；即使其他标签在前台也必须得到自己页面的图。请求事件也只监听本标签CDP目标，不读取其他会话事件。并行操作后重新读取本标签DOM并核对账号、URL、问题元素与截图；错页、串图或白图不发布。沿用原批次证据和回执，不因取消网页排队重跑已完成检查或重发群消息。
仅操作原生桌面鼠标/键盘、QQ或原生DevTools窗口截图时，在Delivery根目录执行 node_modules/.bin/tsx scripts/integration-capture-lock.ts acquire <taskId-requestId>；只有acquired=true才可操作原生窗口，锁只覆盖这一小段原生操作，不包住登录、请求等待或整页验收。释放锁前结束原生操作，异常也执行同脚本release；不能释放别人的锁。需要依赖前台窗口的少数截图由主会话协调短暂停止其他会话会改变前台的操作后采集，不因原生取图让其他网页会话长期排队。当前若持有旧的全流程锁，先完成手头单次操作并释放自己的锁，再立即转本标签CDP并行。不能假定getApp选中的就是本会话。
正常登录后复用本会话标签页，优先通过页面菜单及页内Tab切换；不要逐页面使用goto或reload整页导航，避免重复启动users/info和中断未完成请求。读取当前页面及请求结果后再进行下一步，不因截图故障重新登录。启动请求短暂网络失败只允许一次限定重试；仍失败按网络/环境阻塞记录，不能当成账号无权限或后端业务缺陷。
原生取图前先在Delivery根目录执行 node_modules/.bin/tsx scripts/integration-capture-lock.ts preflight。desktopUnlocked=false表示Mac锁屏，暂停原生Chrome操作，等待用户正常解锁；不反复调用getApp或改用QQ重试，不解锁、不修改屏幕录制权限。desktopUnlocked=null表示原生状态未确认，不宣称原生截图可用；true只允许开始实际取图验证。网页局部截图、请求核对与本地修复可以继续；群反馈以能清楚证明本问题的实际关键截图为准。
QQ仅作为原生窗口可见时的可选截图方式；业务页面或原生DevTools中的真实问题区域即可，不能用生成的HTML报告替代。默认网页取图直接使用本标签的受支持cdp能力调用Page.captureScreenshot，使用format=png、fromSurface=true、captureBeyondViewport=true、clip={x,y,width,height,scale:1}；坐标从当前可见问题元素的DOM矩形读取，不猜坐标、不修改页面内容。当前Chrome实测captureBeyondViewport=false配合clip会产生白图，不沿用该组合；网页图异常时先对本标签不带clip截取视口核对，不能为此争抢原生窗口。这是真实页面截图，不能用于冒充原生Network图。仅当必要问题区域无法取到时记录“待采集页面上下文截图，未推送”。整窗取图异常时继续尝试问题区域的局部截图，已有清晰问题图不因缺整窗图而阻塞。原生Chrome状态若只显示“窗口”菜单，在最新AX上调用菜单实际提供的Cancel动作一次。原生截图返回cgWindowNotFound时立即结束原生操作并释放自己的锁；可继续网页上下文截图、不依赖窗口的核对与前端修复，不重复登录、不争抢窗口，不把取图失败记成业务接口失败。
复用 scripts/send-integration-evidence.ts：使用 描述.md 关键截图.jpg 回执.json --send-inline <automation.evidenceBaseUrl>/<本批目录>/关键截图.jpg，需要补关键返回时追加同目录的 关键返回.jpg。通常1至2张，最多3张；先把经核验的截图发布到Delivery的public和dist对应目录，读取图片地址确认可访问且与本地图片一致。全部关键图内嵌在同一条markdown_v2正文，只提交一次机器人请求；禁止再单独发送图片、文字或补发同内容，不使用--send、--send-image、--send-text或填“-”。每个独立问题单独一条图文，问题之间分开发送；源截图及详细核对留在同问题证据页，不把所有说明画进图里。
回执固定为 .data/integration-feedback/<taskId>/<issueId>-initial.json；先检查既有发送记录，发送成功或未知均不自动重发、不换回执绕过去重。用户仅要求重新执行时重新实测，不代表重发已经成功的群反馈；只有明确要求重发的批次才使用带本次requestId的独立回执，保留旧回执，并重新实测、重新截图。retest使用带本次requestId的新回执。发送后立即用issue动作更新notification：单条图文成功回执／发送失败／结果待确认／待采集截图未推送，加回执相对路径。单条图文errcode=0才写已完成反馈；截图访问失败、发送失败或未知不能写已送达，不阻塞其他独立项。
开始先读取 .data/integration-cleared-issues.json；用户已清理的历史记录不从旧报告恢复、不换ID重建、不自动补发。用户明确重启的本轮若有recheck授权，重新实测发现同义问题时沿用原问题ID，以本轮请求和新证据登记，不能因旧记录被清理就忽略新事实。先保存本轮HTML报告，报告正文包含完整requestId、原问题ID、真实请求或入口、实际结果、预期及采集时间，再用issue动作传入report；守卫只接受recheck列出的本轮requestId且在startedAt之后写入的证据，通知更新可沿用本轮报告。无本轮复现证据仍禁止恢复和回测。再核对本批既有问题：先排除网络原因；未关闭且从未发送、确需后端处理的问题按当前真实证据反馈；前端问题不推送。已发送或发送结果未知的历史问题不因重启自动重发，不修改旧回执；网络问题和已解除问题不补发。未清理的旧问题仍需正常复验，发群不等于接口通过。`;
export interface ExecutionInterface { id: string; operationId: string; module?: string; page: string; request: string; status: string; result: string; checkedAt?: string; category?: IntegrationScopeCategory; deferredReason?: string }
export interface ExecutionPage { name: string; status: string; result: string; category?: IntegrationScopeCategory; deferredReason?: string }
export interface RetestBaseline {
  interfaceIds: string[]; pages: string[]; request: string;
  headers: Record<string, string>; requiredFields: string[];
}
export interface ExecutionIssue {
  id: string; summary: string; kind: string; status: string; description?: string;
  notification?: string; screenshot?: string; report?: string; retest?: RetestBaseline; taskId?: string;
  interfaceIds?: string[]; pages?: string[]; deferredReason?: string;
}
export interface RetestResult {
  requestId: string; issueId: string; environment: string; version: string;
  status: string; result: string; updatedAt: string; report?: string;
}
export interface ExecutionProgress {
  status: string; current: string; startedAt: string; updatedAt: string; environment: string;
  automation: { workspacePath: string; deliveryRoot: string; baseUrl: string; environment: string; assignee: string; loginAccounts?: Record<string, string>; evidenceBaseUrl?: string; taskDirectories?: Record<string, string> };
  interfaces: ExecutionInterface[]; pages: ExecutionPage[]; issues: ExecutionIssue[]; retests?: RetestResult[];
}
export interface ExecutionRequest { requestId: string; taskId?: string; kind: 'integration' | 'retest'; issueId?: string; environment?: string; version?: string }
export interface ExecutionTask {
  id: string; title: string; module: string; deferred: boolean; progressUrl: string; items: ReviewCatalogItem[];
}
export interface ExecutionPlan {
  automation: ExecutionProgress['automation']; tasks: Omit<ExecutionTask, 'items'>[];
}
const taskDefinitions = [
  { id: 'merchant', title: '商家管理与详情', module: '运营管理', deferred: false, directories: 'src/features/merchant（商家进件除外）、src/features/pricing、src/features/installment、src/features/warranty' },
  { id: 'equipment', title: '设备管理', module: '运营管理', deferred: false, directories: 'src/features/device、src/features/operations-diagnostics' },
  { id: 'finance', title: '财务管理', module: '财务管理', deferred: false, directories: 'src/features/finance、src/features/accounting' },
  { id: 'operations', title: '广告、活动、订单、消费用户与商家进件', module: '运营管理', deferred: false, directories: 'src/features/advertising、src/features/activity、src/features/order、src/features/consumer-user、商家进件对应的独立 feature' },
  { id: 'configuration', title: '系统配置、账号与公共能力', module: '系统配置 / 账号与权限 / 公共能力 / 客服管理', deferred: false, directories: 'src/features/system-config、src/features/system-management、src/features/auth；公共能力只读检查' },
  { id: 'monitoring', title: '数据监控（暂不联调）', module: '数据监控', deferred: true, directories: 'src/features/data-monitoring' },
];
function taskIdFor(item: ReviewCatalogItem) {
  if (item.ui.module === '数据监控') return 'monitoring';
  if (item.ui.module === '财务管理') return 'finance';
  if (item.ui.module === '运营管理') {
    if (/MerchantList|MerchantAdd|MerchantDetail/.test(item.ui.route) || item.ui.page.startsWith('商家 API')) return 'merchant';
    if (item.ui.route.includes('EquipmentMonitoring')) return 'equipment';
    return 'operations';
  }
  return 'configuration';
}

export function executionScope(catalog: ReviewCatalogItem[], records: ApexBffReviewState, assignee = '') {
  return catalog.filter(item => !!assignee && records[item.id]?.assignee?.name === assignee
    && !['已替代', '不再使用'].includes(reviewLabel(records[item.id])));
}
export function buildExecutionTasks(catalog: ReviewCatalogItem[], records: ApexBffReviewState, assignee = ''): ExecutionTask[] {
  const scope = executionScope(catalog, records, assignee);
  return taskDefinitions.map(({ directories: _directories, ...task }) => {
    const items = scope.filter(item => taskIdFor(item) === task.id);
    return { ...task, deferred: task.deferred || items.every(item => !!integrationDeferral(item)),
      progressUrl: `/integration-runs/${task.id}.json`, items };
  }).filter(task => task.items.length);
}
export function taskInterfaces(task: ExecutionTask, progress: ExecutionProgress | undefined, records: ApexBffReviewState): ExecutionInterface[] {
  return task.items.map(item => {
    const saved = progress?.interfaces.find(entry => entry.id === item.id);
    const confirmed = reviewLabel(records[item.id]) === '已联调';
    return { id: item.id, operationId: item.plan?.operationId || '', module: item.ui.module, page: item.ui.page,
      request: `${item.method || '方法待确认'} ${item.path}`,
      checkedAt: saved?.checkedAt,
      category: integrationScopeCategory(item), deferredReason: integrationDeferral(item),
      status: saved && !(confirmed && saved.status === '待执行') ? saved.status : confirmed ? '人工已确认' : !item.method ? '待契约确认' : item.method === 'GET' ? '待执行' : '需测试数据',
      result: saved?.result || (confirmed ? '人工审核已确认；自动实测结论单独记录。' : item.method && item.method !== 'GET' ? '等待可用于写入的测试数据，未执行写操作。' : ''),
    };
  });
}
export function executionIssueDeferral(issue: ExecutionIssue, scope: ReviewCatalogItem[]) {
  const ids = [...(issue.interfaceIds || []), ...(issue.retest?.interfaceIds || [])];
  const requestPath = issue.retest?.request.replace(/^GET /, '').split('?')[0];
  const interfaceReason = scope.filter(item => ids.includes(item.id) || item.path === requestPath).map(integrationDeferral).find(Boolean);
  const pageReason = [...(issue.pages || []), ...(issue.retest?.pages || [])]
    .map(page => integrationDeferral({ path: '', ui: { module: '', page } })).find(Boolean);
  return interfaceReason || pageReason || '';
}
export function executionRequest(run: Pick<AgentRun, 'objective'>): ExecutionRequest | undefined {
  if (!run.objective.startsWith(`${executionMarker}\n`)) return;
  try {
    const value = JSON.parse(run.objective.split('\n')[1]);
    if (/^[a-f0-9-]{36}$/.test(value.requestId || '') && ['integration', 'retest'].includes(value.kind)
      && taskDefinitions.some(task => task.id === value.taskId)) return value;
  } catch { /* 普通会话不作为自动执行记录。 */ }
}
export function activeExecution(runs: AgentRun[], taskId?: string) {
  return runs.find(run => executionRequest(run) && (!taskId || executionRequest(run)?.taskId === taskId) && ['queued', 'running'].includes(run.status));
}
export function createExecutionInput(progress: ExecutionProgress, scope: ReviewCatalogItem[], records: ApexBffReviewState,
  runtime: AgentRuntimeHealth, request: ExecutionRequest): StartAgentRunInput {
  if (!runtime.ready || runtime.provider !== 'codex') throw new Error('Codex 执行器尚未就绪');
  if (!progress.automation?.workspacePath || !progress.automation.deliveryRoot) throw new Error('联调运行工作区尚未配置');
  if (!/^[a-f0-9-]{36}$/.test(request.requestId)) throw new Error('执行请求编号无效');
  const taskId = request.taskId || 'merchant';
  const definition = taskDefinitions.find(item => item.id === taskId);
  if (!definition) throw new Error('联调任务不存在');
  if (definition.deferred) throw new Error('数据监控暂不联调（原延期安排），暂不自动执行');
  const directories = progress.automation.taskDirectories?.[taskId] || definition.directories;
  const loginAccount = progress.automation.loginAccounts?.[taskId] || '';
  const browserUrl = new URL(progress.automation.baseUrl);
  // 同一服务用独立 localhost 源隔离 localStorage 和 Cookie，保留用户及其他会话的登录态。
  if (['127.0.0.1', 'localhost'].includes(browserUrl.hostname)) browserUrl.hostname = `${taskId}.localhost`;
  const loginInstructions = loginAccount
    ? `本批专用登录账号：${loginAccount}；浏览器访问地址：${browserUrl.origin}。密码只从 ${progress.automation.deliveryRoot}/.data/integration-login-accounts.json 的 accounts 中读取本账号，禁止输出或写入台账、报告、群消息。只使用本批专用标签页和账号，不操作其他会话。首次改密或凭证缺失时记录阻塞并结束，由用户处理。`
    : `浏览器访问地址：${browserUrl.origin}。仅使用用户为本批指定的账号和独立标签页；没有授权账号或可用凭证时记录登录阻塞并结束，不猜账号、不使用其他会话的凭证。`;
  const allTaskScope = executionScope(scope, records, progress.automation.assignee).filter(item => taskIdFor(item) === taskId);
  const taskScope = allTaskScope.filter(item => !integrationDeferral(item));
  const pending = progress.interfaces.filter(item => taskScope.some(entry => entry.id === item.id)
    && reviewLabel(records[item.id]) !== '已联调' && item.request.startsWith('GET ') && item.status === '待执行');
  const issue = progress.issues.find(item => item.id === request.issueId);
  if (request.kind === 'retest') {
    if (!issue?.retest || !issue.retest.request.startsWith('GET ')) throw new Error('该问题尚未保存可安全复验的原请求');
    if (executionIssueDeferral(issue, allTaskScope)) throw new Error('该问题关联暂不联调的接口或页面，本轮不执行回测');
    if (!issue.retest.interfaceIds.length || issue.retest.interfaceIds.some(id => !taskScope.some(item => item.id === id))) throw new Error('回测接口已不属于所选负责人的当前模块任务');
    if (request.environment !== progress.automation.environment || !request.version?.trim() || request.version.length > 200) throw new Error('请填写当前联调环境的部署版本');
  } else if (!pending.length) throw new Error('没有待执行的查询接口；阻塞问题请使用回测入口');
  const selection = workbenchRuntime(runtime);
  const model = selection.models.find(item => item.id === selection.defaultModel);
  if (!model) throw new Error('工作台指定的 GPT-6.1-Sol 极高强度不可用');
  const progressCommand = `scripts/integration-execution-progress.ts ${taskId}`;
  const task = request.kind === 'retest'
    ? `回测问题 ${issue!.id}，后端申报已部署到 ${request.environment}，版本 ${request.version}。这只是触发依据，必须重新实测。\n原问题与复验基线：${JSON.stringify(issue)}\n开始先调用台账脚本 retest 动作，按本次请求编号保存“回测中”记录。先复验原 GET 请求及最新 BFF 字段类型/必填约束，再检查列出的页面和邻近列表/详情读取，保存能证明本问题或复验结果的关键截图及请求/响应记录。缺字段、接口失败、登录失效、页面未验证都不能判为通过。接口与页面均通过后用 interface/page 动作保存“已通过”或“已修复”，再记录“回测通过，待人工验收”；不自动改人工审核或 Jira。每次回测单独保存 requestId、issueId、environment、version、status、result、report，调用台账脚本 retest 动作。即使失败也要保存结论与证据。`
    : `自动顺序完成以下尚未检查的 GET 接口和关联页面，单项阻塞后记录并继续其他独立项，直到本批已检查或明确阻塞。不等待用户逐条下令。\n${JSON.stringify(pending)}\n每个接口先核对实际页面调用、请求路径/参数类型、真实响应与最新 BFF 契约，再检查页面展示和 demo 还原度。调用缺失、缺必填字段、HTTP 200但不符合契约都不能记为通过。无可用ID/测试数据时标记“需测试数据”，不得猜ID。`;
  return { provider: 'codex', mode: 'agent', accessMode: 'full', model: model.id, reasoningEffort: model.defaultEffort, workspacePath: progress.automation.workspacePath, isolateWorkspace: false,
    objective: `${executionMarker}\n${JSON.stringify({ ...request, taskId })}\n你是“${definition.title}”独立联调会话；其他模块由并行会话负责。只执行本批，不自行创建其他会话。\n${task}\n\n执行环境：${JSON.stringify(progress.automation)}\n${loginInstructions}\n先检查 ${progress.automation.baseUrl} 的实际监听进程与工作区一致，保留已有脏改动，不切分支、不创建替代运行环境。读取工作区规则及必要 Skill。不导航或关闭用户和其他会话的标签页，不使用会修改其他会话登录/地区上下文的操作。\n授权边界：本会话完整接口范围为 ${JSON.stringify(taskScope.map(item => ({ id: item.id, page: item.ui.page, route: item.ui.route })))}。每开始页面或请求前重新读取 Delivery 的 .data/apex-bff-review.json 和 shared/apex-integration-scope.ts；负责人变化、已替代/不再使用或 integrationDeferral(item) 非空则跳过。大数据/数据监控、活动/交易订单、财务账单/利润/统计及商家账单详情归为“暂不联调”，不发起接口、页面检查、修复、回测或本轮新群反馈；混合页面仅检查未延期区域，避免触发延期请求，不能安全分离则记录暂不联调。负责人、历史检查状态、问题和证据保持原值。开发工具与其他负责人任务不执行。普通联调跳过人工已确认项；申请回测允许复验原接口。业务接口只调用 GET；本账号正常登录所需的鉴权请求已授权。业务写入、重置密码、资金、删除、启禁用、测试邮件保持需测试数据，不自动执行。\n前端修复只允许本会话的独立业务目录：${directories}，Page仅在本批路由下局部调整。禁止编辑共享组件、shared、app、全局header、package/lock文件或其他模块目录；需要公共修改时记录“前端问题（公共修复待协调）”，交主会话统一处理。不得擅自重启业务服务或工作台，不同时覆盖公共配置。运行定向检查再真实页面回归。接口文案原样展示含L码，不翻译，不以默认值掩盖缺字段。后端问题只收集反馈，不改契约或服务。禁止提交、推送、Jira修改。\n独立实时台账：在 Delivery 根目录执行 node_modules/.bin/tsx ${progressCommand} <step|interface|page|issue|retest> '<JSON>'。每接口/页面前后以及每60秒有进展时更新。step只传status/current，interface传已有id/status/result，page传已有name/status/result（先读取 /integration-runs/${taskId}.json 的实际page name）。禁止 init、更新其他模块或覆盖已有证据。遇到全局登录/网络阻塞记录并结束，不死循环重试。\n后端问题issue保存带本模块前缀的唯一ID、简洁summary/kind/status、实际/预期、请求路径参数、traceId、截图/报告相对URL；归属通过retest基线的interfaceIds/pages或顶层interfaceIds/pages明确。retest只保存观察到的GET、非敏感上下文头、requiredFields，不保存Authorization/Cookie/密码/Token。\n${integrationFeedbackInstructions}\n截图和证据文件以本taskId为前缀，避免并行覆盖。先脱敏，发送能识别页面的上下文截图及对应原生Network详情，用红框标出异常，原图与详细结果留证据页。\n最后step为“本批执行结束”或“等待后端/测试数据”，说明通过、阻塞和待人工验收。Agent结束不等于接口通过。` };
}
