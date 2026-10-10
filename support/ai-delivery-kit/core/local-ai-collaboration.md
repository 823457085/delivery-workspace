# 本地 AI 工具协作便利规范

> **定位**：定义开发工程师本地 AI 工具之间的协作协议，让 Codex、Cursor、Claude Code 等工具可以基于同一份 AI Delivery Kit 任务上下文协作。  
> **边界**：这是 AI Delivery Kit 规范，不是 `ai-delivery-hub` 必须实现的产品能力；平台可以提供辅助入口，但不得成为该流程的唯一依赖。
> **适用对象**：仅面向开发工程师在代码实现、缺陷修复、前端交互调整、重构等开发任务中可选使用；产品、测试不需要按本流程操作。
> **强制性**：该流程不是 Gate 硬门槛，不作为强制要求；它以 `codex-cursor-handoff` skill 的形式提供便利性。

---

## 1. 目标

本规范面向开发工程师，在需要多 AI 工具协作时提供便利，解决三个问题：

1. **Codex 规划清楚**：先把任务目标、范围、验收标准和风险写成可执行计划。
2. **Cursor 执行可控**：Cursor 根据计划改代码，并留下执行结果、验证命令和未完成项。
3. **Codex 验收闭环**：Codex 基于 diff、测试结果和执行记录做二次审核，确认是否满足 AI Delivery checkpoint。

开发任务中的推荐默认分工：

| 阶段 | 主工具 | 产出 |
|------|--------|------|
| 规划 | Codex | 任务计划、验收清单、风险约束 |
| 开发执行 | Cursor | 代码改动、执行结果、验证记录 |
| 验收 | Codex | Code Review、Gate 对齐结论、返工项 |
| 人工确认 | Owner | 是否提交、合并、发布 |

产品和测试仍按 `PRD.md`、`prd-self-check.md`、`test-plan.md`、`test-report.md` 等 AI Delivery artifact 工作，不要求维护 `.ai-handoff/`。

---

## 2. 非目标

以下事项不属于本规范的强制要求：

- 不要求 AI Delivery Hub 或 `ai-delivery-hub` 编排 Cursor。
- 不要求平台读取员工本地 Codex / Cursor 会话内容。
- 不要求产品、测试、运营等非开发角色使用本流程。
- 不要求团队统一使用某一个本地 AI 工具。
- 不要求自动提交 git commit、push、merge 或发布。
- 不要求跳过人工 Review、Gate 签字或发布确认。

AI Delivery Kit 在这里提供 **交接物、状态口径、验收标准** 的推荐模板；具体用复制粘贴、CLI、Bridge、脚本或 IDE 插件实现，由团队和个人自行选择。

---

## 3. 协作模式

| 模式 | 说明 | 适用 |
|------|------|------|
| 手工模式 | Codex 输出计划，用户复制给 Cursor，Cursor 执行后再让 Codex 验收 | 默认可用、无环境要求 |
| 本地自动模式 | 本地脚本或个人工具读取计划并调用 Cursor CLI / Cursor Agent | 个人提效，可选 |
| 平台辅助模式 | AI Delivery Hub 生成 Work Item / AI 执行提示词，员工本地 Codex 拉取处理 | 文档协作与 Draft Revision |
| 团队工具模式 | 团队自建 Bridge / Bot / CI 执行 AI Delivery Kit 交接协议 | 规模化试点 |

无论使用哪种模式，建议按 §4 保持交接物结构一致。

---

## 4. 标准交接物

开发工程师推荐在目标代码仓库中使用 `.ai-handoff/` 作为本地 AI 协作目录。

```text
.ai-handoff/
├── current-task.md              # Codex 输出：当前任务计划
├── acceptance-checklist.md      # Codex 输出：验收清单
├── cursor-result.md             # Cursor 输出：执行结果
├── codex-review.md              # Codex 输出：验收结论
└── runs/                        # 可选：命令日志、diff 摘要、截图
```

### 4.1 `current-task.md`

建议包含：

| 字段 | 要求 |
|------|------|
| 任务背景 | 引用 PRD / tech-design / Gate finding / issue |
| 目标 | 明确本次要达成什么 |
| 范围 | 列出允许修改的模块、文件或页面 |
| 非范围 | 明确不做什么，防止 Cursor 扩散 |
| 实施步骤 | 可执行拆分，建议 3-8 步 |
| 风险 | 数据、安全、兼容、回滚或体验风险 |
| 验证 | 必跑命令、手工检查点、截图要求 |

### 4.2 `acceptance-checklist.md`

建议包含可逐项判断的验收项：

```markdown
# Acceptance Checklist

- [ ] AC-001 ...
- [ ] AC-002 ...
- [ ] TEST-001 运行 `...` 通过
- [ ] UI-001 页面在 desktop/mobile 下无重叠
```

### 4.3 任务包强制要素

交给 Cursor / 其他本地实现 Agent 的任务包必须足够具体，至少包含：

| 要素 | 要求 |
|------|------|
| 用户可见目标 | 说明完成后用户能看到、点到或验证到什么 |
| 允许修改范围 | 写明仓库、模块、页面、服务、接口或文件夹 |
| 明确非目标 | 写明本批不处理的内容，防止扩散重构 |
| 当前事实 | 只写 Codex 已从代码或文档读到的事实，不写猜测 |
| 兼容策略 | 明确保留历史兼容，或因测试阶段移除旧命名/旧枚举/旧 API |
| 分步计划 | 3-8 个可执行步骤，每步有可观察结果 |
| 验收命令 | Codex 会复跑的 lint / test / build / go test / browser check |
| 人工/视觉检查 | UI、交互、部署态或第三方系统无法自动判断时必须列出 |

如果用户明确说明「测试阶段、没有历史包袱」，任务包应采用单一新模型，不为旧字段、旧枚举、旧 UI 文案增加兼容分支；需要删除旧逻辑时，应把删除范围和验证方式写清。

### 4.4 `cursor-result.md`

Cursor 执行完成后建议写明：

| 字段 | 要求 |
|------|------|
| 修改摘要 | 改了哪些模块和行为 |
| 文件列表 | 关键文件路径 |
| 验证结果 | 命令、结果、失败原因 |
| 未完成项 | 明确 TODO、风险、需要人工确认的地方 |
| 与计划偏差 | 如果偏离 Codex 计划，建议解释 |

### 4.5 `codex-review.md`

Codex 验收时建议写明：

| 字段 | 要求 |
|------|------|
| 结论 | Pass / ConditionalPass / Fail |
| Findings | 按严重级别列出问题 |
| 验证 | 实际执行或未执行的命令 |
| Gate 对齐 | 是否满足 AI Delivery Kit 当前阶段要求 |
| 后续动作 | 合并、返工、补测或人工确认 |

### 4.6 长任务小步迭代

大型建设任务应先由 Codex 定义整体目标和验收标准，再拆成小批次交给 Cursor 执行。推荐节奏：

1. Codex 读取代码与规范，写出整体目标、边界和批次清单。
2. 每批只解决一个产品化能力或一个明确缺陷簇。
3. Cursor 完成后必须写 `cursor-result.md`。
4. Codex 读取 diff、结果文件和测试输出，复跑关键验证。
5. 只有当前批次通过后，才进入下一批。

批次命名应表达可验收结果，例如「后端 action queue API」、「角色工作台前端接入」、「Draft 审批入口补齐」，避免使用「优化页面」「整理代码」这类不可验收描述。

---

## 5. 推荐流程

### 5.1 Codex 规划

开发工程师可以向 Codex 发起：

```text
帮我规划 ai-delivery-hub-web 前端重构，交给 Cursor 做
```

如果希望 Codex 直接调用本机 Cursor CLI / Cursor Agent：

```text
帮我规划 ai-delivery-hub-web 前端重构，并直接让 Cursor 执行，你来验收
```

Codex 应先读代码与 AI Delivery Kit 上下文，再按 `codex-cursor-handoff` skill 生成交接计划。`.ai-handoff/` 是内部交接物，用户不需要在指令里显式声明。

### 5.2 Cursor 执行

自动模式下由 Codex 调用本机 Cursor CLI / Cursor Agent。手工模式下，给 Cursor 的执行提示词建议包含：

```text
请读取 .ai-handoff/current-task.md 和 .ai-handoff/acceptance-checklist.md 执行开发。

约束：
- 只修改计划允许范围内的文件。
- 不要 git commit、push、merge。
- 执行并记录验证命令。
- 完成后写入 .ai-handoff/cursor-result.md。
- 如果计划不可执行，停止并说明阻塞原因，不要猜测扩散。
```

### 5.3 Codex 验收

Cursor 完成后，用户向 Codex 发起：

```text
请验收 Cursor 的实现。
读取 .ai-handoff/current-task.md、.ai-handoff/acceptance-checklist.md、.ai-handoff/cursor-result.md，
结合 git diff 和测试结果做 Code Review，并写入 .ai-handoff/codex-review.md。
```

Codex 验收应以 Review 姿态输出问题，不能只复述 Cursor 结果。

### 5.4 返工

如果 Codex 验收 Fail 或 ConditionalPass：

1. Codex 在 `codex-review.md` 写清返工项。
2. 用户或自动化工具将返工项追加到 `current-task.md`。
3. Cursor 再执行一轮。
4. Codex 再验收。

---

## 6. 与 AI Delivery checkpoint 的关系

| AI Delivery 阶段 | 本规范作用 |
|---------------|------------|
| G3 实施计划 | `current-task.md` 可作为实现计划的本地执行补充，但不能替代正式 `implementation-plan.md` |
| G3 PR 证据 | `cursor-result.md` 和 `codex-review.md` 可作为 PR Review 辅助证据 |
| G2/G3 | 技术方案、测试方案、自测报告仍以 AI Delivery artifact 为准 |
| AI Delivery Hub Draft Revision | 平台 Work Item 可以生成 AI 执行提示词，但本地 Cursor 编排仍属于个人或团队工具实现 |

**铁律**：本地 AI 协作结果不能自动等价于 Gate Pass；Gate 仍以 AI Delivery artifact、结构化结果和人工签字为准。本流程缺失不应直接导致 Gate Fail。

---

## 7. 安全与审计

1. `.ai-handoff/` 中不得写入密钥、生产 token、真实用户 PII 或未脱敏生产数据。
2. 如果包含内部实现细节，按 B 级资料处理，默认只在受控仓库内留存。
3. Cursor / Codex 可以改工作分支，不得直接写主干。
4. 自动化脚本不得默认执行破坏性命令。
5. AI 执行失败时应留下失败原因，不得假装成功。

---

## 8. 最小可用模板

### 8.1 `current-task.md`

```markdown
# Current Task

## 背景

## 目标

## 允许修改范围

## 不做范围

## 实施步骤

## 风险与注意事项

## 验证命令
```

### 8.2 `cursor-result.md`

```markdown
# Cursor Result

## 修改摘要

## 修改文件

## 验证结果

## 未完成项 / 风险

## 与计划偏差
```

### 8.3 `codex-review.md`

```markdown
# Codex Review

## 结论

## Findings

## 验证

## Gate 对齐

## 后续动作
```
