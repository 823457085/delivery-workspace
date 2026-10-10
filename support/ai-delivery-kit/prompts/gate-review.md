# Gate 预检提示词（R0–G5）

| 项 | 内容 |
|----|------|
| 用途 | 审核人签字前用 AI 做合规预检 |
| 检查表权威源 | [core/gates.md](../core/gates.md) |
| 原则 | AI 输出预检意见，**不能代替签字** |

---

## R0 · PRD（研发负责人 + 测试负责人）

```
你是研发交付门禁审核人。请对 @PRD.md 和 @prd-self-check.md 做 R0 预检，
对照 ai-delivery-kit/core/gates.md 的 R0 检查表逐项 Pass/Fail。

额外检查 AI 友好（core/ai-friendly.md）：
- BG/OBJ/SCOPE/RISK/US/BR/FR/SR/PERM/EX/AC/PG/UI/NFR/CL/EVT ID 齐全
- 有 UI 时 §4 含 Figma AI 链接 + 页面索引 PG-xxx
- 有指标需求时 §3.5 埋点非空
- prd-self-check.md 中所有 Fail / Partial 是否解释充分

输出：
## R0 预检：通过 / 不通过
| R0-x | 结果 | 原文/原型证据 | 问题解释 | 评审影响 | 改进方向 | 是否阻塞 |

要求：
- Fail / Partial / Pass with Warning 不得只写一句话
- 必须说明为什么不通过
- 必须说明对产品、开发、测试、上线或验收的影响
- 必须给出可执行改进方向
- 自检报告解释不充分时，R0-12 判 Fail

必须修复项 / 建议优化项
不要代替人工签字。
```

---

## R1a · 开发预研（产品）

```
按 prd-prototype-challenge 标准对 @dev-prd-review.md 做 R1a 预检，
对照 core/gates.md R1a 检查表，输出 R1a-1~9 及通过/不通过。
检查每个 Q-xxx 是否包含问题解释、影响、改进建议、是否 Block G1。
检查 R1a 澄清率是否已统计；Blocker/Major 澄清率 >20% 或 P0 主流程存在未确认核心规则时判不通过。
```

---

## R1b · 测试预研（产品 + 测试负责人）

```
对 @qa-prd-review.md 做 R1b 预检，对照 core/gates.md R1b 检查表，
含可测性分析是否具体、问题是否≥5且引用 ID。
检查每个 Q-xxx 是否包含问题解释、影响、改进建议、是否 Block G1。
检查 R1b 澄清率是否已统计；Blocker/Major 澄清率 >20% 或 P0 主流程存在未确认核心规则时判不通过。
```

---

## G1 · 评审纪要（产品 + 开发 + 测试）

```
请对 @review-minutes.md、@PRD.md、@dev-prd-review.md、@qa-prd-review.md 做 G1 预检。
检查 G1-1~7、Q-xxx 是否关闭、是否跳过 R1、排期是否合理。
检查 R1 去重后 Blocker/Major 澄清率是否 ≤10%；若 >10%，必须在 review-minutes 中逐条关闭。
输出：通过 / 有条件通过 / 不通过 + 必须修复项。
```

---

## G2a · 技术方案（研发 Leader）

```
按 tech-design-coverage-review skill 审核 @tech-design.md @PRD.md
或对照 core/gates.md G2a 检查表：§10 PRD 覆盖矩阵 100%、影响范围、回滚、差异说明。
额外对照 core/api-contract-standard.md、core/db-change-standard.md、core/frontend-quality-standard.md：
接口契约、错误码、鉴权、幂等、DB migration、索引、兼容/回滚、前端关键状态是否清楚。
```

---

## G2b · 测试方案（测试 Leader + 产品）

```
按 test-plan-coverage-review skill 审核 @test-plan.md @PRD.md @tech-design.md
或对照 core/gates.md G2b：§8 覆盖 100%、边界目录 B1–B13、§9 方案改动点。
额外检查接口契约、DB 变更、前端状态的专项测试覆盖，确保每类高风险变更都有 TC 或明确 N/A。
```

---

## G3 · 提测准入（研发负责人 + 测试负责人）

```
按 self-test-coverage-check skill 审核 @implementation-plan.md @self-test-report.md @pr-checklist.md @test-plan.md。
implementation-plan 须清楚，PR checklist/CI 须有结果，P0 TC 覆盖率须 100%，Pass 须有证据，TC ID 与 test-plan 一致。
若涉及代码/MR，必须同时对照 core/unit-test-standard.md 审核：必测范围是否补单测、Bug Fix 是否有复现用例、单测命令/CI/覆盖率是否可追溯，缺测例外是否有风险和关闭计划。
同时对照 core/code-review-standard.md 和 core/self-test-evidence-standard.md 审核：MR 说明、变更范围、权限/幂等/错误处理/可观测性、证据质量、未覆盖例外是否完整。
```

---

## G5 · 验收准出（测试 + 产品 + 研发）

```
对 @test-report.md 和 @acceptance-record.md 对照 @test-plan.md、@PRD.md 做 G5 预检：
P0 Pass 100%、缺陷闭环、CL Fail = 0、staging 演示项齐全。
抽查接口契约、DB/数据验证、前端关键状态和自测证据是否按 test-plan 完成。
对照 core/gates.md G5 检查表逐项输出。
```

---

## G8 · 发布（发布负责人）

```
对 @release-plan.md 对照 @test-report.md 做 G8 预检：灰度、回滚、监控、Release Notes。
```

---

## G9 · 复盘（产品负责人）

```
对 @outcome-review.md 对照 @PRD.md 目标指标做 G9 预检：指标对比、后续动作、知识库更新。
```
