# 门禁标准（完整检查表）

> 审核人 AI 预检：`prompts/gate-review.md`。公共流水线/Agent 审核见 `core/ai-gate-engine.md`。

---

## 业务阶段映射

| 业务阶段 | 页面展示建议 | 对应 Gate | 准出责任 |
|----------|--------------|-----------|----------|
| 产品需求设计 | 需求审核 / 需求评审 | R0、R1a、R1b、G1 | 产品负责人、研发负责人、测试负责人 |
| 技术方案设计 | 方案审核 | G2a、G2b | 研发负责人、测试负责人、产品 |
| 编码执行 | 提测准入 / PR 准备 | G3 | 代码 Owner、研发负责人、测试负责人 |
| 验收发布 | 验收准出 / 上线复盘 | G5、G8、G9 | 测试负责人、产品负责人、发布负责人 |

平台和团队沟通 SHOULD 使用业务阶段名称；规则、报告、自动化系统 MAY 使用 Gate Code 做精确定位。

---

## 需求上游

### G0 · Opportunity Brief

| 检查项 | Pass |
|--------|:----:|
| 有真实来源与原始证据 | |
| 描述问题而非仅方案 | |
| 目标用户明确 | |
| AI 已查重 | |
| 产品 Owner 明确 | |

签字：产品负责人 · 模板：`artifacts/templates/opportunity-brief.md`

### PDF-G1 · Discovery Report

| 检查项 | Pass |
|--------|:----:|
| 痛点有访谈/数据/反馈证据 | |
| 目标指标与「为什么现在做」 | |
| 已讨论替代方案 | |
| AI 反方观点已记录 | |

签字：产品负责人 · 模板：`artifacts/templates/discovery-report.md`

---

## 交付主线

### R0 · PRD

| # | 检查项 | Pass |
|---|--------|:----:|
| R0-1 | 核心章节齐全（artifacts/templates/PRD.md） | |
| R0-2 | 每条 US ≥1 可测试 AC | |
| R0-3 | In/Out Scope 清晰 | |
| R0-4 | EX ≥5 或 N/A | |
| R0-5 | EX/NFR 有 ID | |
| R0-6 | CL 与 AC 对应 | |
| R0-7 | 单迭代可交付 | |
| R0-8 | 无敏感信息 | |
| R0-9 | 有指标时 §3.5 埋点非空 | |
| R0-10 | 中高风险 §3.6 灰度非空 | |
| R0-11 | 有 UI 时 §4 PG/UI 页面索引非空 | |
| R0-12 | `prd-self-check.md` 非空，且 Fail/Partial 项解释充分 | |
| R0-13 | PRD 五层结构完整：人读层、AI 读层、行为层、UI 层、验收层 | |
| R0-14 | 原子项有来源或“待评审确认”，未把推断写成事实 | |

签字：研发负责人 + 测试负责人 · 自检模板：`artifacts/templates/prd-self-check.md`

### R1a · 开发预研

R1a-1~9：按时、摘要≥200字、问题≥5、原型审查、Q 可追溯、非敷衍、AI 元信息、每个 Q 有问题解释/影响/改进建议、R1a 澄清率统计。
Blocker/Major 澄清率目标 ≤10%；>20% Fail；P0 主流程存在未确认 AC/BR/FR/SR/PERM/EX 时 Fail。
签字：产品 · Skill：`prd-prototype-challenge`

### R1b · 测试预研

同 R1a + 可测性分析表非空。每个 Q 必须说明为什么不可测或有风险、影响范围、改进建议，并统计 R1b 澄清率。
签字：产品 + 测试负责人

### G1 · 需求评审

G1-1~G1-8：范围、AC、排期、**Q-xxx 全部 Close**；R1 去重后 Blocker/Major 澄清率 ≤10% 或 ConditionalPass 问题已在 `review-minutes.md` 明确关闭。
签字：产品 + 开发 + 测试

### G2a · 技术方案

G2a-1~G2a-11：章节完整、§10 覆盖率 100%、Gap=0。
涉及接口、DB、前端、关键链路时，必须分别对照 [api-contract-standard.md](api-contract-standard.md)、[db-change-standard.md](db-change-standard.md)、[frontend-quality-standard.md](frontend-quality-standard.md) 写清契约、兼容、状态、证据和回滚。
签字：研发 Leader · Skill：`tech-design-coverage-review`

### G2b · 测试方案

G2b-1~G2b-12：AC 追溯、PRD 矩阵 100%、边界、方案改动点。
接口契约、DB 变更和前端关键状态必须有专项测试覆盖或明确 N/A。
签字：测试 Leader + 产品 · Skill：`test-plan-coverage-review`

### G3 · 提测准入

G3-1~G3-11：implementation-plan 清晰、pr-checklist 完整、P0 TC 覆盖率 100%、自测证据可抽查、CI/静态检查通过或说明例外。
涉及代码/MR 时，必测范围的单元测试、Bug Fix 复现用例、单测命令/CI/覆盖率和缺测例外说明按 [unit-test-standard.md](unit-test-standard.md) 审核。
MR 说明、变更范围、权限/幂等/错误处理/可观测性按 [code-review-standard.md](code-review-standard.md) 审核；自测证据质量按 [self-test-evidence-standard.md](self-test-evidence-standard.md) 审核。
签字：测试负责人 · Skill：`self-test-coverage-check`

### G5 · 验收准出

test-report 结论可信；P0 100% Pass；无 open Block；acceptance-record 中 CL 100% Pass。
接口契约、DB/数据验证、前端关键状态和自测证据抽查结果必须与 test-plan 对齐。
签字：产品负责人 + 研发负责人 + 测试负责人

---

## 研发发布

### Backlog 拆解（Sprint Ready）

Story 有 AC；粒度 ≤1–2 人日；依赖清楚；Agent 范围标明。
模板：`artifacts/templates/jira-story.md`

implementation-plan、self-test-report、pr-checklist 统一纳入 G3 提测准入；代码评审与 CI 结果作为 G3 的证据，不再单独设置对外 Gate。

### G8 · Release Ready

灰度、回滚、监控、Release Notes、客户文案审核。
模板：`artifacts/templates/release-plan.md`

---

## 复盘闭环

### G9 · Outcome Review

指标对比、反馈、后续动作、知识库更新。上线后 2–4 周内。
模板：`artifacts/templates/outcome-review.md`

---

## 驳回升级

| 次数 | 处理 |
|------|------|
| 1 | 24h 内修订重提 |
| 2 | 48h + 负责人 1:1 |
| 3 | 升级产品/研发负责人 |
