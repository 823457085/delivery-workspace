# Delivery Workspace · 启元工作台

本地研发工作台，包含 Codex/Cursor 会话、项目与工作区、Jira 日历与任务、自动派发队列、技术方案、需求开发、缺陷修复与关单、接口联调与回测、交付审核、知识笔记和远程访问工具。

本仓库提供完整前端、内嵌后端、自动化执行器、测试、脚本、Skill 和交付模板。业务服务运行在同一进程，默认地址为 `http://localhost:5199/agent`，不需要旧的 5188 服务。

## 给别人 Codex 的一句话

克隆仓库并在 Codex 中打开后，可以直接发送：

> 请阅读 AGENTS.md 和 README.md，检查我的环境，执行 pnpm run setup 并启动工作台，验证 /api/health 和 /agent。使用我的 Codex 登录；需要 Jira 等外部集成时告诉我具体配置项，不复制原作者的数据，不自动执行外部写入。

## 快速启动

需要 Node.js **22.13.0 或以上**、**pnpm 12.3.4**、Git。同步本机 Codex 会话还需要 `sqlite3`。首次使用安装并登录自己的 Codex CLI；安装与认证请按 [OpenAI 官方 Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) 操作。

```sh
git clone https://github.com/823457085/delivery-workspace.git
cd delivery-workspace
npm install -g pnpm@12.3.4
pnpm run setup
pnpm start
```

打开 [Agent 工作台](http://localhost:5199/agent)。`pnpm run setup` 会安装锁定依赖、创建 `.env`、构建并运行环境检查；已有 `.env` 会保留。CLI 未安装或未登录时，页面仍可启动，执行任务前需补齐相应环境。

```sh
pnpm run doctor        # 检查 CLI、登录状态、Git、sqlite3 和构建
pnpm dev           # 开发模式
pnpm build         # 前后端类型检查与前端构建
pnpm test          # 自动测试；不需要作者的 Jira 或私人项目
curl -fsS http://127.0.0.1:5199/api/health
```

`pnpm setup` 是 pnpm 自身命令，请使用 `pnpm run setup`。所有路径可配置，不依赖原作者 Desktop 目录。端口冲突时在 `.env` 修改 `PORT`。

## 功能与接入条件

| 功能 | 接收方需要提供 |
| --- | --- |
| Codex 会话、运行过程、排队、分叉、附件、额度和本地会话同步 | 自己已登录的兼容 Codex CLI；桌面会话续接需要匹配的桌面运行时 |
| Cursor 会话与执行 | 自己已登录的 Cursor CLI，可配置二进制路径 |
| 项目扫描、分支、隔离工作区和交付 | 自己的项目目录、Git 和仓库权限 |
| Jira 日历、筛选、缺陷读取、关单、自动任务 | 自己的 Jira URL、鉴权和工作流权限 |
| 技术方案分阶段执行与 Confluence 发布 | 随仓库 Skill/模板、本机名为 `atlassian` 的 MCP、自己的 Confluence 目标目录和授权 |
| 需求开发、实现与审查、缺陷修复 | 在表单选择自己的项目、基线与需求 |
| 接口审核、负责人分配、自动联调、回测与反馈 | 自己的接口库存、联调计划、项目环境和企业微信机器人 |
| 需求追平、用例审核、合入流水线 | 自己的 manifest、需求文档、Git 基线与合入计划 |
| 知识笔记 | 自己选择的笔记目录；可发现本机 Obsidian |
| Mastra 实验室 | 默认规则分析可运行；模型调用需自己的供应商配置 |
| LAN/VPN/远程登录网关 | 自己的网络、证书、隧道与独立登录配置 |

功能入口保留；首次启动没有他人的 Jira 任务、会话或追平结果。接口审核内置的是**未测试的中性示例**，不是已通过联调的数据。具体配置和数据格式见 [配置指南](docs/configuration.md)。

## 页面入口

| 地址 | 内容 |
| --- | --- |
| `/agent` | 会话、今日工作、任务、项目、执行、交付、自动化/设置与知识侧栏 |
| `/overview`、`/workbench` | 工作总览和任务工作台 |
| `/tasks/calendar`、`/tasks/list`、`/tasks/stats` | Jira 日历、列表和统计 |
| `/projects` | 本机项目和 Git 状态 |
| `/delivery/plan`、`/delivery/queue`、`/delivery/runs` | 执行计划、CLI 队列与运行记录 |
| `/catchup/execution`、`/catchup/merge`、`/catchup/codex` | 需求追平、合入审核与任务聚合 |
| `/settings` | 自动化设置与执行环境 |
| `/lab` | Mastra 暂停、审核、恢复与冲突演示 |

## 仓库结构

`src/` 是 Vue 3 + Element Plus 前端；`server/` 是本地 API、CLI 运行时与内嵌 Jira/交付后端；`shared/` 是前后端契约和中性示例；`scripts/` 是启动与联调辅助脚本；`tools/remote-access/` 是独立远程网关；`support/` 提供 Skill 和交付规范；`test/` 提供自动测试。

支持包中的 Excel 导出脚本需要 Python 3 和 `openpyxl`，规范包校验脚本需要 `rg`；使用这些工具前按对应说明安装。

`.env`、`.data`、附件、会话、联调证据、项目源码、账号与机器人凭据都属于接收者本机数据，已加入忽略规则。分享版本不包含原作者的运行历史和企业接口库存。

## 运行边界

默认只监听 `127.0.0.1`。工作台是本地单用户工具；需要远程使用时按 [远程访问说明](docs/remote-access.md) 配置独立网关。不要直接把主服务暴露到公网。

自动派发和外部写动作首次默认暂停，按自己的项目配置后在设置页启用。已运行任务的会话锁、领取令牌、回调确认和人工审核继续生效。页面启动、测试通过和真实 Jira/模型/Git 交付是不同的验证层级。

主要开发验证在 macOS；原生目录选择器、Terminal.app 和桌面会话协作属于 macOS 接入，其他系统可手动输入工作区路径。完整功能还取决于接收方 CLI/MCP 版本及外部账号权限。
