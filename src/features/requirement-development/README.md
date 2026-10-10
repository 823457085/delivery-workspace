# 需求开发

入口：`/agent?view=design`，旧 `/design` 地址仍可用。

填写需求名称、需求 Jira / PRD / 正文、Git 仓库、保存父目录、`feature/` 分支及计划日期；没有需求 Jira 时还需填写 Jira 项目 Key。

点击「创建会话并开始开发」并确认授权后：

1. 服务在父目录下创建唯一的新目录，克隆指定仓库，严格从远端 `master` 的已解析 SHA 创建分支。不修改原检出或未提交文件；无 master 时失败，不回退到其他分支。
2. 直接启动本站 Agent runtime 会话，使用 Codex、`gpt-6-astra`、`xhigh`，默认完全访问权限（可访问工作区外本机文件及网络），自动打开会话。任务范围仍限于本次确认的需求；普通会话默认值与已有会话权限不受影响。不是旧桌面领取链，不需要复制提示词。
3. Agent 按确认的目标连续读取资料、创建/复用 Jira 任务、写方案、流转开发状态、实现、验证与回读。方案默认写入工作区 `docs/requirements/`；提供 Confluence 父页面时才授权发布。
4. Jira/Confluence 的实际访问依赖本机 Codex 配置的工具、登录权限和项目规则。缺资料、权限或审批会阻塞；运行结束不等于 Jira 交付或验收完成，需查看会话中的事实与证据。

不授权提交、推送、合并、部署、关闭原需求或代签审批。业务阶段由 Agent 执行和记录，服务并非独立的确定性 Jira 状态机，启动记录只展示真实 runtime 状态。

服务记录在 `.data/requirement-development/`，同一 requestId 重试复用已有结果；重启不会自动重放中断的准备操作。失败保留新目录，核实后可修改输入重新准备。需求开发页面不再挂载旧方案流程，已有历史数据保持不变，不迁移、不自动重跑。

验证：`tsx --test test/requirement-development.test.ts test/agent-conversation-actions.test.ts test/agent-workspace-navigation.test.ts`。使用临时 Git 仓库和注入的测试 Agent，不操作真实 Jira。
