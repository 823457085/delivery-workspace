# Delivery Plugin SDK 2.2.1

Protocol 1. Build-time package with browser bridge, theme snapshots, manifest validation and server contract. Bundle it into plugin artifacts. Legacy hostApi 1 and 2 remain supported. No host private modules. See docs/plugin-repository-contract.md in the host distribution for management protocol.

## 2.2.0：通用会话工作区和后台任务

兼容 2.1.0 声明和摘要；新增字段均可选，不向旧声明注入默认值。
`PluginApplicationHost.workspaces` 提供 `access/list/preview/remove`。读取需 `workspaces.read`，回收需 `workspaces.cleanup`；插件不能选择强制丢弃。只接受会话关联的 linked worktree，复用宿主目录/分支身份、Git 状态、进程占用及会话锁校验。手动调用提交预览 revision 与文件夹名称；周期调用另提交 idleBefore，需后台授权且至少闲置一天，只允许宿主管理目录。最近使用时间取会话、目录元数据和 reflog 的最大值。

应用可声明 `background: { method, intervalSeconds }`（最小 60 秒），并申请 `background.run`。宿主启动后对当前启用且获授权的插件运行方法；停用、移除、撤权、升级及宿主关闭使旧实例和排队操作失效。隐藏菜单不停止任务。后台错误不自动重放本次方法；插件必须保存业务结果及待核对状态。工作台关闭期间不执行、不逐次补跑错过的周期。

RPC 检查发起 worker 实例、启用状态、当前授权；回收在工作区锁内再次检查。超时返回结果待核对，不保证操作未发生。安装授权并不取代插件的业务预览确认。本机代码仍以当前用户权限运行，不是系统沙箱。

## 2.2.1：浏览器连接提供者

独立应用声明 `provides: [{name: "browser.connection", version: 1, methods: ["browser/session"]}]` 和 `browser.provide` 权限。能力可选，未授予时仍可管理插件连接，但不向 AI 会话提供通道。无提供者不影响普通任务；多个已启用且已授权的提供者不会被随机选中。

后端 `request(method, input, context)` 的第三个参数由宿主注入，`context.source` 为 `page`、`plugin` 或 `host`。`browser/session` 必须只接受 `host`，不可相信 `input` 中的来源标识。返回 `PluginBrowserSession`：未连接为 `{verified:false,endpoint:null}`；已验证连接为 `{verified:true,endpoint:"ws://127.0.0.1:<port>/<secret>"}`。地址仅供宿主任务使用，不放入状态、页面或日志。

插件管理浏览器检测、用户连接确认、实际握手及会话隔离；宿主检查声明、授权、实例代次和返回地址，并配置通用任务浏览器适配器。插件须使用随机能力路径，拒绝网页 Origin，关闭时释放自有连接；不能退出用户浏览器。停用、撤权、更新或移除会停止插件 worker 及其通道。安装本机代码的信任独立于 API 授权，本机制不是操作系统沙箱。

2.2.1 是本机宿主 2.2 的兼容扩展；不代表提供后续个人 Agent 部署协议。发布包应声明真实使用的 SDK 版本。
