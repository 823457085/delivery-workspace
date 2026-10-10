# Jira 修复

入口为 `/agent?view=jira-fix`，在「执行」中与「需求开发」并列。

- 读取已配置 Jira 的事项；自动匹配已保存的 Jira 项目配置，以及任务/父任务对应的本地分支和目录。多个仓库保留选择，不静默选第一个；无法匹配时可选择本地项目或手工输入仓库。
- 配置仓库、保存父目录、远端基准分支和 `feature/` 修复分支。勾选记住配置后，后续同 Jira 项目可自动回填；配置保存在 `.data/jira-fix/projects.json`。
- 启动时重新读取 Jira，在父目录下创建唯一目录、克隆代码、从基准分支的远端 SHA 创建分支，再启动工作区权限的修复会话。不会切换原检出的分支或覆盖未提交文件。
- 修复授权仅含 Jira 读取、代码修复和验证。提交、推送、MR、部署及 Jira/Confluence 写入不在默认授权内。
- 启动记录与 Agent 通过稳定 sourceId 关联。重复请求复用结果；服务中断不会自动重放；克隆失败保留目录供核对，不自动清理用户目录。会话结束不等于问题验收。
- 启动失败且未创建会话的记录可点击「重试」，沿用原配置创建新尝试，保留历史记录和失败目录；准备期间禁止重复点击。Git 错误保留失败步骤和原始原因，不将连接超时统一描述成权限问题。

验证：`tsx --test test/jira-fix.test.ts test/jira-fix-retry.test.ts test/requirement-development.test.ts test/agent-workspace-navigation.test.ts`。测试使用临时 Git 仓库和受控 Agent，不修改真实 Jira。
