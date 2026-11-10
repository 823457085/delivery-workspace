# 工作台 Cursor 账号管理

入口：Agent 工作台左侧底部「AI 账号管理」的 Cursor 标签。当前支持 macOS 本机 Cursor CLI，切换会影响该机器后续的 Cursor CLI 任务。Codex、Claude Code 说明见 [AI 账号管理](../ai-accounts/README.md)。

1. 新账号：点击「官方登录添加」，自动打开官方登录新窗口；名称自动生成，无需填写邮箱或本地名称。由用户在官方页面完成授权，列表会自动更新。当前使用的账号保持不变。
2. 本机已经登录：点击「同步本机账号」，刷新并验证本机 CLI 登录后保存到列表，已有匹配账号沿用原名称。浏览器登录需先走官方授权，不能直接导入浏览器凭据。
3. 已保存账号：点击「切换」启用；凭据过期时点击该行「重新登录」，自动打开官方页面并更新该账号。
4. 如新窗口被拦截，点击「打开官方登录页」继续。登录中可「取消登录」；切换异常时先结束遗留进程，再「恢复上次账号」。

账号凭据保存在 macOS 钥匙串 `local.cursor-accounts.profile`；`~/.local/share/cursor-accounts/accounts.json` 只保存名称、邮箱、团队与恢复状态。与本机 `cursor-accounts` 命令共享数据，不向页面返回 token。`@previous` 备份保存操作前登录状态。

工作台有 Cursor 任务运行时仍可保存、添加账号。网页添加使用独立临时 HOME 与文件凭据存储，结束后清理，不修改当前钥匙串账号。切换、恢复期间暂停 Cursor 任务启动与状态探测；运行/排队任务、独立 CLI 和桌面会话会阻止切换。关闭账号弹窗不会取消正在等待的官方登录，可以再次打开并取消。本机旧版 `cursor-accounts login` 命令仍会添加并切换，受空闲检查保护。

验证命令（项目根目录）：

```sh
python3 -m unittest discover -s scripts/cursor-accounts -p 'test_*.py'
pnpm exec tsx --test test/cursor-accounts.test.ts test/cursor-accounts-route.test.ts test/cursor-account-maintenance.test.ts test/agent-runtime.test.ts
pnpm build
```

Python 测试使用隔离的配置与假钥匙串；Node 测试使用假 bridge/adapter，不操作真实凭据。真实账号切换仍需通过用户的官方登录完成端到端验收。
