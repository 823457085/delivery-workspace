# 工作台插件接入规范

> 功能插件扩展已实现：需要从本机添加待办、备忘等自定义功能时，请阅读 [自定义功能插件开发与使用](custom-plugin-guide.md)。本页继续约束源码内的远端连接插件，下面的历史基线不代表新增功能插件机制。

本规范面向为 Delivery Workspace 编写接入插件的开发者，覆盖插件注册、连接配置、凭据处理、业务调用、页面与接口接入、测试及兼容要求。适用当前 `codex/integration-plugins` 实现，配置文件格式保持 `version: 1`。页面、知识来源、具名扩展和状态接口见 [功能插件装配规范](integration-plugin-ui.md)。

当前插件是随工作台源码一起发布的内置模块。新增插件需要修改注册表并实现业务适配；仅添加注册信息不会自动获得业务能力。本文的“必须”是新插件的交付要求，“当前行为”描述现有代码；示例插件尚未注册。

## 1. 接入范围和职责

| 层次 | 负责什么 | 对应入口 |
| --- | --- | --- |
| 插件注册 | 标识、名称、能力说明、环境变量前缀、只读探测路径 | [definitions.mjs](../server/plugins/definitions.mjs) |
| 配置存储 | 校验、保留密钥、私有落盘、公开状态、连接测试 | [store.mjs](../server/plugins/store.mjs) |
| 启动装配 | 将已保存配置转换为本次进程使用的环境配置 | [bootstrap.mjs](../server/plugins/bootstrap.mjs)、[scripts/start.mjs](../scripts/start.mjs) |
| 业务适配 | 供应商协议、响应校验、启停检查、超时、错误和写入结果核对 | 各插件实际业务客户端 |
| 管理接口 | 列表、保存、测试，以及本机同源保护 | [server/index.ts](../server/index.ts) 中 `/api/plugins` 路由 |
| 设置页面 | 表单、凭据状态、待重启提示、保存和测试操作 | [IntegrationPluginsCard.vue](../src/features/delivery-settings/IntegrationPluginsCard.vue) |

当前支持 Jira、Confluence 和企微 Webhook。以下能力尚未实现，不能作为新插件已有依赖：动态安装第三方代码、插件沙箱、独立插件进程、热更新、OAuth 授权回调及自动刷新、统一业务调用总线、多实例连接、插件代码卸载接口（当前支持移除接入并保留数据）。

`capabilities` 用于宿主判断提供者可用性，不是外部权限系统。声明 `issues.write` 不会授予写权限，也不会替业务接口完成用户确认。工作台插件开关不管理外部 Agent 自己配置的 MCP 或独立脚本。

## 2. 注册契约

在 `plugins/<id>/integration.json` 声明，再注册到后端定义表、共享清单和服务工厂；声明类型位于 [definitions.d.mts](../server/plugins/definitions.d.mts)。

```ts
interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  prefix: string;
  probe?: string;
}
```

| 字段 | 编写约定 |
| --- | --- |
| `id` | 稳定且唯一，使用小写英文、数字和连字符，例如 `acme`；用于配置键和管理接口路径。当前代码未自动校验命名和重复项，提交时必须检查。 |
| `name` / `description` | 面向使用者说明平台和用途，不包含凭据、本机路径或账号。 |
| `capabilities` | 使用 `资源.动作`，例如 `projects.read`、`notifications.send`；只声明已实现的能力。 |
| `prefix` | 唯一的大写环境变量前缀，例如 `ACME`；避免与系统变量及其他插件冲突。 |
| `probe` | 固定的只读相对路径，必须以 `/` 开头，不含站点、凭据或用户拼接内容。采用当前通用连接测试时必须提供。 |

简单 REST 插件的注册示例：

```js
{
  id: 'acme',
  name: 'Acme 项目服务',
  description: '读取项目详情',
  capabilities: ['projects.read'],
  prefix: 'ACME',
  probe: '/api/v1/me',
}
```

当前通用测试要求探测结果包含非空的 `accountId`、`key`、`name`、`username`、`userKey` 中至少一项，且 `type` 不是 `anonymous`。如果平台返回 `{ id: ... }`、嵌套数据或其他结构，需要扩展探测结果校验；不能为了通过测试伪造用户信息。

## 3. 配置和凭据契约

### 3.1 当前两类配置

除 `wecom` 外，当前存储和页面默认按“站点 + Token”处理：

```ts
interface SiteConfig {
  enabled: boolean;
  baseUrl?: string;
  username?: string;
  token?: string;
}

interface WecomConfig {
  enabled: boolean;
  groupName?: string;
  webhook?: string;
}
```

`enabled` 必填且必须为布尔值。`installed` 可选且必须为布尔值。其余连接字段若提供，必须为字符串，不超过 4096 个字符，不允许控制字符，保存时去除首尾空白；未声明字段会被拒绝。业务客户端可以有更严格的限制，例如群名称长度，新增插件必须使管理表单与运行时校验一致。

服务地址只接受 HTTP(S)，不得含 URL 用户名、密码、查询参数或片段；允许 `/wiki` 等路径前缀，保存时去除尾部斜杠。新增插件优先使用 HTTPS，业务请求必须保留配置中的路径前缀。

企微配置只接受 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send`，要求恰好一个非空 `key` 参数，不允许其他参数、URL 凭据或片段。其他供应商的 Webhook 不能复用这个分支，应新增自己的域名、路径、字段和测试规则。

### 3.2 密钥保留和账号隔离

- Jira/Confluence 同一规范化站点、同一用户名下，省略或留空 `token` 会保留插件文件中已存的 Token。
- 更换站点、路径前缀或用户名后，不继承旧 Token；必须重新提供认证才能完成连接测试或业务调用。
- 企微省略或留空 `webhook` 会保留插件文件中已存地址；仅改群名称不会自动切换机器人。
- 不从旧 `.env`、钥匙串或其他工作区复制密钥到插件文件。首次转为插件管理需重新输入凭据。
- 当前没有“清空密钥”或“删除配置”的管理接口；空字符串不代表清空。启停和移除使用状态 PATCH 接口，即时生效。

**保存接口是替换该插件配置，不是 PATCH。** 调用者必须发送完整的非密钥字段。仅提交 `{ "enabled": false }` 可能丢弃已有站点、用户名及密钥；切换开关应调用 `/api/plugins/:id/state`，该接口保留全部连接字段。密钥仅按上述特定规则保留。

### 3.3 存储和公开状态

通过工作台启动入口时，默认文件为 `.data/credentials/plugins.json`；设置 `DELIVERY_DATA_DIR` 后，使用该目录下的 `credentials/plugins.json`。相对目录以进程工作目录解析，正常启动入口会固定到仓库根目录。

结构示例仅展示无密钥的停用状态：

```json
{
  "version": 1,
  "plugins": {
    "jira": { "enabled": false }
  }
}
```

当前存储是本机明文 JSON，不是加密保险库。写入使用权限 `0600` 的唯一临时文件后重命名，新建目录权限为 `0700`；这些模式不能代替对已有目录权限或 Windows ACL 的检查。每个 Store 实例串行保存，不提供跨进程锁、配置修订号或多窗口冲突检测；同一数据目录应由一个工作台服务维护。

配置文件缺失视为未配置；损坏、版本不支持或含未注册插件时会报错，不覆盖原件，启动预加载也会失败。移除或重命名插件 ID 前必须设计旧配置迁移。

公开列表只能返回状态和非密钥配置。禁止回传 Token、Authorization、Cookie 或完整 Webhook；不要通过“末几位”、日志、异常、任务上下文或截图间接泄露。

## 4. 生命周期与生效时机

启动顺序：

```text
delivery.mjs
  → 加载 .env 并设置数据目录
  → plugins/bootstrap.mjs 读取 plugins.json
  → applyPluginEnvironment 装配配置
  → 导入业务模块并创建客户端
  → 提供管理接口和业务功能
```

使用 `node delivery.mjs start` 或 `node delivery.mjs dev`。其他启动包装必须保留上述预加载顺序，不能直接导入 `server/index.ts` 绕过插件初始化。

启停与安装状态保存后立即作用于当前进程。修改站点和换密钥仍在重启后生效；不要在保存时自动重启有运行任务的工作台。

| 状态字段 | 准确含义 |
| --- | --- |
| `enabled` | 列表展示的已保存启用意图；实际入口还检查 `installed/runningEnabled/runningConfigured`。无插件记录且环境变量未显式设为 `false` 时，沿用兼容行为，默认为启用。 |
| `configured` | 存在可识别的认证配置；不证明网络、密钥有效性、读权限或写权限。 |
| `restartRequired` | 连接字段与 Store 创建时快照不同（排除启停和安装状态）；反映配置差异，不是远端健康状态。 |
| `source` | `plugin` 表示文件中存在该插件记录；`legacy` 表示没有记录。不能单凭它断言所有字段已由插件覆盖。 |

对于站点类插件，只有保存了非空 `baseUrl`，启动装配才清除该前缀下的旧认证并设置 `DELIVERY_PLUGIN_<PREFIX>_MANAGED=true`。否则仅应用启停开关，旧站点配置仍可能被使用。企微仅在保存了非空 Webhook 时覆盖默认机器人；专用报告机器人保留独立配置，但发送同样受企微开关控制。

站点类插件的启动输出：

| 环境变量 | 用途 |
| --- | --- |
| `DELIVERY_PLUGIN_<PREFIX>_ENABLED` | 字符串 `true` / `false`，供调用边界检查 |
| `<PREFIX>_BASE_URL` | 规范化站点 |
| `<PREFIX>_USERNAME` | 用户名，可为空 |
| `<PREFIX>_AUTH_HEADER` | 有用户名时生成 Basic，否则生成 Bearer；仅供服务端使用 |
| `DELIVERY_PLUGIN_<PREFIX>_MANAGED` | 标识站点认证由插件装配；具体客户端必须实现对应优先级 |

装配站点配置时清除旧的 `AUTH_HEADER`、`COOKIE`、`KEYCHAIN_SERVICE`、`KEYCHAIN_ACCOUNT`、`USERNAME`、`API_TOKEN`。业务客户端不得再从旧文件或缓存拼回另一账号的认证。当前 Jira 已处理旧连接来源覆盖；新插件需要自行接好自己的客户端。

## 5. 管理接口

所有接口都要求 Host 为当前端口的 `localhost` 或 `127.0.0.1`。POST 还要求 Origin 为同一端口对应的 HTTP 本机地址；缺失或不匹配返回 403。保持现有保护，不为插件单独添加通配 CORS。POST 请求体读取上限为 30,000 字节。

| 方法和路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/plugins` | 无请求体 | `{ "plugins": PluginStatus[] }` |
| `POST /api/plugins/:id/configure` | 完整插件配置 | `{ "plugins": PluginStatus[], "message": string }` |
| `POST /api/plugins/:id/test` | 与保存相同的配置字段 | `{ "message": string }`，不保存配置 |

列表项示例：

```json
{
  "id": "jira",
  "name": "Jira",
  "description": "任务、日历、需求开发和状态回写",
  "capabilities": ["issues.read", "issues.write"],
  "prefix": "JIRA",
  "probe": "/rest/api/2/myself",
  "enabled": true,
  "baseUrl": "https://jira.example.com",
  "username": "alice",
  "groupName": "",
  "configured": true,
  "restartRequired": false,
  "source": "plugin"
}
```

同一账号修改启停状态的请求示例，空 Token 只保留插件文件中已有密钥：

```http
POST /api/plugins/jira/configure
Host: 127.0.0.1:5199
Origin: http://127.0.0.1:5199
Content-Type: application/json

{"enabled":false,"baseUrl":"https://jira.example.com","username":"alice","token":""}
```

保存和测试的校验失败、未知插件、连接失败由该路由返回 400 和 `{ "message": string }`；不支持的方法返回 405，同源失败返回 403。不能把所有管理错误都解释为认证失败；前端原样展示返回文案，不透传底层包含凭据的异常。

当前没有 `/execute`、`/install`、`/delete` 或通用业务代理接口。业务操作继续走相应业务模块的路由和确认流程。

## 6. 连接测试

站点类测试使用候选配置执行固定 GET，超时 15 秒，禁止跟随重定向，并校验用户响应。测试不保存配置，也不会证明创建任务、发布文档等写权限；首次从旧连接转入时，不自动读取旧 Token。测试成功结果当前不持久化。

企微测试仅校验地址格式，不调用 Webhook。发送“测试消息”也是外部写入，必须走预览与确认流程。

管理层的只读测试允许在 `enabled: false` 时显式执行，方便停用状态下诊断。此例外不适用于定时任务、自动重试或普通业务调用。自定义探测同样不得创建、修改、删除远端数据。

## 7. 业务客户端要求

### 7.1 在实际请求边界检查启停

每条真实网络调用路径必须先执行 `assertPluginEnabled(id)`，覆盖页面接口、后台调度、旧入口、重试路径及队列发送；只隐藏按钮或只在创建客户端时检查不够。排队操作应在真正执行时检查。

停用错误的当前契约为 `code: 'PLUGIN_DISABLED'`、`definite: true`。其含义是本次操作在发请求前明确被拒绝；不要据此推断历史请求未发生或回滚成功。

### 7.2 固定操作和严格响应

业务客户端接受事项编号、页面 ID 等领域参数，由服务端拼接固定资源路径。不得向浏览器提供任意 URL、方法、认证头的通用转发器。外部文本是数据，不是执行指令。

必须设置超时，明确重定向规则，校验 HTTP 状态和业务响应结构。业务错误保留可安全展示的原文；网络异常和包含敏感信息的响应要脱敏。认证失败、权限不足和限流不能按“网络瞬断”盲目重试。

只读适配示例，假设新增文件位于 `server/plugins/acme-client.ts`：

```ts
import { z } from 'zod';
import { assertPluginEnabled } from './definitions.mjs';

const projectSchema = z.object({ id: z.string(), name: z.string() });

export function createAcmeClient({
  env = process.env,
  fetchImpl = fetch,
}: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
  return {
    async readProject(projectId: string) {
      assertPluginEnabled('acme', env);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
        throw new Error('项目编号格式无效');
      }
      let base: URL;
      try { base = new URL(env.ACME_BASE_URL || ''); }
      catch { throw new Error('请配置 Acme 服务地址'); }
      if (!['https:', 'http:'].includes(base.protocol)
        || base.username || base.password || base.search || base.hash) {
        throw new Error('Acme 服务地址无效');
      }
      const authorization = env.ACME_AUTH_HEADER;
      if (!authorization || /[\r\n\0]/.test(authorization)) {
        throw new Error('请配置有效的 Acme 认证');
      }
      let response: Response;
      try {
        response = await fetchImpl(
          `${base.href.replace(/\/+$/, '')}/api/v1/projects/${encodeURIComponent(projectId)}`,
          {
            headers: { Authorization: authorization, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch { throw new Error('Acme 请求失败，请检查网络和连接配置'); }
      if (!response.ok) throw new Error(`Acme 读取失败：HTTP ${response.status}`);
      try { return projectSchema.parse(await response.json()); }
      catch { throw new Error('Acme 返回的项目数据无效'); }
    },
  };
}
```

该示例没有自动注册、业务路由、响应体大小上限或重试能力。接入实际平台时按响应规模补充读取上限；添加业务入口并通过测试后才能声明交付。不得将示例中的路径和返回字段当作真实供应商契约。

### 7.3 写入确认和不确定结果

新写能力必须保留所在业务流程的授权边界。交互写入应先展示目标、内容和影响，再绑定确认；自动写入需要已授权的具体策略，启用插件本身不代表授权自动写入。

请求发出后超时、断连或缺少可核对结果时，应记录为“结果待核对”，不能直接判定失败并重发。优先使用平台幂等键或本地稳定请求标识防重复；成功后按平台能力回读确认。企微的机器人接收回执不等于已证明所有群成员收到消息。不要由插件管理层替所有业务实现无条件重试。

## 8. 新增插件的修改步骤

1. 确定真实平台的认证方式、只读探测、业务操作、响应契约及是否需要外部写入。
2. 注册唯一 `id`、`prefix` 和已实现能力；简单 Basic/Bearer REST 接入可沿用通用配置。不同字段、签名、OAuth、不同用户响应结构必须在 Store 中显式适配。
3. 同步配置校验、密钥保留规则、公开状态和启动装配，并更新 [store.d.mts](../server/plugins/store.d.mts)；不要只改类型不改运行时校验。
4. 实现可注入 `fetch` 和环境配置的业务客户端；检查启停、路径、凭据和响应，接入所需的业务模块及路由。
5. 同步设置页面。通用站点类可复用现有表单；特殊类型需要自己的字段和帮助文案。密钥只输入不回显，保存后清空输入框，明确提示待重启。
6. 排查历史调用点和独立调度入口，确保管理配置与真正发请求的客户端使用同一来源；避免新旧入口各自维护认证。
7. 添加针对性测试及使用说明，核对源码分享包排除凭据和运行数据，再进行相应验证。

不能只给其他 Webhook 新增一个 manifest 就认为可用：当前非 `wecom` ID 会走站点与 Token 分支。OAuth、签名认证、多租户连接等需要单独补充配置模型、回调或凭据引用和生命周期设计，不能把这些信息塞进 `token` 字段临时兼容。

## 9. 兼容与版本变更

插件 `id` 和配置 `version` 是持久化契约。新增可选字段应明确旧配置的默认行为；改变认证含义、重命名 ID、移除字段或删除插件时，必须提供明确迁移步骤。当前加载器只接受 `version: 1`，不具备自动迁移框架。

迁移不得默认开启此前停用的插件、扩大自动写入范围、覆盖旧认证文件或静默换账号。需要恢复旧连接时，当前只能在停止工作台后由维护者处理对应配置记录；不要把留空保存宣传为“恢复旧配置”。

## 10. 针对性验收

新插件至少验证以下与其能力有关的场景。使用临时数据目录和模拟远端响应，测试不得读取开发者真实凭据或触发真实通知。

| 范围 | 必须验证的结果 |
| --- | --- |
| 注册与配置 | 未注册 ID、未知字段、非法类型、控制字符、非法站点和路径被拒绝 |
| 凭据隔离 | 列表及错误不泄密；同一身份保留密钥；切换站点或账号不沿用旧密钥 |
| 存储 | 保存可回读；损坏文件不被覆盖；适用系统下检查私有权限；失败不留下半份正式文件 |
| 生命周期 | 启停与移除即时生效；连接修改待重启；原配置保留；未配置显示接入指引 |
| 停用 | 页面业务、后台任务和旧入口在请求前拒绝，模拟网络调用次数为 0 |
| 探测 | 仅执行固定只读请求；超时、重定向、认证失败和无效响应不算成功；Webhook 格式检查不发送 |
| 业务适配 | 资源标识、上下文路径及响应结构正确；超时和权限错误有可操作且不泄密的结果 |
| 写入能力 | 确认不能绕过；重复请求受控；不确定结果不自动重发；成功按约定核对 |
| 页面与接口 | 保存和测试字段一致；秘密不回填；待重启提示正确；缺失或错误 Origin 被拒绝 |

可参考 [插件测试](../test/integration-plugins.test.ts)、[企微消息测试](../test/wecom-messages.test.ts) 和 [Confluence 知识测试](../test/confluence-knowledge.test.ts)。按新增能力选择受影响测试，再执行构建：

```sh
node --import tsx --test test/integration-plugins.test.ts
pnpm build
```

测试新增业务客户端时追加自己的测试文件；基础插件测试通过不能替代业务验证。交付时分别说明：静态检查与构建、页面与接口、真实 AI 执行（如涉及）、外部读取和写入权限、操作系统验证。未执行项明确标注，不把页面正常、存在凭据或只读探测成功当作真实业务验收。
