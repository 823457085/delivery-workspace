---
name: jira-task-compliance
description: Check, complete, or create compliant Jira PRD, DEV, TEST, and RELEASE tasks for product, development, QA, and release workflows. Use when the user asks about Jira task creation, Jira issue compliance, task description completion, or linking AI Delivery Kit artifacts to Jira work items.
---

# Jira Task Compliance

Use this skill to review or prepare Jira tasks that connect delivery artifacts to execution work.

## Tooling

If an Atlassian MCP connector is available, prefer:

- `jira_get_issue` with full fields for inspection
- `jira_update_issue` after user confirmation
- `jira_create_issue` for new tasks
- `confluence_get_page` when task evidence points to Confluence

If MCP is unavailable, produce a copy-ready Jira title and description.

## Naming

Task titles should follow:

```text
【模块】+【动作】+【对象/结果】
```

Examples:

- PRD: `【支付】支持北美分期支付`
- DEV: `【支付】实现分期订单状态机`
- TEST: `【v1.x.x.x】版本功能测试`
- RELEASE: `【发版】2026-03-15 支付分期上线`

Avoid vague words such as `优化`, `调整`, `相关`, and `处理一下` unless the object and outcome are still concrete.

## Required Fields

### PRD

- 背景/问题
- 目标
- 需求范围
- 验收标准
- PRD/原型/评审纪要链接

### DEV

- 需求来源
- 实现说明
- 交付物
- 影响范围
- 技术方案链接

### TEST

- 测试范围
- 测试方式
- 风险点
- 测试结论

### RELEASE

- 需求列表
- 发版时间
- 回滚方案
- 负责人和值班人

## DEV Description Template

Use Markdown input; Jira tooling may convert it to Jira wiki markup.

```markdown
**需求来源**
- [PRD 标题|PRD链接URL]

**实现说明**
- 功能点 1
- 功能点 2

**交付物**
- 接口/页面/服务/配置

**影响范围**
- 模块/服务/端

**技术方案**
- [技术方案标题|Confluence链接URL]
```

## Compliance Review

Check in order:

1. Title follows module/action/object-result naming.
2. Issue type is clear: PRD, DEV, TEST, or RELEASE.
3. Required fields for that type are present.
4. A newcomer can understand the task without hidden context.
5. Links to AI Delivery artifacts, PRD, tech design, test plan, or release plan are valid.

For DEV tasks longer than three working days, recommend splitting into independently verifiable subtasks.
