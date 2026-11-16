# 三仓库协作协议 v1

## 本次归属和替换顺序

| 归属 | 内容 | 依赖 |
|---|---|---|
| delivery-plugins | 独立业务插件、公共插件库、构建、测试、`.dwp`、声明生成目录 | 固定 SDK tarball、锁定构建依赖 |
| delivery-plugin-center | 搜索分类详情、市场与已安装管理、维护者制品目录 | 固定 SDK tarball、公开宿主管理 HTTP |
| delivery-workspace 开发分支 | 运行、隔离数据、权限、受控包下载检查安装、主题、菜单、会话、跨插件能力代理 | 本机部署的中心构建制品；不导入另两仓源码 |

先提取 SDK，再独立构建插件包，再独立构建中心，部署制品、验证安装链路，最后将旧自定义管理界面替换为中心加载壳。按用户明确的接入模型，Jira/Confluence 保留为固定外部能力插件，继续使用原实现、连接配置和工作流，不再迁移为同名自定义包。固定/自定义是来源维度，能力/工具/应用是功能维度。

## 版本与发布

SDK `@delivery/plugin-sdk@2.1.0` 由宿主 `packages/plugin-sdk` 维护。用 TypeScript 输出 JS 和声明，`npm pack ./packages/plugin-sdk` 生成 tarball；消费仓库存入 vendor，通过锁文件依赖，不跨目录导入。协议 v1 保留 hostApi 1 记录包和 hostApi 2 应用包。新增 metadata 全部可选，没有默认值写进旧声明；未知兼容版本被拒绝。

插件包格式 `delivery-plugin/1`：JSON 的 files 字典仅允许 plugin.json、ui.js、ui.css、server.mjs，内容为严格 Base64。没有路径、符号链接、压缩炸弹、执行钩子或依赖安装脚本。单入口 15 MB、声明 64 KB、解码总量 30 MB、下载 41 MB。目录最多 2 MB / 500 版本，远端仅配置的 HTTPS 来源，禁止重定向和嵌入凭据。归档不接受任意 ZIP/TAR。目录 SHA-256 不是发布者签名；维护者与使用者仍需核对来源。

## 公开管理接口

所有路径相对 `/api/custom-plugins`。只接受回环连接、匹配 Host；拒绝跨站 Origin/Sec-Fetch-Site。POST 必须 JSON、正确同源 Origin 和 `X-Delivery-Confirmed: yes`。无 CORS 扩权、无跨站配对或远程控制。

| 接口 | 输入 / 输出 |
|---|---|
| GET protocol | `{protocol:1,sdk:'2.1.0',hostApi:[1,2]}` |
| GET catalogs | `{protocol:1,sources:[{id,name,location?,releases,error?}]}`；各源失败独立报告 |
| POST installation/preview | `{localPath}` 或 `{catalogId,id,version,sha256}`；返回检查过的 manifest、source、digest、permissionsDigest、id、token、replaceDigest?、currentGrants |
| POST installation/confirm | `{id,token,digest,permissionsDigest,grants,confirmed:true,trustedLocalCode,showInMenu}` |
| GET install-tasks/:uuid | 任务状态 awaiting-confirmation / installing / installed / failed / cancelled 及错误 |
| POST installation/cancel | `{id}`，仅未安装任务可取消 |
| GET / | 已安装实体、已移除历史、错误和本机 navigation |
| GET :id/configuration / POST :id/configure | 既有 revision 乐观锁，密钥只回传是否设置 |
| POST :id/change | 显式启停、权限、菜单、移除；保留数据 |
| POST navigation/settings | order/icons/groups；独立偏好，不写入发布声明 |
| POST :id/capability-call | `{name,version:1,method,input?,provider?}`；调用者由路径及当前安装状态绑定 |

检查只读来源并暂存快照，不执行插件，不注册入口。确认随机 token 单次使用，15 分钟有效；绑定固定快照、完整声明摘要、能力与提供/消费范围。拒绝必需权限无安装副作用；可选能力由用户逐项选；本机信任单独确认且默认不选。已安装版本改变则拒绝覆盖。异常时原版本保留，任务可回读；宿主重启遇到中断任务核对 registry，不自动重试。过期未确认包定期清理，最多 32 个待确认任务。

安装包运行来自私有快照，不依赖原始目录。可信本机代码有当前用户的文件/网络权限；宿主接口授权不能将其变成 OS 沙箱。

## 升级和生命周期

兼容代码/配置新增/权限变化可经新预览更新；拒绝新增必需能力或扩大范围则保留旧版本。配置既有字段不能改类型或移除；应用 records/page 契约不能静默更改，拒绝并保留旧数据。旧记录插件的显式字段迁移接口仍保留：先预览逐条验证、备份和授权清理，再保存，失败恢复；不会由市场自动发起破坏性迁移。

升级保留启停、配置、数据、menu order/icons/groups 和菜单可见性。新包缺必填配置进入停用待配置，保存后由用户启用。不自动登录、启动计划、创建任务或发布内容。配置变更或撤权终止所属进程及排队调用；已发出的外部请求不能回滚，超时显示待核对，不重放。隐藏菜单不停止。移除默认保留数据；本版本不提供隐含数据删除。

## 主题与跨插件能力

浏览器 SDK：`await host.theme.get()`；`host.theme.subscribe(fn)` 返回取消函数，并立即重放最新快照。主题有稳定 id、实际 mode、递增 version、当前实例 instance 和 background/surface/text/muted/border/accent。监听根节点主题变化和系统明暗变化；get 会读取最新状态。乱序旧版本与旧实例消息被拒绝，销毁解绑监听，停用后的页面被撤下。来源绑定当前 iframe、随机 token；公开主题只读，不需要独立授权。

full 应用变量与语义颜色；mode 仅同步 color-scheme；independent 不改插件样式。未声明继续兼容旧变量机制。

应用声明 provides，消费者声明 consumes + capabilities.call；分类与这些能力无关。方法与版本双向核对，当前只支持一层转发，避免循环等待。后端通过父子进程私有 IPC 调用，调用者 ID 不接受插件自报；排队实际执行前再次检查调用者授权及生命周期。多个提供者必须选择。provider 的业务写入确认不能被安装授权替代。

## 部署与降级

插件库 `pnpm build` → 制品目录交给中心 `pnpm run import:releases -- <目录>` → 中心 `pnpm build` → 复制 dist 到宿主 vendor/plugin-center 或配置 `DELIVERY_PLUGIN_CENTER_DIR`。市场连接通过固定插件「自定义插件」配置 HTTP 或 MCP（Streamable HTTP），不再并列使用内附目录或 `DELIVERY_PLUGIN_CATALOGS`。这只是本机集成，不自动发布。

中心是维护者审核的同源管理前端，使用 HTTP 公共接口。宿主不加载远端市场脚本，只受控加载本地制品；中心内不运行具体插件后端。目录离线不影响已安装、本机导入和已安装菜单；中心制品缺失返回明确错误，公开同源 API 和既有插件页面仍可用。

## 统一市场连接

固定插件保留 `plugin-market` 标识并更名为“自定义插件”；配置 baseUrl 与 transport（http 默认、mcp、github）。原安装和配置文件不搬迁。旧外部页面链接保留原值，用户须调整为市场服务地址。未配置或停用时返回明确目录错误，不影响本机管理。管理前端构建不再内附 releases，市场服务单独提供目录；本机导入仍由宿主检查。HTTP / MCP 都经宿主读取，超时 20 秒，目录 2 MB，包 41 MB；仅显式回环地址支持 HTTP，其他连接要求 HTTPS，禁止重定向。MCP 只读固定资源，不执行服务器工具或本机命令，每次请求结束关闭客户端。配置保存立即生效，既有安装确认仍绑定已检查的包和权限清单。

GitHub 的声明布局、版本策略、凭据隔离和下载约束见 [GitHub 插件来源](github-plugin-market.md)。
