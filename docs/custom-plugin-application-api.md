# 自定义应用插件对接规范（hostApi 2）

适用：带独立交互页面和本机业务代码的工具。Go 实训是这一接口的首个实例；宿主没有 Go ID、课程、菜单或业务路由注册。原 hostApi 1 记录插件继续兼容。

## 边界与授权

应用插件是**受用户信任的本机程序**。前端在 `sandbox="allow-scripts"` 的不同源 iframe 内运行，不能直接读取工作台 DOM、Cookie、存储或发网络请求；通过消息桥调用宿主。后端运行在独立 Node 进程，默认不继承工作台认证、Node 启动参数和环境，宿主分配专属数据及工作目录。

独立进程、专属目录和浏览器隔离**不是操作系统安全沙箱**：获准的本机代码和它编译的程序拥有当前用户的文件、网络权限，恶意代码仍可能访问其他目录。只安装已审查、可信的包。需要不可信代码执行时，应另行提供 OS 容器/虚拟机，不能沿用本接口并声称已经隔离。

`application.local` 默认不勾选。安装时选中它表示信任整个包的本机代码，接口另要求 `trustedLocalCode: true`。从无授权变为有授权时也要求该标识。`storage.*` 约束的是宿主记录 API，不能限制本机程序自行访问文件。

| 能力 | 用途 |
| --- | --- |
| `application.local` | 加载应用页面、执行已固定摘要的本机入口，创建插件专属目录 |
| `conversation.compose` | 校验并返回草稿，用户在宿主确认后填入会话；不发送、不启动 AI |
| `workspace.open` | 用户确认后用终端/Cursor 打开本插件工作目录；不接受任意外部路径 |
| 原有 storage/Jira/context 能力 | 保持原接口和授权规则；不会因本机应用授权自动获得这些宿主接口权限 |

剪贴板复制由宿主展示独立确认，不向插件提供读取剪贴板能力。

## 包结构与声明

可分发包只需四个普通文件：`plugin.json`、`ui.js`、`ui.css`、`server.mjs`。禁止入口符号链接；单个入口最多 15 MB，合计最多 30 MB。前后端应打包所有第三方依赖，后端只能保留 Node 内置模块导入。宿主不在安装时执行 npm、构建脚本或插件代码。

```json
{
  "apiVersion": 1,
  "hostApi": 2,
  "id": "sample-tool",
  "name": "示例工具",
  "version": "1.0.0",
  "description": "独立本机工具",
  "permissions": ["storage.read", "application.local", "conversation.compose", "workspace.open"],
  "page": {"title": "示例工具", "kind": "application"},
  "application": {"frontend": "ui.js", "styles": "ui.css", "backend": "server.mjs"},
  "records": {"storage": "private", "resourceType": "note", "fields": [
    {"key": "title", "label": "标题", "type": "text", "required": true}
  ]},
  "commands": []
}
```

`records` 保留既有私有记录和资源引用契约；应用自己的课程、状态、逻辑由包负责，不应通过宿主固定 ID 或固定课程字段接入。

检查摘要包含校验后的声明及三个入口的 SHA-256。确认添加时重新读取并核对，复制到安装目录形成快照。之后来源目录变更不会自动生效；加载时校验已安装包，损坏则拒绝执行。同 ID 不同摘要默认拒绝覆盖；可使用下文的显式兼容更新。改变数据或权限契约仍需设计迁移，不提供静默升级。

## 后端入口

`server.mjs` 导出 `createPlugin(host)`，可返回 Promise。宿主在首个业务请求时加载，一插件一独立进程，同插件请求顺序执行。

```js
export function createPlugin(host) {
  // host.dataDirectory: 插件私有数据目录
  // host.workspaceDirectory: 可交给编辑器或会话的插件工作目录
  return {
    async request(method, input) {
      if (method === 'hello') return { message: '你好', workspace: host.workspaceDirectory };
      throw new Error('未知操作');
    }
  };
}
```

后端可实现可选 `close()` 关闭钩子，用于停止自身创建的独立进程组并刷新写入；宿主在终止时给予最多 2.5 秒清理时间。插件不得创建脱离生命周期的守护进程。返回 JSON 可序列化数据；错误消息返回前端。每次调用前检查安装、启用、声明和授权。单次调用最长 65 秒，超时终止插件进程组并报告错误；不能把超时视为业务未执行，应重新读取状态。禁止靠导入入口启动常驻外部任务。

停用、移除或撤回 `application.local` 立即拒绝新调用，终止本次插件进程组并拒绝排队调用；切换菜单可见性不会中断业务。保存应使用原子替换等方式处理被中断场景。数据、安装包和历史资源保留，恢复同摘要包后继续使用。关闭工作台会停止插件进程。进程组终止在 macOS/Linux 生效；Windows 未做操作系统验收，不应承诺子进程树完整回收。

## 前端桥接 SDK

`shared/plugin-application-sdk.ts` 是构建时 SDK，可复制进独立包，不依赖宿主业务组件。`ui.js` 为自执行脚本，挂载到 `#app`。宿主传入 `--ui-*`/`--el-*` 主题变量，主题变更通过桥同步。

```ts
import { host } from './plugin-application-sdk';
const result = await host.request('hello', {});
await host.compose('请分析我的结果', result.workspace);
await host.openWorkspace('cursor', result.workspace);
await host.copy('需要复制的代码');
```

宿主仅接受当前 iframe 窗口且带本次随机 token 的消息，并限制同时在途请求数。令牌不作为独立远程鉴权机制；后端接口仍要求回环地址、正确 Host、同源 Origin、JSON 和确认头。

`host.request` 只调用**本插件**的后端。消息中不允许指定其他插件 ID。`compose` 的路径和 `openWorkspace` 路径会解析真实路径，只接受本插件工作目录及其子目录；符号链接不能借此越界。会话内容必须经宿主确认，只进入草稿。插件停用和权限撤回在确认后再次校验。

## 管理及 HTTP 接口

沿用 `/api/custom-plugins` 的检查、安装、权限、菜单、移除流程，不增加全局业务路由。新增：

| 方法与相对路径 | 内容 |
| --- | --- |
| `GET /:id/application` | 返回固定摘要包的 JS/CSS；仅已授权且启用时可读 |
| `POST /:id/application-call` | `{method, input?}`；调用本插件业务入口 |
| `POST /:id/compose` | `{prompt, workspacePath?}`；授权并校验会话草稿 |
| `POST /:id/open-workspace` | `{app: "terminal"或"cursor", workspacePath}` |

添加及首次授予本机执行权限的请求需额外携带 `trustedLocalCode: true`。写请求必须包含原同源和 `X-Delivery-Confirmed: yes` 保护；业务请求体上限 500 KB。

## 存储与开发

安装快照：`.data/custom-plugins/packages/<id>/<digest>/`；应用数据：`.data/custom-plugins/data/<id>/application/`；工作目录为其 `workspace/` 子目录（前缀随 `DELIVERY_DATA_DIR` 变化）。移除入口不删除数据。

Go 示例：`node plugins/go-learning/build.mjs` 构建独立包，再从自定义插件管理中检查 `plugins/go-learning/package` 的绝对目录，核对来源、授权并添加。也可使用该插件自带安装脚本。构建其他工具时无需改宿主注册表或重编译宿主；只有新增通用宿主协议需要更新宿主。

针对性测试：`node --import tsx --test test/plugin-applications.test.ts test/custom-plugins.test.ts test/go-learning.test.ts`。测试使用临时目录；Go 真实运行结果、浏览器页面结果与操作系统应用打开结果需分别报告。

## 文本文件导出

SDK `host.download(name, text)` 对应前端桥 `file.download`。文件名仅接受 1～120 个英文字母、数字、点、连字符或下划线，文本最多 4,000,000 字符。宿主展示文件名确认，确认后重新检查当前插件仍启用且持有 `application.local`，由浏览器下载 UTF-8 文本。不接受任意磁盘路径，不读取文件，不自动覆盖用户指定的本机文件。插件使用前应确保宿主包含此桥能力；旧宿主会明确返回不支持。


## 通用配置（记录插件与应用插件均可声明）

在 manifest 增加可选 `configuration`，不声明时保持旧包摘要兼容：

```json
"configuration": { "fields": [
  { "key": "endpoint", "label": "服务地址", "type": "text", "required": true, "default": "https://example.com" },
  { "key": "username", "label": "账号", "type": "text", "required": true },
  { "key": "password", "label": "密码", "type": "password", "required": true, "resetOnChange": ["endpoint", "username"] }
] }
```

最多 20 个唯一字段，支持 `text`/`password`、`required`、`description`、普通字段 `default`；密码禁止默认值。`resetOnChange` 为密码绑定的普通字段：任一变化会清除旧密码，要求重新输入必填密码，避免将旧认证带到新站点。每值最长 4000 字符。

插件管理页根据声明提供配置表单，无须修改宿主页面。`GET /:id/configuration` 返回 `{values,secrets,revision}`：values 仅普通值，secrets 仅是否已设置的布尔值。`POST /:id/configure` 接受 `{values,revision,clearSecrets?:string[]}`；未传值保留，密码空串保留，显式 clearSecrets 清除（必填值不能清空）。旧 revision 保存被拒绝，不覆盖并发修改。重启宿主后需重新获取 revision。

保存具有原有本机同源、JSON、确认头保护；拒绝未声明字段。停用插件可配置，移除插件不可访问。配置位于 `.data/custom-plugins/configuration/<id>.json`，原子替换、0600，**未提供磁盘加密**。移除保留文件；备份与分享不得包含该目录。

保存成功停止该插件旧进程及排队调用。新的后端 `createPlugin(host)` 可通过只读 `host.configuration` 获取当前配置快照，包括密钥。配置通过 IPC 送入插件，不放到进程参数或浏览器桥中。可信插件须保证返回值及错误不泄露密钥；宿主不会自动过滤任意业务返回。记录插件可使用管理 API 保存配置，但不具备本机后端执行能力。

## 通用 stdio MCP（应用后端）

公开类型在 `shared/plugin-application-host.ts`，仅作为编译期契约。使用已授权的 `application.local` 运行本机程序，无 shell，不继承宿主认证环境：

```js
export function createPlugin(host) {
  let connection;
  return {
    async request(method, input) {
      connection ||= await host.mcp.connect({
        command: host.configuration.command, // 必须绝对路径
        args: [], env: { SERVICE_TOKEN: host.configuration.token }
      });
      if (method === 'tools') return connection.listTools();
      throw new Error('业务调用须由插件检查工具、参数与确认状态');
    },
    async close() { await connection?.close(); }
  };
}
```

`connect` 初始化并协商 MCP `2025-03-26` tools 能力；`listTools()` 自动分页，最多 500 个工具；`callTool(name,args)` 返回原始 MCP result（插件必须检查 `isError`），`close()` 幂等关闭连接。stdio 使用换行 JSON-RPC，参照 [官方传输规范](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) 和 [生命周期](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)。不声明 sampling/elicitation/roots，不代用户授权外部写入；工具 annotations 不是可信权限来源。

请求默认 30 秒，可设置 100～55000 ms；传输错误、超时不重试、不重放。协议错误不回传敏感细节，stderr 不转发；进程退出提示检查路径、认证及服务。响应缓冲限制 20 MB，待处理请求上限 16。失败连接需显式重建；超时不代表远端未执行。

插件负责业务工具白名单、参数解释、读取结果和写入前确认。宿主负责所有已创建连接的关闭，插件停用/移除/撤权/超时或宿主退出时终止 MCP 子进程。单纯菜单隐藏不会停止。macOS/Linux 进程组行为已覆盖；Windows 子进程树仍需平台验证。

## 显式兼容更新

`POST /install` 可额外传 `replaceDigest`（当前安装摘要）及重新检查的新 `digest`。已安装摘要变化则拒绝。本机包更新必须 `trustedLocalCode:true`；原授权、启停、菜单和数据保持不变。

兼容更新要求 `hostApi`、`records`、`permissions`、`commands`、`page` 完全相同；已有配置字段不得移除或改变类型。可增加配置字段、升级代码/版本/描述。其他更改需单独迁移。成功后停止旧插件进程，新请求启动新包。管理页检查同 ID 包后显示明确更新按钮，不会隐式重置权限。
