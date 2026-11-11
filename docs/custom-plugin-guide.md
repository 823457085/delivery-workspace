# 自定义功能插件开发与使用

工作台支持从本机目录添加**声明式功能插件**。插件通过 `plugin.json` 声明数据字段、功能页面、操作和会话资源，宿主生成页面并提供受控的 Jira、存储和会话能力。添加新插件不需要修改工作台注册表、路由或会话选择器。

本期交付面向待办、备忘等记录型功能，不执行插件 JavaScript、Shell、HTML 或远程代码，也不提供任意网络代理。插件声明是数据契约，不是可执行 SDK；有复杂交互、OAuth、自定义代码运行或自动调度需求时，需要另行扩展宿主协议。不要把本机制描述为可执行插件沙箱。

## 使用已有示例

1. 按仓库启动入口运行工作台，打开「设置 → 连接与策略设置 → 接入插件 → 自定义功能插件」。
2. 点击内附的「待办事项」示例，或填写 `plugins/todos` 的本机绝对目录。点击“检查插件”仅解析声明，不执行代码、不创建业务数据。
3. 核对名称、版本、来源和请求能力，选择授权后点击“确认授权并添加”。
4. 可在添加时勾选或添加后开启“在主菜单显示”，以插件名称创建独立菜单，点击直达该插件页面。停用或移除后入口隐藏；重新启用保留菜单偏好。菜单设置不授予额外能力，关闭菜单仍可从功能插件页打开。已打开的插件页使用统一的“功能插件”分类说明与单个主标题，不再重复显示插件选择器与单项页签。隐藏菜单不改变页面身份或清空正在编辑的草稿；停用、移除仍按插件生命周期处理。
5. 点击“打开”，或进入「设置 → 功能插件」选择“待办事项”。现有个人待办会直接出现，新增和编辑也写回同一份个人待办存储。
6. 保存事项后，可以“关联已有 Jira”“创建 Jira 任务”或“引用到会话”。Jira 使用工作台已有连接；未配置或已停用时明确报错，不让插件提供自己的认证头。
7. 会话输入区点击“插件事项”，选择提供者并搜索，预览后可添加多项引用。引用标签支持移除，发送时读取最新内容并保存快照。

另一个独立示例为 `plugins/example-notes`，名称“项目备忘”，使用自己的私有数据。它通过完全相同的安装与页面流程工作，用于验证宿主没有把自定义扩展绑定到待办。

两个示例都不会自动安装；源码不包含账号或待办数据。

## 菜单图标与排序

在「接入插件 → 自定义功能插件」点击“菜单外观与顺序”，拖动菜单或使用上下箭头调整内置菜单与自定义插件的顺序，点击菜单后从 16 个内置图标中选择。点击“保存菜单”生效，取消不修改；“恢复默认”先恢复编辑预览，仍需保存。“会话”固定在首位。未显示的菜单也能设置，启用后恢复其位置和图标；新增且未排序的菜单按默认顺序追加。

“使用默认图标”可恢复单项图标，预览与导航使用同一图标注册表。只修改图标不会固化菜单顺序；恢复默认并保存后，新插件仍按宿主默认位置插入。

图标只接受宿主内置标识，不加载第三方图片或脚本。顺序和图标是宿主偏好，不增加插件权限，也不修改 plugin.json。

## 两类插件的区别

| 类型 | 配置入口 | 生效时间 | 扩展方式 |
| --- | --- | --- | --- |
| Jira / Confluence / 企微连接插件 | 接入插件 | 启停即时；连接变更需重启 | 源码内适配远端连接与功能扩展，见[装配规范](integration-plugin-ui.md) |
| 待办 / 备忘等功能插件 | 自定义功能插件 | 添加、启停、授权变更即时生效 | 添加本地声明式插件包 |

功能插件的停用或权限撤回阻止后续调用及排队操作继续进入受控接口。已经发出的远端请求无法撤销，必要的结果核对或本地记录保存仍可能发生。停用待办插件不删除个人待办，也不禁用宿主原来的个人待办页面。

## 插件包契约

一个插件目录必须有普通文件 `plugin.json`，大小不超过 64 KB；不允许符号链接入口。宿主保存校验后的声明副本，不在每次请求时重新读取来源目录。来源目录后续变化不自动生效。

```json
{
  "apiVersion": 1,
  "hostApi": 1,
  "id": "team-notes",
  "name": "团队备忘",
  "version": "1.0.0",
  "description": "记录本地备忘并引用到会话",
  "permissions": ["storage.read", "storage.write", "conversation.context"],
  "page": { "title": "团队备忘", "kind": "records" },
  "records": {
    "storage": "private",
    "resourceType": "note",
    "fields": [
      { "key": "title", "label": "标题", "type": "text", "required": true, "maxLength": 200 },
      { "key": "details", "label": "正文", "type": "textarea", "maxLength": 2000 }
    ]
  },
  "commands": [
    { "id": "cite", "label": "引用到会话", "action": "conversation.context" }
  ]
}
```

运行时校验来源：[shared/custom-plugins.ts](../shared/custom-plugins.ts)。

| 字段 | 约束 |
| --- | --- |
| `apiVersion` / `hostApi` | 当前均为数字 `1`，不兼容版本拒绝添加 |
| `id` | 2–64 位，以小写字母开头，其余为小写字母、数字或连字符；必须唯一 |
| `version` | `主版本.次版本.修订版本`，仅接受三段数字 |
| `page` | 当前提供一个 `records` 页面，内容由宿主渲染，不接受 HTML |
| `records.storage` | `private` 使用按插件 ID 隔离的存储；`workspace.todos` 调用宿主个人待办服务 |
| `records.resourceType` | 稳定资源类型，用于持久化引用，不随意更名 |
| `records.fields` | 1–15 个字段，必须有必填的文本 `title`；字段键和显示名称分别唯一，不能占用 `id/createdAt/updatedAt` 等宿主字段 |
| `commands` | 最多 10 个，ID 唯一；action 必须是当前支持的宿主操作 |

字段类型支持 `text`、`textarea`、`date`、`select`。文本长度由 `maxLength` 限制，最多 8000；选择类型必须声明 `options: [{value,label}]`，可提供 `default`。日期为空或有效的 `YYYY-MM-DD`。不接受未知配置字段，不能把凭据放入记录字段。

复用 `workspace.todos` 时必须声明 `title/details/dueDate/priority/status` 五个字段，并使用示例中的状态和优先级取值；真实读写仍经过个人待办原有校验。新增插件需要特殊字段时，优先使用私有存储。

## 能力请求和授权

`permissions` 是插件请求的能力，安装时用户选择的 `grants` 才是宿主允许的能力。每次受控调用都检查插件启用状态、声明和授权；管理页“权限”可撤回或恢复已声明的能力。

| 能力 | 宿主提供的操作 |
| --- | --- |
| `storage.read` / `storage.write` | 读取或修改该插件的私有记录 |
| `workspace.todos.read` / `workspace.todos.write` | 读取或修改宿主个人待办，与其他页面共享数据 |
| `jira.read` | 查询项目、事项类型、创建字段和指定任务 |
| `jira.create` | 准备创建预览，并在用户确认后创建 Jira 任务；流程还需要 `jira.read` 核对元数据和结果 |
| `conversation.context` | 搜索、解析插件资源，并允许宿主将资源放入会话输入区 |

操作贡献与请求能力分别声明。`jira.link` 命令需要 `jira.read`；`jira.create` 命令需要 Jira 创建能力，完整流程同时需要读取；`conversation.context` 命令需要同名能力。新插件未声明的操作不能通过直接请求接口执行。

宿主不暴露 Jira 密钥、完整环境变量、任意文件读取、任意 URL 请求或代码执行能力。当前授权只作用于工作台受控接口，不改变操作系统权限或外部 Agent 的 MCP 设置。

## 页面与资源扩展点

插件添加后，通用“功能插件”页面自动列出插件并根据字段渲染列表、搜索、表单和命令。声明 `status` 选择字段时自动提供状态筛选。创建时间、更新时间、稳定 UUID 由宿主生成。

资源引用格式为：

```text
plugin:<plugin-id>/<resource-type>/<record-id>
```

资源包含 `reference/pluginId/resourceType/id/title/excerpt/updatedAt/version/url`，详情额外包含 `content`。版本是记录内容的稳定摘要，编辑和删除要求传回读取时版本，避免覆盖已变化内容。调用宿主个人待办服务时还在实际保存锁内检查原记录。

会话最多引用 10 个插件资源；单个内容不超过 32 KB、合计不超过 100 KB。选择时可预览，发送时重新核对权限和存在性；解析失败阻止本次发送，要求移除或重新选择，不悄悄忽略事项。

解析出的内容以不可信业务数据追加到 Agent 的 `knowledgeContext`，不会升级为系统指令或操作授权。会话保存发送时的快照，源事项后续修改、删除或插件移除不改变历史内容。消息中的“引用的插件事项”可查看快照并打开当前来源；插件不可用时来源页面提示降级。

事项详情的“会话引用来源”查询宿主保留的运行记录，最多显示 50 条；已删除或因宿主保留策略清理的会话不再列出。补充消息引用也参与查询。外部原生会话和其他未经过本工作台知识解析流程的消息不保证拥有资源快照。

## Jira 操作流程

### 关联已有事项

用户输入任务编号，宿主读取并显示标题与链接，用户确认后只保存本地关联。不修改 Jira 任务。已有链接仍保留在插件数据中，停用或移除插件不删除远端内容。

### 创建任务

1. 宿主查询真实项目、事项类型和创建字段元数据；用户填写该类型的必填字段。
2. 服务端验证字段，生成绑定插件、记录版本和 Jira 连接身份的预览票据，10 分钟有效。
3. 用户核对目标站点及字段后确认创建；提交时再次验证权限、源记录、连接和元数据。
4. 请求前持久化 `sending` 状态，再执行一次 Jira POST。成功后读取任务核对标题、项目和类型，保存 Key、链接和本地关联。
5. 断连、超时、回读失败或服务中断产生 `unknown`，禁止自动重发；界面要求在 Jira 核对。相同票据已成功时返回已有结果，不重复提交；同一源事项存在成功或待核对创建记录时阻止重新创建。

Jira 支持 `labels` 字段时预览加入稳定核对标记，否则按预览标题及字段人工核对。已确认远端创建但回读未成功仍属于待核对结果。当前没有自动解除待核对状态的接口；可核对远端后手动关联已有任务，不应删除操作台账来强制重试。

自定义 Jira 字段根据元数据生成表单，复杂类型可填写 JSON 值；最终仍由服务端和 Jira 验证。供应商实例的字段、工作流及创建权限需要真实环境单独验证。

## 管理及调用接口

根路径为 `/api/custom-plugins`。只允许本机回环连接及当前监听端口的 Host。POST 必须有匹配 Host 的 HTTP Origin、`Content-Type: application/json` 和 `X-Delivery-Confirmed: yes`；添加、Jira 创建和关联还需要对应请求体中的明确确认。界面负责呈现具体影响，确认头本身不是业务预览。

| 方法与相对路径 | 用途 |
| --- | --- |
| `GET /` | 已安装插件、状态、授权、错误、本机示例路径和 `navigation: {order, icons}` |
| `POST /navigation/settings` | `{order: string[], icons: Record<string, MenuIconName>}`，整体保存菜单顺序及图标；同源与确认头限制同其他写接口 |
| `POST /inspect` | `{directory}`，只检查本机声明，返回 manifest/source/digest |
| `POST /install` | `{directory,digest,grants,confirmed:true,showInMenu?:boolean}`，重新校验摘要后添加 |
| `POST /:id/change` | `{enabled}`、`{showInMenu}`、`{grants}` 或 `{remove:true}`；不删除数据 |
| `GET /:id/records` | 读取记录及各记录版本 |
| `POST /:id/save` | `{id?,expectedVersion?,values}`；编辑需要当前版本 |
| `POST /:id/delete` | `{id,expectedVersion}`；只删除源记录 |
| `GET /:id/record?id=...` | 资源详情、Jira 关联、创建状态和会话引用来源 |
| `GET /resources?q=...&provider=...` | 搜索可用的上下文资源 |
| `GET /resource?reference=...` | 解析一个可引用资源 |
| `POST /:id/context` | `{recordId}`，获得引用和建议输入文本，前端交给已有会话草稿入口，不启动 AI |
| `GET /:id/jira-projects` | 查询项目 |
| `GET /:id/jira-metadata?project=...&type=...` | 查询类型和字段 |
| `GET /:id/jira-find?key=...` | 读取指定任务供关联核对 |
| `POST /:id/jira-link` | `{recordId,version,key,confirmed:true}` |
| `POST /:id/jira-prepare` | `{recordId,version,project,type,fields}`，返回预览票据 |
| `POST /:id/jira-commit` | `{ticketId,confirmed:true}`，提交已核对票据 |

不支持的方法返回 405，同源或确认头错误返回 403，非 JSON 写入返回 415；参数、状态和能力错误返回 400 与 `message`。真实创建返回 `done/failed/unknown`，不能只凭 HTTP 200 显示创建成功。

## 存储、生命周期和兼容

数据位于 `${DELIVERY_DATA_DIR:-.data}/custom-plugins/`：安装记录 `installed.json`、私有记录 `data/<id>/records.json`、宿主 Jira 台账 `jira-operations.json`。文件采用权限 `0600` 的原子替换；新建目录 `0700`。本机用户仍可直接读写自己的文件，不是加密保险库；不要提交或分享该目录。

`navigation` 保存到 installed.json，缺失时默认为 `{order: [], icons: {}}`。菜单 ID 使用内置栏目 ID 或 `custom:<插件ID>`；顺序禁止重复，图标枚举见 `shared/workspace-navigation.ts`，未知或暂时不可用菜单的偏好保留。

`showInMenu` 是宿主安装记录的本机布尔偏好，不属于 plugin.json；旧记录和新安装默认关闭。菜单沿用 `/agent?view=plugins&plugin=<id>`，原有事项深链接保持可用。管理页保存后即时更新菜单，其他页面最多在下一次状态刷新（10 秒）时同步。

添加时只接受与预览摘要一致的声明，重复 ID 拒绝。移除保留声明墓碑与数据，再添加相同声明可恢复数据；声明变化则要求先提供迁移，不自动升级、覆盖或重新解释历史数据。当前没有数据清空或自动版本迁移接口。

运行时只装配声明和宿主调用，不启动第三方进程或计时器；服务关闭时等待本机保存队列及 Jira 操作队列结束。单个声明或私有记录损坏会显示错误，不覆盖原件；安装注册表整体损坏时启动失败并要求检查，不能伪装为空列表。

## 开发和验证

从 `plugins/example-notes/plugin.json` 复制到独立目录，修改唯一 ID、名称、字段和所需能力，通过管理页检查并添加。添加记录、重启、引用、停用、移除及恢复时均应确认真实状态；无需重编译主应用即可添加兼容的声明式插件。

相关实现：

- [声明及资源类型](../shared/custom-plugins.ts)
- [运行时与私有存储](../server/plugins/custom-runtime.ts)
- [宿主 Jira 工作流](../server/plugins/host-jira.ts)
- [管理和业务路由](../server/plugins/custom-routes.ts)
- [通用插件页面](../src/features/custom-plugins/CustomPluginWorkspace.vue)
- [会话选择器](../src/features/custom-plugins/PluginContextPicker.vue)

针对性验证：

```sh
node --import tsx --test test/custom-plugins.test.ts test/custom-plugin-context-runtime.test.ts test/workspace-todos.test.ts test/integration-plugins.test.ts test/jira-issue.test.ts
pnpm build
```

测试覆盖添加与权限、数据复用和隔离、声明冲突、损坏文件、停用、引用快照、宿主会话持久化、Jira 元数据及重复和不确定提交。测试中的 Jira 使用模拟服务，AI 使用本地模拟执行器；不能据此声称真实 Jira 写权限或真实模型执行已验收。
