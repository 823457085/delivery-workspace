# Cursor 使用指南

> **AI Delivery Kit 包**：`ai-delivery-kit/`  
> **安装 Cursor 规范包**：`./install.sh cursor --validate --write-cursor-rules /path/to/workspace`  
> **提示词索引**：[prompts/README.md](../prompts/README.md)

---

## 1. 基本原则

1. **AI 出草稿，人做审核**：所有产出必须经对应 Gate 人工签字，AI 不能代替签字。
2. **共写 AI 友好文档**：产品 PRD、测试 test-plan、开发 tech-design 须结构化（ID + 表格 + 稳定路径）。详见 [core/ai-friendly.md](../core/ai-friendly.md)。
3. **Figma AI 双轨**：产品在 Figma AI 出原型，**誊写** PRD §11 页面索引；编码 Agent 读 Markdown，不直连 Figma。
4. **先给上下文，再跑提示词**：按可读链一次 `@` 齐：`PRD.md` → `prd-self-check.md` → 纪要 → `tech-design.md` → `test-plan.md`，并附代码路径。
5. **严格套用模板**：输出与 `ai-delivery-kit/artifacts/templates/` 同名文件结构一致。
6. **禁止敏感信息**：密钥、生产数据、真实用户信息不得粘贴进 AI 对话。
7. **ID 全程可追溯**：US-xxx → AC-xxx → TC-xxx → CL-xxx；Q-xxx 引用 ID 或 PG-xxx。
8. **AI 产出可审计**：R1/S2/S3 须填 AI 工具、生成/修订时间；R1 摘要 ≥200 字且禁止复制 PRD。
9. **Fail/Partial 必须讲清楚**：R0 自检与 R1 Q 项必须包含证据、问题解释、影响、改进建议。
10. **开发任务可选交接 skill**：开发工程师需要 Codex 规划、Cursor 执行、Codex 验收时，可用 `codex-cursor-handoff` skill 生成 `.ai-handoff/` 交接物。

---

## 2. 阶段与提示词对照

| 阶段 | 角色 | 输出文件 | 提示词 | Gate | AI |
|------|------|----------|--------|------|:--:|
| S0 | 产品 | `PRD.md` | [S0-PRD.md](../prompts/S0-PRD.md) | R0 | 建议 |
| R0 自检 | 产品/审核人 | `prd-self-check.md` | [R0-prd-self-check.md](../prompts/R0-prd-self-check.md) | R0 | 建议 |
| R1a | 开发 | `dev-prd-review.md` | [R1a](../prompts/R1a-dev-prd-review.md) | R1a | **必须** |
| R1b | 测试 | `qa-prd-review.md` | [R1b](../prompts/R1b-qa-prd-review.md) | R1b | **必须** |
| S1 | 产品 | `review-minutes.md` | [S1](../prompts/S1-review-minutes.md) | G1 | — |
| S2a | 开发 | `tech-design.md` | [S2a](../prompts/S2a-tech-design.md) | G2a | **必须** |
| S2b | 测试 | `test-plan.md` | [S2b](../prompts/S2b-test-plan.md) | G2b | **必须** |
| S3 | 开发 | `self-test-report.md` | [S3](../prompts/S3-self-test-report.md) | G3 | **必须**核查 |
| S4 | 测试 | `test-report.md` | [S4](../prompts/S4-test-report.md) | G5 | 建议 |
| S5 | 产品 | `acceptance-record.md` | [S5](../prompts/S5-acceptance-record.md) | G5 | — |

审核人预检：[gate-review.md](../prompts/gate-review.md)

---

## 3. 通用操作步骤（Cursor）

### 方式 A：@ 模板 + 提示词（推荐）

1. 在 `requirements/{迭代}-{需求}/` 下打开目标文件
2. `@ai-delivery-kit/artifacts/templates/PRD.md`（或对应模板）
3. 打开 [prompts/](../prompts/) 对应文件，复制「主提示词」
4. 补充需求素材（见 §4）
5. 对照模板「生成后自检」或 Gate 检查表

### 方式 B：Skill 一句话

```
请按 delivery-gate-docs skill，帮我生成 S2a 技术方案，需求素材：...
```

如果业务项目已安装 `.cursor/rules/ai-delivery-kit.mdc`，也可以更自然地说：

```text
按 AI Delivery Kit 生成/修订这个 PRD
```

Cursor 应先读取规则里声明的 AI Delivery Kit package root，再读取对应 `core/`、`artifacts/templates/`、`prompts/`。

### 方式 C：审核人 Gate 预检

使用 [prompts/gate-review.md](../prompts/gate-review.md) 对应段落；最终仍须人工签字。

### 方式 D：开发工程师 Codex 规划 + Cursor 执行 + Codex 验收

仅适用于开发工程师的代码开发、前端调整、缺陷修复、重构等本地实现任务。产品、测试不需要按该方式维护 `.ai-handoff/`。该方式由 `codex-cursor-handoff` skill 提供便利性，不是 Gate 强制要求，也不是 AI Delivery Hub / `ai-delivery-hub` 必须编排的产品能力。

你可以只对 Codex 说：

```text
帮我规划 ai-delivery-hub-web 前端重构，交给 Cursor 做
```

如果希望 Codex 直接调用本机 Cursor CLI / Cursor Agent，就说：

```text
帮我规划 ai-delivery-hub-web 前端重构，并直接让 Cursor 执行，你来验收
```

Codex 内部会按 skill 做三件事：

1. 生成：
   - `.ai-handoff/current-task.md`
   - `.ai-handoff/acceptance-checklist.md`
2. 让 Cursor 执行或给出 Cursor 执行提示：
   - 读取上述两个文件。
   - 只修改计划允许范围内的文件。
   - 不提交 git commit / push / merge。
   - 完成后写 `.ai-handoff/cursor-result.md`。
3. Codex 验收：
   - 读取 `.ai-handoff/` 交接物。
   - 查看 git diff 和测试结果。
   - 输出 `.ai-handoff/codex-review.md`。

仅在手工模式下，才需要给 Cursor 复制这段最小提示词：

```text
请读取 .ai-handoff/current-task.md 和 .ai-handoff/acceptance-checklist.md 执行开发。
只修改计划允许范围，不要 git commit/push/merge。
完成后写入 .ai-handoff/cursor-result.md，记录修改摘要、验证结果、未完成项和与计划偏差。
```

---

## 4. 各阶段必填输入

| 阶段 | 最少需要提供 |
|------|--------------|
| S0 | 背景、用户故事；**Figma AI** 链接 + PRD §11 页面索引 |
| R0 自检 | `@PRD.md`、PRD §11、原型/原始需求材料 |
| R1a/R1b | `@PRD.md` §11；Figma 链接（人工对照） |
| S1 | R0 PRD、R1 双 Pass 报告、会议结论、排期 |
| S2a | G1 通过 PRD、review-minutes、**代码路径** |
| S2b | G1 PRD、tech-design（建议一并提供） |
| S3 | PRD、tech-design、test-plan、PR/diff、自测结果 |
| S4 | test-plan、self-test-report、缺陷列表 |
| S5 | PRD §8 验收清单、test-report、staging 说明 |

---

## 5. 需求目录

```
requirements/{迭代}-{需求简称}/
├── PRD.md
├── prd-self-check.md
├── dev-prd-review.md
├── qa-prd-review.md
├── review-minutes.md
├── tech-design.md
├── test-plan.md
├── self-test-report.md
├── test-report.md
├── acceptance-record.md
└── ai/                    # 可选
    └── source-notes.md
```

初始化命令见 [README.md](../README.md)。

---

## 6. 常见问题

**Q：只有 Figma 链接，开发 AI 能读吗？**  
A：不能。产品须把 §11 页面索引与主流程誊写进 PRD（见 core/ai-friendly.md §11.4）。

**Q：能否跳过 R1 直接开评审会？**  
A：不可以。R1a/R1b 均 Pass 后方可 G1。

**Q：能否一次生成全部文档？**  
A：不可以。每阶段依赖上游 Gate 通过的文档。

---

## 7. 相关文档

| 文档 | 路径 |
|------|------|
| 流程图 | [lifecycle.md](./lifecycle.md) |
| 角色速查 | [quick-start-by-role.md](./quick-start-by-role.md) |
| 专项 Skills | [README.md](../README.md) § Cursor 一句话 |
