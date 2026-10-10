# 接收方配置指南

`.env.example` 列出可用入口；`pnpm run setup` 创建权限为 `0600` 的 `.env`。启动程序先加载 `.env` 再导入配置模块。修改后重启本次启动的工作台进程，不停止别人的运行任务。

## CLI、数据和项目

- `PORT`：默认 5199，主服务只监听本机。
- `DELIVERY_DATA_DIR` / `DELIVERY_SOURCE_DATA_DIR`：默认 `.data` / `.data/source`，保存本机状态。
- `DELIVERY_CODEX_BIN` / `DELIVERY_CURSOR_BIN`：可显式指定可执行文件。默认优先探测完整 Codex 桌面运行时，再探测 PATH；新版桌面运行时的 `codex-code-mode-host` 必须保留。
- `CODEX_HOME`：默认当前用户自己的 `.codex`，用于自己的 CLI 登录和会话；仓库不包含登录数据。
- `LOCAL_PROJECT_ROOTS`：填写自己的项目目录；多个目录按系统路径分隔符连接。项目根目录需要包含 `.git`。
- `DELIVERY_SKILLS_ROOT` / `AI_DELIVERY_KIT_ROOT`：默认仓库 `support/skills` / `support/ai-delivery-kit`。无需覆盖全局 Skill。

工作台可手动输入项目路径。macOS 原生文件夹选择器、Terminal.app、钥匙串和桌面 IPC 需要对应系统能力。`pnpm run doctor` 会报告当前可用的执行器。

## Jira 和 Confluence

设置 `JIRA_BASE_URL`，再任选自己已有的鉴权方式：`JIRA_USERNAME` + `JIRA_API_TOKEN`、`JIRA_AUTH_HEADER` 或 `JIRA_COOKIE`。macOS 可指向已有钥匙串条目；不要把密码写入源码。

Confluence 对应 `CONFLUENCE_BASE_URL` 及用户名/token 或授权头。分阶段技术方案执行器要求本机 Codex 配置中有可用的 `atlassian` MCP，并在任务表单指定实际目标父页面。使用当前账号自己的连接与权限。

Jira 实现当前使用 REST `/rest/api/2` 和项目已有日期字段 `customfield_10109` / `customfield_10110`；不同 Jira 实例需要按自己的字段和工作流核对适配。自动状态转换、分片、周报和派发在 `/settings` 设置页配置；首次默认暂停。

`JIRA_AUTOMATION_PROJECT_KEYS` 是自动功能切片的项目允许列表，填写自己的 Jira 项目 key，以逗号分隔，例如 `DEMO,TEAM`。配置会去除两端空白、转换为大写并忽略空项；缺省为空，不自动创建或更新功能切片。配置允许列表后，仍需在设置页启用对应的自动化。

## 接口库存、联调与回测

共享的两份 JSON 是未测试的中性示例。复制它们到 `.data` 后编辑自己的数据，通过以下配置加载：

```dotenv
DELIVERY_INTEGRATION_PLAN_FILE=.data/integration-plan.json
DELIVERY_INTERFACE_INVENTORY_FILE=.data/interface-inventory.json
DELIVERY_INTEGRATION_CONFIG_FILE=.data/integration-execution-config.json
```

计划保持 `stages[].operations[]` 结构，操作包含唯一 `operationId`、`method`、`path`、`summary` 和 `contractStatus`。库存保持 `items[]` 结构，每项包含唯一 `id`、`path`、`module`、`pageModule`、`name` 及 `contract`。完整示例见 `shared/refactor-integration-plan.json` 和 `shared/apex-bff-interface-inventory.json`。库存项可加 `ui: { module, page, route, kind }` 指定自己的页面归属。服务端审核、页面、Agent 侧栏统计和企业微信反馈使用同一份配置库存；`DELIVERY_REFACTOR_REPOSITORY` 可指定自己的重构项目以聚合对应任务。

在接口审核页面为自己的账号分配负责人，并创建本机联调配置：

```json
{
  "workspacePath": "/absolute/path/to/your/project",
  "deliveryRoot": "/absolute/path/to/delivery-workspace",
  "baseUrl": "http://localhost:3000",
  "environment": "development",
  "assignee": "your-account",
  "loginAccounts": {},
  "evidenceBaseUrl": "http://localhost:5199/integration-runs/"
}
```

然后初始化本机台账：

```sh
node --env-file-if-exists=.env --import tsx scripts/integration-execution-progress.ts init
```

上述命令与工作台启动一样先加载 `.env`。联调批次 ID 为 `merchant`、`equipment`、`finance`、`operations`、`configuration`、`monitoring`；负责人使用自己的 Jira 名称/账号，`taskDirectories` 可按批次设置自己项目的修复目录。可从 `examples/integration-execution-config.json` 复制配置。未配置运行环境时不会初始化可执行任务。内置模块划分和延期规则继承原工作台，需要在 `src/features/integration-execution/execution-plan.ts` 与 `shared/apex-integration-scope.ts` 按自己的产品范围调整；负责人和接口数据可直接配置。

接口 200 不代表符合契约，人工审核和自动实测各自记录。业务 GET 自动执行、写请求需要测试数据、原生截图、脱敏、会话串行锁和回测版本核验均保留。

企业微信机器人在页面配置，默认凭据保存到 `.data/credentials/wecom-integration.json`；也可设置 `DELIVERY_WECOM_CONFIG_FILE`。先预览再确认发送。截图地址必须能被接收方访问，应使用自己授权的网络/网关和已脱敏图片。

## 需求追平和合入

没有资料时显示空看板，不伪造执行结果。设置 `APEX_CATCHUP_DATA_ROOT` 指向自己的事实目录。目录包含 `manifest.json`、`requirements.json`、`work-packages.json`、`git-landings.json`、`demo-path-coverage.json` 和 `decisions.json`；每份实体文件使用 `{ "items": [...] }`。manifest 记录数量和 SHA-256，后端读取时校验完整性，格式见 `server/jira-backend/catchup-board.mjs`。

设置源仓库、需求目录、会话根目录和已核验基线：`APEX_CATCHUP_SOURCE_REPOSITORY`、`APEX_CATCHUP_REQUIREMENTS_ROOT`、`APEX_CATCHUP_SESSIONS_ROOT`、`APEX_CATCHUP_BASE_SHA`。原资料目录结构和 `REQ-001` / `REQ-CU-001` 标识约定继续保留。

合入计划是 JSON 数组；可配置自己的任意数量计划，顺序必须从 1 连续编号：

```json
[
  {
    "requirementId": "REQ-001",
    "jiraKey": "DEMO-123",
    "slug": "example-feature",
    "sourceBranch": "feature/DEMO-123",
    "order": 1,
    "decision": "READY",
    "testPages": ["示例页面"],
    "testFocus": "自己的验收条件",
    "verificationMode": "browser"
  }
]
```

配置 `APEX_CATCHUP_MERGE_PLAN_FILE`、`APEX_CATCHUP_MERGE_REPOSITORY` 和 `APEX_CATCHUP_MERGE_TARGET_BRANCH`。需要 GitLab MR 链接时设置 `APEX_CATCHUP_GITLAB_PROJECT_URL`。`APEX_CATCHUP_MERGE_WORKSPACE` 指定隔离合入工作区。保留分支/远端 SHA、dirty、领取令牌、确认与证据审核门禁。

`APEX_CATCHUP_SCOPE_FILE` 可提供 `{ "exclusions": {}, "reviews": {} }`，键为需求 ID、值为范围理由。追平 Jira 写入默认 `APEX_CATCHUP_JIRA_DISABLED=1`；明确配置父任务、项目、子任务类型、负责人、日期并授权后才能启用。

## 例会与知识

例会可配置 `DELIVERY_MEETING_SNAPSHOT_FILE`、`MEETING_ASSIGNEE_NAME`、`MEETING_ASSIGNEE_USER_KEYS` 和 `MEETING_TITLE_PREFIX`；默认空模板不包含私人会议内容。

知识笔记在页面选择自己的目录；不要把整个用户主目录当作知识库。已选目录和笔记状态只保存在本机数据中。
