# 代码评审规范

> 适用范围：研发提交 PR/MR、GitLab Hook 自动 Review、G3 提测准入和技术负责人 Code Review。语言不限；项目已有更严格规则时，以项目规则为准。

## 1. 目标

代码评审的目标不是替代研发负责人判断，而是让每次代码变更都能被稳定地检查以下问题：

1. 是否完整覆盖需求与技术方案。
2. 是否引入业务、权限、数据、稳定性或安全风险。
3. 是否具备足够的单元测试、自测和 CI 证据。
4. 是否能在出问题时定位、回滚和止血。

## 2. 必查维度

| 维度 | 检查要求 |
|------|----------|
| 需求覆盖 | MR 说明 MUST 关联需求、AC/EX/NFR、tech-design 或 implementation-plan |
| 变更范围 | MUST 说明改了哪些模块、接口、表、配置、任务、消息或前端页面 |
| 业务规则 | MUST 覆盖正常、边界、异常和不允许路径 |
| 权限与数据隔离 | 涉及用户、角色、租户、组织或内部系统权限时 MUST 明确拒绝路径 |
| 幂等与并发 | 涉及回调、队列、重试、支付、库存、状态流转时 MUST 检查重复触发和并发 |
| 错误处理 | MUST 区分用户错误、业务错误、依赖错误、系统错误，并给出可诊断日志 |
| 可观测性 | 关键链路 SHOULD 有 trace id、结构化日志、指标或审计记录 |
| 测试证据 | MUST 对照 `unit-test-standard.md` 和 `self-test-evidence-standard.md` |
| 安全合规 | MUST 检查密钥、PII、支付数据、内部地址、越权和日志泄露 |
| 回滚 | 高风险变更 MUST 有开关、回滚或补偿说明 |

## 3. 自动 Review 级别

| 情况 | 默认级别 |
|------|----------|
| 核心业务、金额、权限、状态机、Bug Fix 改动无测试且无例外说明 | blocker |
| PRD/tech-design 明确要求未实现，或实现与 AC 冲突 | blocker |
| 破坏接口兼容、数据库兼容或权限边界 | blocker |
| 缺少关键错误处理、幂等、事务边界或回滚说明 | major |
| 自测证据不完整、覆盖关系不清 | major |
| 命名、重复代码、局部可读性、注释不足 | minor |

## 4. MR 必备信息

| 字段 | 要求 |
|------|------|
| 需求关联 | 需求 ID / Hub 文档 / Jira / Story |
| 变更摘要 | 3-8 条，说明用户可见变化与内部变化 |
| 影响范围 | 服务、模块、接口、DB、配置、定时任务、MQ、前端页面 |
| 测试结果 | 单测命令、CI 链接、自测证据、未覆盖说明 |
| 风险与回滚 | 风险、灰度、回滚、监控和负责人 |

## 5. Hub / GitLab Hook 接入

GitLab Hook 自动 Review SHOULD 读取：

1. MR payload、diff、changed files、CI 结果。
2. Hub 中关联需求的 PRD、tech-design、test-plan、implementation-plan。
3. 本规范、`unit-test-standard.md`、`api-contract-standard.md`、`db-change-standard.md`。

输出 finding MUST 包含：规则、证据、影响、建议动作、是否阻断。

