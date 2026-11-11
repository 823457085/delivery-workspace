# Jira / Confluence 功能插件接入与迁移

本次把供应商功能的装配从宿主固定入口迁到随源码发布的受信任插件。原业务服务、校验、确认和存储继续复用，插件负责注册页面、知识来源和相关操作。声明式本地记录插件仍使用 `plugin.json`，不加载可执行代码。

## 使用与状态

打开「设置 → 连接与策略设置 → 连接与项目 → 接入插件」。已有环境变量或本机凭据继续使用，无需为此次升级重新输入 Token。

- **启用/停用**：即时更新当前进程能力检查。当前页面同步移除或恢复入口，其他已打开窗口最多在下一次 10 秒状态刷新后更新；服务端立即拒绝新调用。
- **移除接入/恢复接入**：修改安装状态，保留配置、记录、知识范围、任务和会话快照，不卸载源码、不删除远端内容。
- **尚未配置**：不注册可用业务入口，管理卡片显示待配置。旧链接显示恢复指引。
- **连接变更**：保存后提示待重启。当前进程继续使用原连接，重启才切换站点或凭据，避免进行中的任务切换身份。
- **读取或加载失败**：显示原错误，禁止作为已可用处理。Confluence 服务按首次调用初始化，初始化失败不会阻止无关功能启动，可修复后重试。

已发出的远端请求不能撤销；已有 Agent 会话不会被停止。插件开关限制工作台的受控接口，不修改外部 Agent 的 MCP 配置。原自动化授权保留；停用期间不新增对应巡检和远端调用，恢复后仍按原策略运行，不自动扩大授权。

## 受信任插件目录与契约

```text
plugins/jira/
  integration.json       名称、能力、导航、页面、扩展位置和兼容接口
  frontend.ts            异步页面组件及宿主扩展实现
  server.ts              服务注册与原接口适配
  WorkbenchCards.vue     插件贡献的首页卡片
plugins/confluence/
  integration.json
  frontend.ts            知识侧栏和文档候选查询
  server.ts              配置范围、检索、读取、引用解析
```

`integration.json` 的类型见 [shared/integration-plugins.ts](../shared/integration-plugins.ts)。配置管理继续使用 [store.mjs](../server/plugins/store.mjs)，供应商协议继续使用现有 Jira/Confluence 客户端，避免重新实现状态机。

| 字段 | 作用 |
| --- | --- |
| `id/name/description/prefix/probe` | 稳定标识、公开说明、凭据命名和只读探测 |
| `capabilities` | 供应商提供的能力，如 `issues.read/write`、`pages.read/write`。用于依赖可用性判断，不授予外部权限 |
| `section` | 可选主导航组，包含 ID、标题、短标题和图标名称 |
| `views[]` | 页面 ID、标题、兼容路径、所在组和组件键；`mode` 可传入原页面 |
| `knowledge[]` | 知识侧栏选项及组件键，组件接收 `workspacePath/relatedText`，通过 `compose` 事件引用资料 |
| `mention` | `@` 候选的种类、标签和前缀；`frontend.ts` 的 `mentions(workspace, query, signal)` 返回候选，必须支持取消 |
| `widgets[]` | 首页插件卡片。当前首页提供 `today/todayIssues/loading/error/jiraSyncStatus`，监听 `openIssue`；这些输入属于现有首页协议，扩展其他业务时需明确新增契约 |
| `slots[]` | 具名扩展位置。当前为需求开发表单、工具栏和需求导入；组件事件与输入见下文 |
| `sourceKeys` | 供应商拥有的旧来源接口键，控制查询启停及后端能力检查 |
| `apiPrefixes/apiPaths` | 旧接口的所属插件与调用门禁，精确路径或带边界的前缀匹配 |
| `historyPaths` | 停用期间允许 GET 的本地历史接口；不能用于远端查询或写入 |

页面只在“已安装、当前启用、当前连接已配置”时注册。静态兼容路由始终可解析，停用时展示恢复指引，不加载供应商页面；重新启用从注册表重新计算，避免累积注册。

当前具名扩展位置：

| 位置 | 输入 | 输出 |
| --- | --- | --- |
| `requirement-form` | `workflow="requirement"` | `openRun(id)` |
| `requirement-toolbar` | 无 | 插件内部处理自身工具操作 |
| `requirement-import` | `existing` 需求列表、`systems` 系统名列表 | `close`、`imported(items)` |

`frontend.ts` 导出 `components` 映射，键与声明对应，页面采用 `defineAsyncComponent`。前端通过构建期 glob 读取受信任源码，不能把任意本机第三方脚本目录当作此机制安装。

后端 `createExtension(host)` 接收数据根目录、受控供应商客户端、本机端口及响应/请求体工具，返回：

- `id`：注册表中的唯一标识。
- `matches(url)` / `route(request,response,url)`：兼容接口适配。
- `contentTypes`：允许的写入类型。默认 JSON；Jira 同时保留 multipart 附件上传，由原处理器检查体积、格式和权限。
- `hasReference(objective)` / `resolveKnowledge(objective)`：发送时解析所拥有的引用。停用时不能静默忽略引用。
- `close()`：等待本插件保存结束、清理资源。

通用运行时检查本机来源、Host、Origin 和写入确认，之后进入原业务处理器。插件仍负责字段校验、权限、外部写入预览和结果核对。Confluence 继续使用原工作区配置文件和引用格式，不迁移或复制知识正文。

新增受信任接入插件需在后端定义表、共享清单及服务工厂表注册，并提供对应源码；修改后构建并重启。元数据、后端代码及插件页面已纳入源码版本核对。当前没有动态可执行插件安装、代码沙箱、热更新或自动代码升级能力。

待办、备忘等记录型自定义插件继续按 [自定义功能插件指南](custom-plugin-guide.md) 添加，无需修改上述源码注册表。待办请求 Jira 能力时由宿主能力检查选择已注册提供者；提供者不可用时操作按钮禁用并说明原因。

## 状态接口

`GET /api/plugins` 新增：

- `installed`：安装状态；旧配置没有此字段时按已安装处理。
- `runningEnabled`：当前进程实际启用状态。
- `runningConfigured`：当前连接是否具备地址和认证配置；不代表权限验证通过。
- `restartRequired`：连接配置与启动快照不同；纯启停和安装状态变化不要求重启。

`POST /api/plugins/:id/state` 为状态 PATCH，只接受一个或两个布尔字段：

```json
{"enabled": false}
```

```json
{"installed": false}
```

恢复使用 `{"installed":true,"enabled":true}`。必须有本机 Origin、JSON 及 `X-Delivery-Confirmed: yes`。此接口保留已有连接字段；旧环境变量凭据不会被复制到插件文件。

连接编辑仍使用 `configure` 完整表单；改变站点或身份时，必须重新提供有效认证，不把旧站点密钥带到新站点。

## 功能迁移与验证记录

| 原能力 | 现在如何接入 | 本地验证依据 |
| --- | --- | --- |
| Jira 列表、日历、统计、筛选 | 插件 `views` → 原 `TaskWorkspace` | 导航/兼容路由测试；模拟服务浏览器任务列表 |
| 任务详情、编辑、状态、指派、评论、关注、关联、子任务、工时、附件 | Jira 服务注册 → 原详情组件与处理器 | 原 Jira 服务回读与权限测试；multipart 通路测试；浏览器详情 |
| Jira 缺陷修复 | 插件页面 → 原修复流程 | 页面注册测试；停用新请求门禁，本地历史读取保留 |
| 需求开发、导入和助手工具 | 插件具名扩展 → 原组件 | 构建及依赖门禁；原研发自动化回归 |
| 首页任务、状态同步卡片 | 插件 `widgets` | 构建；停用不再挂载卡片 |
| Confluence 知识侧栏、范围、检索、预览 | 插件知识组件及服务注册 | 原知识服务测试；注册接口范围保存、检索、预览与重启测试 |
| `@文档` 与 Confluence 引用 | 插件候选提供者与引用解析 | 候选测试；发送时读取最新版本；浏览器选择并写入原引用格式 |
| 技术方案发布 | 原发布适配器 + `pages.write` 依赖检查 | 原发布服务模拟测试；无能力时禁用入口 |
| 待办转 Jira、会话事项引用 | 原自定义插件桥接 + 宿主能力检查 | 自定义插件及会话快照测试 |
| 原配置、数据及旧链接 | 原存储保留；状态 PATCH；兼容路由 | 旧凭据恢复测试、浏览器停用后旧链接提示与恢复 |

本次浏览器使用本机模拟 Jira/Confluence，测试数据与账号配置隔离；没有创建真实远端任务、发布真实文档或启动真实 AI。上述结果证明本地接入及受测行为，不代替真实供应商的权限、工作流和字段验收。操作系统钥匙串、原生对话框等能力未新增验证。

最终本地检查：64 项针对性测试通过，`npm run build`（前后端类型检查及 Vite 构建）通过，`git diff --check` 通过。页面使用隔离数据与模拟服务验证，临时服务已停止。未执行全量仓库测试；构建仍有既存的大包体积提示。
