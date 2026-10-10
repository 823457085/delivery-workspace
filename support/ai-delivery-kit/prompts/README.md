# 提示词索引

按交付物选择一个提示词和对应模板。只在该交付物涉及接口、数据库、前端状态、单测或证据时读取相应专项规范，不要把整套 Kit 当作每次任务的必读上下文。

模板：`../artifacts/templates/` · Gate：`../core/gates.md`

## 交付主线

| 文件 | 产出 | Gate | Skill |
|------|------|------|-------|
| [S0-PRD.md](S0-PRD.md) | PRD.md | R0 | delivery-gate-docs |
| [R0-prd-self-check.md](R0-prd-self-check.md) | prd-self-check.md | R0 | — |
| [S0-prototype-notes.md](S0-prototype-notes.md) | prototype-notes.md | R0 / R1 | delivery-gate-docs |
| [R1a-dev-prd-review.md](R1a-dev-prd-review.md) | dev-prd-review.md | R1a | prd-prototype-challenge |
| [R1b-qa-prd-review.md](R1b-qa-prd-review.md) | qa-prd-review.md | R1b | prd-prototype-challenge |
| [S1-review-minutes.md](S1-review-minutes.md) | review-minutes.md | G1 | delivery-gate-docs |
| [S2a-tech-design.md](S2a-tech-design.md) | tech-design.md | G2a | delivery-gate-docs |
| [S2b-test-plan.md](S2b-test-plan.md) | test-plan.md | G2b | delivery-gate-docs |
| [S2b-test-cases.md](S2b-test-cases.md) | test-cases.md | G2b / G5 | test-plan-coverage-review |
| [S3-self-test-report.md](S3-self-test-report.md) | self-test-report.md | G3 | self-test-coverage-check |
| [S4-test-report.md](S4-test-report.md) | test-report.md | G5 | delivery-gate-docs |
| [S5-acceptance-record.md](S5-acceptance-record.md) | acceptance-record.md | G5 | delivery-gate-docs |

## 研发发布与复盘

| [G3-implementation-plan.md](G3-implementation-plan.md) | implementation-plan | G3 |
| [G8-release-plan.md](G8-release-plan.md) | release-plan | G8 |
| [G9-outcome-review.md](G9-outcome-review.md) | outcome-review | G9 |

## Hub Work Item 映射（Batch 4+）

在 AI Delivery Hub 中，本地 Codex Work Item 可按业务检查点修订标准产物：

| 检查点 | 产物 | Kit 提示词 |
|--------|------|------------|
| 研发预审 | dev-prd-review.md | R1a-dev-prd-review.md |
| 测试预审 | qa-prd-review.md | R1b-qa-prd-review.md |
| 技术方案审核 | tech-design.md | S2a-tech-design.md |
| 测试方案审核 | test-plan.md | S2b-test-plan.md |
| 测试方案审核 | test-cases.md | S2b-test-cases.md |
| 提测准入 | implementation-plan.md | G3-implementation-plan.md |
| 提测准入 | self-test-report.md | S3-self-test-report.md |
| 提测准入 | pr-checklist.md | 模板直填 |
| 验收准出 | test-report.md | S4-test-report.md |
| 验收准出 | acceptance-record.md | S5-acceptance-record.md |

G2a/G2b 审核应维护 PRD 覆盖度矩阵；Hub 会在工作流 API 中展示未覆盖的 PRD Item ID。

## 研发质量规范

生成或审核开发、测试、提测产物时，相关 prompt MUST 按需读取：

| 规范 | 使用场景 |
|------|----------|
| `core/code-review-standard.md` | PR/MR、GitLab Hook Review、G3 提测准入 |
| `core/unit-test-standard.md` | implementation-plan、self-test-report、pr-checklist |
| `core/api-contract-standard.md` | tech-design、test-plan、接口专项验证 |
| `core/db-change-standard.md` | DB/migration、数据修复、回滚和校验 |
| `core/self-test-evidence-standard.md` | G3 自测证据、PR Checklist、测试负责人抽查 |
| `core/frontend-quality-standard.md` | 前端工作台、页面、交互状态和自动化 smoke |
