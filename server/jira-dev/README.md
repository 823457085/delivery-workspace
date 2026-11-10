# Jira 研发助手模块（当前同步版本见 `sync-state.json`）

来源：`jira-dev-workbench 插件源码` 与 `plugins/jira-dev-workbench/skills`（1.2.1）。`*.mjs` 保持插件原实现，便于后续逐文件对照同步；工作台只经 `index.mjs` 使用，类型见 `index.d.mts`。

工作台改动不在这些文件内：

- `server/jira-dev-tasks.ts`：替代插件 MCP 工具（预览、确认 Jira 计划、核对、创建 worktree）。确认后不新建 Codex 聊天，而是按页面所选 CLI / 模型 / 推理强度 / 访问权限在工作台启动会话，并登记为原有 Jira 修复（`jira-fix:`）或需求开发（`requirement:`）记录。
- `server/jira-dev-prompt.ts`：由 `tasks.mjs` 的 `buildTaskPrompt` 改写；工作区预先创建，技能按绝对路径读取，方案写入工作区 `docs/requirements/`，交接改为最终 `delivery-report`，因此不依赖插件 MCP 工具。
- Jira 连接只读复用插件“Jira 连接”保存的选择（`~/Library/Application Support/JiraDevWorkbench`）；任务计划、项目默认设置与启动记录在 `.data/jira-dev/`，不改插件数据。

同步新版插件时：替换同名 `*.mjs` 与 `skills/`，再核对 `index.d.mts`、提示词改写与 `test/jira-dev-tasks.test.ts`。

## 一键同步云端版本

「需求开发」页右上角“同步研发助手”按钮（`GET/POST /api/agent-runtimes/jira-dev/sync`，实现见 `server/jira-dev-sync.ts`）：

- 读取插件更新站 `latest.json`，用插件内置 Ed25519 公钥校验签名；安装包同站 HTTPS，核对大小、SHA-256 与 `MANIFEST.sha256` 每个文件。
- `skills/` 取自已校验的安装包，下次启动会话即生效。
- 安装包只有打包后的 `server.mjs`，同名 `*.mjs`（含新增的相对依赖）取自本机插件源码（通过 `JIRA_DEV_PLUGIN_SOURCE` 指定），仅在其版本与云端一致时同步，并先在临时副本中导入 `index.mjs` 校验；需重启服务生效。
- 替换前备份到 `.data/jira-dev/sync-backups/`。表单、启动流程与 `jira-dev-prompt.ts` 等工作台改写部分不会自动改动，新版界面功能仍需人工移植并补测试。
