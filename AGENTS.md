# 给接收方 Codex 的启动指引

这是完整的 Delivery Workspace 源码。先读 README.md 和 docs/configuration.md，再检查本机环境；不要查找或依赖原作者机器上的路径、项目、凭据或历史会话。

用户要求启动工作台时：

1. 确认当前目录为本仓库，检查 Node >=22.13.0、pnpm 12.3.4、Git、sqlite3 和 Codex CLI。
2. 执行 `pnpm run setup`，安装锁定依赖、创建本机 .env、构建前后端并检查环境。注意 `pnpm setup` 是 pnpm 自身命令，必须使用 `pnpm run setup`。
3. 本机 CLI 未登录时让用户使用自己的账号登录；不能复制别人的 auth.json 或要求把密钥发到聊天里。
4. 执行 `pnpm start`，读取真实日志，检查 `/api/health` 并打开 `http://localhost:5199/agent`。端口被占用时先查进程；使用 .env 中 PORT 配置其他端口，不能停止不属于本次任务的进程。
5. 读取 `pnpm run doctor` 的结果。Jira、Confluence、Cursor、企业微信、追平资料等是按需集成，缺少时明确报告待配置能力；不能把页面启动当成外部集成验收。

功能规则：

- 接口返回的展示文案原样显示，不翻译或改写 API 文案。
- 保持既有交互、同源保护、确认标识、会话锁、重试和证据门禁。不要为了演示放宽保护。
- 使用 .env 和 .data 保存接收者自己的配置与数据；不得提交凭据、会话、项目扫描结果、附件和联调截图。
- 修改代码后运行受影响的测试与 `pnpm build`，检查实际结果。
- 技术方案配套 Skill 在 support/skills，规范模板在 support/ai-delivery-kit；不要自动覆盖用户已安装的 Skill 或 Codex 配置。
- 启用自动派发、发送群消息、写 Jira/Confluence、推送/合入或部署，必须在用户授权范围内执行并回读结果。
