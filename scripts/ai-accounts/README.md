# 工作台 AI 账号管理

入口：工作台页头「多账号管理」。Cursor、Codex、Claude Code 支持 CLI 账号保存、官方登录和切换；桌面端独立展示安装与账号记录，并提供官方应用入口。未接入 CLI 多账号管理的平台跳过 CLI，不阻断桌面端登录。

1. 新账号：点击「添加并登录」，自动打开 CLI 官方授权窗口；名称自动生成，无需填写邮箱或本地名称。授权完成后保存账号，再尝试切换本机 CLI。切换成功后打开已安装的桌面端，由用户在官方应用内完成同一账号的登录。两端授权按顺序进行。
2. 本机已经登录：点击「保存本机账号」，刷新并验证本机 CLI 登录后保存到列表，已有匹配账号沿用原名称。浏览器登录需先走官方授权，不能直接导入浏览器凭据。
3. 已保存账号：点击「切换使用」切换 CLI，然后打开已安装的桌面端确认账号；凭据过期时点击该行「重新登录」，完成授权后更新并尝试启用该账号。
4. 如新窗口被拦截，点击「继续官方登录」。返回页面后自动检查，也可点击「检查登录结果」。CLI 切换受运行任务阻止时，账号仍保留在列表，任务完成后点击「继续使用已保存账号」。取消与失败分别保留保存、CLI 启用和桌面打开的真实结果；需要回退 CLI 时使用「恢复上次登录状态」。

桌面端的本机缓存只标记“本机记录待确认”，不能作为有效登录证明。打开应用也不代表登录成功；桌面应用没有公开自动登录接口时，需在应用内完成官方授权。CLI 身份与运行中的桌面账号分别核验。

CLI 管理使用这台 Mac 的原生认证存储。Codex 使用官方 ChatGPT 登录及 `auth.json` 文件存储；Claude Code 使用默认配置目录下的官方 OAuth 登录。API Key、外部认证提供方及托管登录覆盖配置不在当前范围内。Claude Code 同时提供工作台任务执行器，需先完成官方 CLI 登录；支持工作区 Agent、Plan 和 Ask，不支持完全访问。执行时关闭自定义命令、插件与外部 MCP，Ask/Plan 只开放文件读取工具，Agent 通过受限文件工具与 Bash 沙箱执行；这些限制不等于对整个 CLI 进程的操作系统级隔离。

已保存的凭据存放在 macOS 钥匙串：`local.delivery-ai-accounts.codex`、`local.delivery-ai-accounts.claude`。`~/.local/share/delivery-ai-accounts/{provider}/accounts.json` 只存名称、邮箱、团队和恢复标记。`@previous` 保存上次操作前的登录状态。Cursor 保持原存储，与 `cursor-accounts` 命令共享。

切换 Codex 只更新其官方认证文件，不修改配置和会话。Claude 只更新原生 `claudeAiOauth`、`oauthAccount` 字段，保留其他配置。官方 CLI 仍使用自身的凭据存储；保存的账号副本不以明文文件存放。

有运行任务时仍可保存、添加账号。添加使用独立临时凭据目录，Claude 同时使用独立临时钥匙串项；退出登录流程后清理。保存后切换 CLI 才进入 Agent 维护门禁，授权等待期间不会暂停任务。Codex、Claude 的工作台运行或排队任务会阻止切换，Cursor 还检查本机活动 Agent；常驻 app-server/exec-server 不作为活动任务。关闭账号弹窗不会取消正在等待的官方登录，再次打开可继续或取消。Codex、Claude 显示的「状态未核验」表示仅读取了本机账号记录，不代表联网认证成功。

Claude CLI 查找顺序为 `DELIVERY_CLAUDE_BIN`（显式配置时仅使用该路径），然后官方原生安装 `~/.local/bin/claude`、旧工作台安装 `~/.local/share/delivery-ai-clis/node_modules/.bin/claude`、PATH。Codex 沿用工作台的 `DELIVERY_CODEX_BIN` 与已安装 CLI。

验证命令：

```sh
/usr/bin/python3 -m unittest discover -s scripts/ai-accounts -p 'test_*.py'
pnpm exec tsx --test test/ai-accounts.test.ts test/cursor-accounts.test.ts test/cursor-accounts-route.test.ts test/cursor-accounts-dialog.test.ts test/cursor-account-maintenance.test.ts test/desktop-accounts.test.ts test/agent-runtime.test.ts
pnpm build
```

自动化测试使用隔离配置、模拟钥匙串和假 bridge，不操作真实账号。官方登录链接生成与取消另在临时目录验证。真实双账号切换须由用户完成官方登录后验收。
