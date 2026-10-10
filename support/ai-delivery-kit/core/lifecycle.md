# 生命周期与流程

> 对齐《AI 原生产研全流程落地方案》V1.0。本 AI Delivery Kit 覆盖 **需求入口 → 上线复盘** 全链路。

---

## 1. 设计原则

AI Delivery Hub 以需求为协作主线；本 Kit 描述的标准产物、AI 生成、AI 审核报告、人工确认准出与下游流转机制，供 Hub、Codex、Cursor 与嵌入式 gate engine 共同消费。

| 原则 | 要求 |
|------|------|
| AI 默认介入 | 关键节点 Must 有 AI 留痕（见 ai-governance.md） |
| 人类最终负责 | 每 Gate 人工签字；AI 不得代签 |
| 上下文先行 | Agent 必读 Context Pack（context-pack.md） |
| 小步快跑 | Story ≤1–2 人日；单 US ≤3–5 人日；PR 可 Review |
| 质量门禁 | G2 覆盖 100%；G3 计划/自测/PR 准备齐全；G5 验收准出 |
| 知识闭环 | G9 复盘入库；故障 RCA 可检索 |

---

## 2. 团队协作四阶段

AI Delivery Kit 的团队协作总模型见 [team-collaboration-model.md](team-collaboration-model.md)。平台和人工沟通优先使用业务阶段名称，内部规则仍可用 Gate Code 表达。

| 业务阶段 | 标准产物 | AI 职责 | 人工准出 | 对应 Gate |
|----------|----------|---------|----------|-----------|
| 产品需求设计 | PRD、自检、需求范围、验收标准、边界说明 | 生成草稿、补齐结构、挑出遗漏 | 产品负责人审核，研发/测试负责人参与准出 | S0、R0、R1a、R1b、G1 |
| 技术方案设计 | 技术方案、影响范围、风险说明 | 生成方案、检查 PRD 覆盖和风险 | 研发负责人审核，测试/产品确认影响 | S2a、S2b、G2a、G2b |
| 编码执行 | 实施计划、代码、改动说明、自测证据、提测说明、PR Checklist | 辅助编码、生成说明、自测材料和 PR Checklist | 研发负责人 / 代码 Owner 审核 | G3 |
| 验收发布 | 测试用例、测试报告、验收结论、发布计划、复盘 | 生成测试分析、覆盖检查、发布/复盘草稿 | 测试负责人、产品负责人、发布负责人审核 | G5、G8、G9 |

每个阶段都执行同一套机制：

```text
标准产物 → AI 生成 → AI 审核报告 → 人工评审确认准出 → 下游流转 → 持续优化
```

---

## 3. 全链路（四段）

| 段 | Gate | 产出 |
|----|------|------|
| **需求上游** | G0、PDF-G1 | opportunity-brief、discovery-report |
| **交付主线** | R0→G5 | PRD + 自检 + 交付文件链（见 artifacts.md） |
| **研发发布** | G3、G5、G8 | jira-story、implementation-plan、pr-checklist、release-plan |
| **复盘闭环** | G9 | outcome-review → 回流 G0 |

**命名注意**：本包 **G1 = 需求评审会**；PDF 的「产品发现」记为 **PDF-G1**。

### PDF Gate 映射

| PDF | 本包 |
|-----|------|
| G2 PRD Ready | S0 + R0 |
| G3 Design Ready | PRD §4 Figma AI |
| 方案可执行 | S2a + G2a |
| 提测准入 | implementation-plan + self-test-report + pr-checklist |
| G8 Release Ready | release-plan |
| G9 Outcome | outcome-review |

---

## 4. 交付主线串行

```
S0 → R0 → (R1a ∥ R1b) → G1 → (S2a ∥ S2b) → G2 → G3 → G5 → G8 → 上线 → G9
```

### 并行规则

| 并行段 | 规则 |
|--------|------|
| R1a ∥ R1b | R0 后 1 工作日内；**均 Pass 方可 G1** |
| S2a ∥ S2b | G1 后同时启动；**G2a 且 G2b 均 Pass 方可编码** |
| 用例维护 | S2b 后测试可维护用例；G2b 不过不得提测 |

### 时限

| Gate | 提交 | 审核 |
|------|------|------|
| R0 | PRD 完成 | 1 工作日 |
| R1a/R1b | R0 后 1 工作日 | 各 1 工作日 |
| G1 纪要 | 会后 | 4 小时 |
| G2a/G2b | G1 后 1 工作日 | 1 工作日 |
| G3 | 提测时 | 4 工作小时 |

---

## 5. 阶段交接

| 交接 | 上游 Must | 不合格 |
|------|-----------|--------|
| 业务 → 产品 | G0 来源与证据 | 无 Brief 不写 PRD |
| 产品 → 研发 | PRD、prd-self-check、§4 UI 层、AC、§3.5 埋点 | 无 AC 或自检解释不充分不进方案 |
| 研发 → 提测 | implementation-plan、自测证据、PR Checklist | 无 plan 或无自测证据不得提测 |
| 测试 → 发布 | test-report、acceptance-record、风险 | 未过 G5 不得 G8 |
| 上线 → 迭代 | outcome-review | 正式需求 Must 复盘 |

---

## 6. 变更管理

需求变更 Must 同步：PRD、覆盖矩阵、用例、自测报告，并重新走受影响 Gate。

## 7. WIP

- 单 US 开发周期 ≤ 3–5 人日
- 每名开发并行需求 ≤ 2
