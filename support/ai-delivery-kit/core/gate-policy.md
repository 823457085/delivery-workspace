# Gate Policy

> 定义公共 AI Delivery Gate Engine 的 Pass / Conditional Pass / Fail / Waived 判定策略。具体检查表以 `core/gates.md` 为权威。

## 1. 总则

| 规则 | 要求 |
|------|------|
| 硬门槛 | 违反 MUST、覆盖率不足、敏感信息、跳过前置 Gate 时，默认 `Fail` |
| 人工签字 | AI Delivery checkpoint 结果不能替代人工签字 |
| 证据优先 | 不能仅凭“看起来完整”判 Pass，必须引用原文、矩阵、链接或 CI 证据 |
| 可修复性 | 每个 Fail / ConditionalPass finding MUST 给出可执行修复建议 |
| 豁免 | 只有指定负责人可批准，且必须有到期时间和补偿措施 |

## 2. 阻断规则

| Gate | Blocker 条件 |
|------|--------------|
| R0 | PRD 缺核心章节；PRD 五层结构缺失；原子项无来源且未标待评审确认；AC 不可测；`prd-self-check.md` 缺失；Fail/Partial 无解释；敏感信息进入文档 |
| R1a/R1b | 问题少于 5 个且无合理 N/A；Q-xxx 无解释/影响/建议；未覆盖原型或可测性；未统计澄清率；Blocker/Major 澄清率 >20%；P0 主流程存在未确认 AC/BR/FR/SR/PERM/EX |
| G1 | R1a/R1b 未 Pass；Q-xxx 未关闭；R1 去重后 Blocker/Major 澄清率 >10% 且未在 review-minutes 关闭；范围/排期/Owner 不明确 |
| G2a | 技术方案覆盖率 < 100%；Gap 未关闭；关键接口/数据/回滚缺失；涉及 DB/migration 但无兼容和校验说明；涉及前端主流程但无关键状态说明 |
| G2b | AC→TC 追溯率 < 100%；边界目录未覆盖；方案改动点无测试策略；接口/DB/前端专项变更无测试覆盖且无 N/A 说明 |
| G3 | `implementation-plan.md` 缺失或未确认；变更文件范围不清；禁止范围缺失；CI/lint/scan 失败且无说明；P0 TC 自测覆盖率 < 100%；Pass 无证据；TC ID 与 test-plan 不一致；核心业务/金额/权限/状态机/Bug Fix 改动缺少单测且无例外说明；关键自测证据不可复核 |
| G5 | P0 未 100% Pass；存在 open Block；CL 未 100% Pass；验收记录缺签字；专项验证结果与 test-plan 不一致且无说明 |
| G8 | 灰度、回滚、监控任一缺失；发布影响范围不清 |
| G9 | 指标无对比；未沉淀后续动作；重大偏差无解释 |

## 3. 有条件通过

以下情况 MAY 判 `ConditionalPass`：

| 场景 | 条件 |
|------|------|
| Minor 缺失 | 不影响当前 Gate 硬门槛，且有明确 owner 和关闭时间 |
| 外部依赖等待 | 有替代验证或补偿措施 |
| 局部 Partial | 产品/研发/测试负责人确认不影响本期范围 |
| 流水线误报 | 有 CI 链接、日志或人工说明证明误报 |

## 4. 豁免

豁免 MUST 使用 `artifacts/templates/gate-waiver.md`，并满足：

| 字段 | 要求 |
|------|------|
| 规则 ID | 明确被豁免的 finding 或 Gate 规则 |
| 批准人 | Gate 对应 A 角色或更高负责人 |
| 有效期 | 必须有日期或版本 |
| 补偿措施 | 测试、监控、灰度、回滚或后续任务 |
| 关闭方式 | 说明如何验证豁免已关闭 |

**Normative**: 涉及敏感信息、PII、密钥、支付数据的 D 级违规不可豁免。

## 5. 分数建议

Score 用于看板趋势，不作为唯一判定依据：

| 扣分项 | 建议 |
|--------|------|
| blocker | -30 到 -50 |
| major | -10 到 -20 |
| minor | -3 到 -5 |
| info | 0 |

存在 blocker 时，即使 score ≥ 80 也 MUST `Fail`。
