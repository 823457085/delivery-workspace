---
name: tech-design-coverage-review
description: Review developer tech-design against PRD for full coverage of US/AC/EX/NFR and acceptance criteria. For engineering leaders at G2a gate. Use when auditing 技术方案, G2a, PRD覆盖, tech-design review, or whether design meets PRD.
---

# 技术方案覆盖度审核（G2a · 研发 Leader）

## 何时使用

- 审核 `tech-design.md` 是否 **覆盖 PRD 全部内容** 且 **符合验收标准**
- Gate **G2a**，审核人：研发负责人（复杂需求 + 架构师）

## 必填输入

1. `@PRD.md`（本期 US/AC/EX/NFR）
2. `@review-minutes.md`（本期交付 US 范围）
3. `@tech-design.md`（含第 10 章 PRD 覆盖度矩阵）
4. 可选：`@.cursor/rules-docs/core.md`（DDD 合规）

## 审核流程

### Step 1 · 建立 PRD 条目清单

从 PRD 导出本期全部 Item（与 review-minutes 本期 US 取交集）：

| Item ID | 类型 | 描述摘要 |
|---------|------|----------|

类型：US / AC / EX / NFR。

### Step 2 · 核对覆盖度矩阵

对照 tech-design 第 10 章：

| 检查 | 标准 | 结果 |
|------|------|:----:|
| 矩阵章节存在 | 第 10 章非空 | |
| 条目完整 | 清单中每条都在矩阵中 | |
| Gap = 0 | 无 Gap 行 | |
| Partial = 0 | 无 Partial 或未豁免 | |
| 覆盖率 | = 100% | |

### Step 3 · AC / 验收标准符合性

对每条 **AC**（Given/When/Then）：

| AC ID | 方案章节 | 设计是否满足 Then | 备注 |
|-------|----------|:-----------------:|------|

Fail 情形：方案未提及、设计与 Then 矛盾、仅写「待实现」。

### Step 4 · EX / NFR 符合性

| ID | PRD 要求 | 方案回应 | Pass |
|----|----------|----------|:----:|

EX：空值、幂等、权限、并发、超时等是否有设计。
NFR：性能/权限/兼容/数据是否有量化或可验证设计。

### Step 5 · 影响范围与回滚

- 服务/DB/接口/配置/MQ 是否与 PRD 范围匹配
- 回滚方案是否存在
- 与 PRD 差异说明：有差异须产品已知悉

### Step 6 · Spot Check（≥3 条）

随机抽 3 条 PRD 细节（字段、流程、错误码、状态机），验证详细设计 **§4** 是否具体回应，非空话。

### Step 7 · 架构合规（简要）

- DDD 分层合理
- 配置/proto 变更已列出
- 外部 API 不用 L 编码

## 输出格式

```markdown
## G2a 覆盖度审核报告

**结论**：通过 / 不通过

### 覆盖率
| 指标 | 值 |
| PRD 条目总数 | |
| 矩阵 Covered | |
| Gap | |
| 覆盖率 | % |

### 检查项
| # | 项 | Pass/Fail | 说明 |
| G2a-8 | 覆盖矩阵存在 | | |
| G2a-9 | 条目完整 | | |
| G2a-10 | 覆盖率 100% | | |
| G2a-11 | Partial=0 | | |
| G2a-12 | spot check ≥3 | | |

### AC 不符合项（必须修复）
| AC ID | 问题 | 建议 |

### EX/NFR 遗漏
| ID | 问题 |

### 必须修复项（Block G2a）
1. ...

### 建议优化项
1. ...
```

## 硬门槛

- 覆盖率 < 100% → **不通过**
- 任一本期 AC 无设计回应 → **不通过**
- 与 PRD 差异未说明 → **不通过**

**AI Delivery Kit**: `ai-delivery-kit/core/coverage.md`

## 禁止

代替人工签字；通过时仍须研发负责人在 tech-design 上签字。
