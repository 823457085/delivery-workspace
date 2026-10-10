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
- 目标版本（Fix Version）
- 实现说明
- 交付物
- 影响范围
- 技术方案链接
- 子任务拆分

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

## Task Group Defaults

When the user gives a version and asks to create Jira tasks for development delivery, default to one DEV parent task assigned to that Fix Version, with a small number of subtasks under it:

1. Resolve the provided Jira version and verify the matching Fix Version before creating issues.
2. Search that Fix Version for an existing DEV parent task by PRD title, feature keywords, and module to avoid duplicates.
3. Create or prepare one DEV parent task when no matching task exists:
   - Issue type: Task or the project's DEV task type, never Sub-task.
   - Title pattern: `【模块】完成 对象开发交付`.
   - Set the provided Fix Version and the assignee when discoverable from context or the current Jira user.
   - Description must follow the DEV Parent Description Template below.
4. Create or prepare these two subtasks under the DEV parent by default:
   - `【模块】编写 对象技术方案`
   - `【模块】实现 对象功能`
5. Add `【模块】完成 对象联调与自测` only when integration or self-test is a distinct, independently verifiable deliverable.
6. Keep the group small: default to 2 subtasks and do not exceed 3 unless the user explicitly requests a finer breakdown or independent owners make it necessary.
7. Do not split subtasks only by page, file, endpoint, or other tiny implementation units.
8. Link the source requirement to the DEV parent. If an existing PRD/requirement issue is found, use an issue link instead of making the DEV subtasks siblings under that requirement.

The technical-design subtask must include the PRD/prototype link, version, scope summary, impact range, planned deliverable, and completion criteria. If the technical design already exists, include its delivered link; otherwise, update the subtask with the link before completing it.

Subtasks should use the same Fix Version when the Jira project supports Fix Version on subtasks. Otherwise, keep the Fix Version on the DEV parent and state the inherited target version in each subtask description.

### Three-Day Functional Slicing Guard

Apply this guard when creating or checking a DEV parent task that has explicit target start and end dates:

- Calculate the inclusive working-day span from Jira target start `customfield_10109` through target end `customfield_10110`. Saturday and Sunday are rest days and do not count toward the span.
- When the span exceeds three working days, create or ensure requirement-based functional subtasks in consecutive working-day segments of no more than three days. Do not start, end, or assign work on Saturday or Sunday.
- Count technical design, each independently verifiable requirement function, integration/self-test, regression, and delivery preparation as functional slices. Reuse existing children before creating anything.
- Derive every title from the PRD, parent scope, or an existing functional deliverable and keep the normal `【模块】动作 对象/结果` pattern. Never expose mechanical titles such as `【3天进度切片 i/n】`.
- Keep child dates continuous across working days without gaps or overlap; weekend gaps are intentional rest days. Order technical design first, requirement implementation next, and integration/self-test or delivery verification last.
- Search by parent, business scope, date range, and the scheduling marker in the description; reruns must update or reuse the same child instead of creating duplicates.
- Inherit the parent, assignee, and required project fields such as Component. Set the segment start and end dates. Set Fix Version when the subtask screen permits it; otherwise state the inherited version in the description.
- Store the machine-readable scheduling marker in the description, never in the visible title.
- If Jira rejects a required field, inspect create metadata or the returned field error, inherit the corresponding parent value when valid, and read the created issue back. Do not retry blindly.
- When an authorized automation closes an ended functional subtask, follow the project's valid forward transitions, for example `待开始 -> 开发中 -> 测试中 -> 已完成`. Date arrival closes that functional subtask. The DEV parent still requires all child results and delivery evidence before completion.

If the user explicitly asks for only one issue, create only that issue.

### Mandatory Hierarchy Guard

When the user provides a prototype/PRD link and a version and asks to create Jira tasks for development delivery:

- Always check that one matching DEV parent task exists in the target Fix Version.
- Always check that the DEV parent contains both required subtasks:
  - `【模块】编写 对象技术方案`
  - `【模块】实现 对象功能`
- If the DEV parent already exists, create only missing subtasks and do not create another parent.
- If either required task already exists as a standalone or incorrectly placed issue, prefer moving or linking it under the DEV parent when Jira hierarchy permits; do not duplicate it.
- Do not report Jira task creation as complete until the parent-child hierarchy, Fix Version, required descriptions, and technical-design deliverable status have been verified, unless the user explicitly narrowed the request to one issue.

## DEV Parent Description Template

Use Markdown input; Jira tooling may convert it to Jira wiki markup.

```markdown
**需求来源**
- [PRD 标题|PRD链接URL]

**目标版本**
- Fix Version：vX.X.X.X

**实现说明**
- 功能目标与关键范围
- 不在本任务范围内的内容

**交付物**
- 接口/页面/服务/配置

**影响范围**
- 模块/服务/端

**技术方案**
- [技术方案标题|Confluence链接URL]（未产出时标记为待补充）

**子任务拆分**
- 编写技术方案
- 开发实现
- 联调与自测（仅在必要时创建）
```

## DEV Description Template

Use this template for development implementation subtasks. Markdown input may be converted to Jira wiki markup by Jira tooling.

```markdown
**需求来源**
- [PRD 标题|PRD链接URL]

**父任务**
- [DEV 主任务标题|Jira链接URL]

**目标版本**
- Fix Version：vX.X.X.X

**实现说明**
- 功能点 1
- 功能点 2

**交付物**
- 接口/页面/服务/配置

**影响范围**
- 模块/服务/端

**技术方案**
- [技术方案标题|Confluence链接URL]

**验收标准**
- 可独立验证的完成条件
```

## Compliance Review

Check in order:

1. Title follows module/action/object-result naming.
2. Issue type is clear: PRD, DEV, TEST, or RELEASE.
3. Required fields for that type are present.
4. A newcomer can understand the task without hidden context.
5. Links to AI Delivery artifacts, PRD, tech design, test plan, or release plan are valid.

For DEV parent tasks longer than three working days, use the small functional hierarchy and the Three-Day Functional Slicing Guard together. Each slice must map to a real requirement or delivery result.
