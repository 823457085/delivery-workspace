---
name: delivery-gate-docs
description: AI Delivery Kit workflow and artifact entrypoint. Use when Codex works on PRD, requirements, prd-self-check, review-minutes, tech-design, test-plan, implementation-plan, self-test-report, pr-checklist, test-report, acceptance-record, review checkpoints, R0/R1/G2/G3/G5/G8/G9, AI Delivery Hub Work Items, AI document revision, or product/dev/test delivery documents. Routes to specialized skills, rules, prompts, and templates.
---

# 需求交付文档（AI Delivery Kit 总入口）

**AI Delivery Kit**: `kit.yaml`

## 包路径解析

先定位 AI Delivery Kit 包根目录，按顺序尝试：

1. 环境变量 `AI_DELIVERY_KIT_ROOT`
2. Codex 安装包：`${CODEX_HOME:-$HOME/.codex}/ai-delivery-kit`
3. 当前仓库根目录存在 `kit.yaml`
4. 当前仓库下 `ai-delivery-kit`
5. 当前仓库同级 `../ai-delivery-kit`
6. 本机常见路径 `${AI_DELIVERY_KIT_ROOT:-$HOME/WorkSpace/ai-delivery-kit}`

后续所有 `core/`、`artifacts/templates/`、`prompts/`、`guides/` 路径都相对这个包根目录。找不到时先说明缺少 AI Delivery Kit 规范源，不要凭记忆编造模板。

推荐团队成员通过安装器安装完整规范源：

```bash
./install.sh codex --validate
./install.sh codex --write-codex-agents /path/to/workspace
```

## 路径

| 类型 | 目录 |
|------|------|
| 规范 | `<AI_DELIVERY_KIT>/core/` |
| 模板 | `<AI_DELIVERY_KIT>/artifacts/templates/` |
| 结构化契约 | `<AI_DELIVERY_KIT>/artifacts/schemas/` |
| 提示词 | `<AI_DELIVERY_KIT>/prompts/` |
| 指南 | `<AI_DELIVERY_KIT>/guides/` |

## 专项 Skills

| Skill | Gate |
|-------|------|
| prd-prototype-challenge | R1a/R1b |
| tech-design-coverage-review | G2a |
| test-plan-coverage-review | G2b |
| self-test-coverage-check | G3 |
| codex-cursor-handoff | 开发便利，可选 |

## 阶段 → 模板 → 提示词

| 阶段 | 模板 | 提示词 |
|------|------|--------|
| S0 | PRD.md | prompts/S0-PRD.md |
| R0 自检 | prd-self-check.md | prompts/R0-prd-self-check.md |
| R1a/R1b | dev/qa-prd-review.md | R1a/R1b + prd-prototype-challenge |
| S1 | review-minutes.md | S1-review-minutes.md |
| S2a | tech-design.md | S2a-tech-design.md |
| S2b | test-plan.md | S2b-test-plan.md |
| 编码执行 / G3 | implementation-plan.md | prompts/G3-implementation-plan.md |
| 编码执行 / G3 | self-test-report.md | S3-self-test-report.md |
| 编码执行 / G3 | pr-checklist.md | 模板直填 |
| 验收发布 / G5 | test-report.md | S4-test-report.md |
| 验收发布 / G5 | acceptance-record.md | S5-acceptance-record.md |
| G8 | release-plan.md | prompts/G8-release-plan.md |
| G9 | outcome-review.md | prompts/G9-outcome-review.md |

## 执行

1. 先按“包路径解析”定位 `<AI_DELIVERY_KIT>`。
2. Read 对应 `prompts/*.md`、`artifacts/templates/*.md`，必要时读取 `core/gates.md` 与 `core/gate-policy.md`。
3. 生成或修订中文文档，ID 连续。
4. 输出自检：覆盖率、问题数、未满足项、风险。
5. 提醒：须人工 Gate 签字。

## AI Delivery Hub / MCP Work Item

当用户要求处理 AI Delivery Hub Work Item 时：

1. 优先使用 `ai-delivery-hub` MCP 工具读取 work item。
2. 按 instruction、review_pack、findings 和 artifact base hash 修订。
3. 只提交 Draft Revision，不发布正式文档，不写 Confluence。
4. 执行过程中按 MCP 能力上报进度；MCP 不可用时不要假装成功。
5. 修订内容仍必须对齐 AI Delivery Kit 对应评审检查点与模板。

## 约束

- G2 PRD 覆盖率 MUST 100%。
- R0 Fail/Partial MUST 说明证据、问题解释、影响、改进方向。
- G3 P0 TC 覆盖率 MUST 100%。
- 不得编造 Pass/覆盖率。
- 不得跳过 Gate。
- 不得把本地 AI 便利流程当成评审检查点强制项。
