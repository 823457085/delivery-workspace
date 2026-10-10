# AI 治理

> 对齐《AI 原生产研全流程落地方案》§17。

---

## 1. 总原则

- AI 生成 **草稿**，人 **修订** 后提交 Gate
- AI **不得** 代替签字
- 敏感信息 **Must Not** 进入 AI 上下文（D 级）
- 团队协作按 [team-collaboration-model.md](team-collaboration-model.md) 执行：标准产物 → AI 生成 → AI 审核报告 → 人工评审确认准出 → 下游流转 → 持续优化

---

## 2. 强制使用矩阵

| 阶段 | AI | Skill | 人工审什么 |
|------|:--:|-------|------------|
| R1a | **MUST** | prd-prototype-challenge | 认真读 PRD+§4 UI 层 |
| R1b | **MUST** | prd-prototype-challenge | 同上+可测性 |
| S2a | **MUST** | delivery-gate-docs | §10 覆盖 100% |
| G2a | SHOULD | tech-design-coverage-review | 方案质量 spot check |
| S2b | **MUST** | delivery-gate-docs | 覆盖+边界+方案改动 |
| G2b | SHOULD | test-plan-coverage-review | 用例质量 |
| S3 | **MUST** | self-test-coverage-check | P0 100%+证据 |
| G3 | SHOULD | self-test-coverage-check | 证据真实 |
| G3 实施计划 | **MUST** | G3 prompt | 先 plan 后提测 |
| G3 PR 证据 | **MUST** | — | pr-checklist+人审 |
| G8 | SHOULD | G8 prompt | 灰度回滚 |
| G9 | SHOULD | G9 prompt | 指标+知识回流 |

---

## 3. 使用分级（A/B/C/D）

| 级别 | 场景 | 要求 |
|------|------|------|
| A | 公开资料、学习 | 建议留痕 |
| **B** | PRD、代码、用例（默认） | **Must** 留痕 |
| C | 客户数据、权限、生产日志 | 批准+脱敏 |
| D | 密钥、PII、支付 | **禁止** |

---

## 4. 统一留痕块（B 级 Must）

片段：`artifacts/templates/_ai-usage-block.md`

R1 额外：AI 工具、生成时间、人工修订时间。

---

## 5. G3 提测准入铁律

- **Must Not** 跳过 `implementation-plan.md` 直接编码
- plan 须开发 Owner 签字确认
- 关键 Gate SHOULD 接入公共 AI Delivery Gate Engine（见 `core/ai-gate-engine.md`），试点成熟后作为 required check

---

## 6. Agent 权限

| 允许 | 禁止 |
|------|------|
| 读任务相关仓库 | 无关仓库、密钥 |
| 写工作分支+PR | 写主干、直接发布 |
| 触发 CI | 绕过失败 |
| 读脱敏监控 | 生产变更、生产 PII |

---

## 7. 开发工程师本地多 AI 工具协作

开发工程师在代码实现、缺陷修复、前端交互调整、重构等开发任务中，可以通过 `codex-cursor-handoff` skill 使用 Codex、Cursor、Claude Code 等本地 AI 工具协作。该方式是便利能力，不是 Gate 强制要求；使用时建议遵循 [local-ai-collaboration.md](local-ai-collaboration.md)：

- Codex / 架构审核工具负责计划与验收时，建议输出可审计的计划、验收清单和 Review 结论。
- Cursor / 编码 Agent 负责执行时，建议留下修改摘要、验证结果、未完成项和偏差说明。
- 本地 AI 协作不得自动等价于 Gate Pass，仍须人工签字。
- 平台、Bridge、CLI、脚本只能作为实现方式；AI Delivery Kit 在该便利流程中只约定推荐交接物和审计口径。
- 产品、测试不需要按本流程维护 `.ai-handoff/`；其工作仍以对应 AI Delivery artifact 和 Gate 为准。

---

## 8. Prompt 与组织

- 标准 Prompt：`prompts/` + `skills/`（`install.sh` 同步）
- AI Champion 维护各职能模板；安全审高风险 Prompt
- 敷衍判定见 [compliance.md](compliance.md)
