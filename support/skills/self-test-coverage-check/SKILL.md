---
name: self-test-coverage-check
description: Check developer self-test-report covers all P0 test cases from test-plan with evidence. Use when dev verifies self-test before G3 submit, or test leader audits 提测, G3, TC覆盖, self-test-report, or 自测覆盖.
---

# 自测用例覆盖检查（G3 · 开发 / 测试 Leader）

## 何时使用

- **开发提测前**：自查是否覆盖 test-plan 全部 P0 用例
- **测试 Leader G3 审核**：验证 self-test-report 真实性

## 必填输入

1. `@test-plan.md`（G2b 已通过版本）
2. `@self-test-report.md`（含 TC 覆盖数据章节）
3. 可选：`@PRD.md`（AC 级交叉核对）

## 执行步骤

### Step 1 · 提取 P0 用例清单

从 test-plan 用例表筛选 **优先级 = P0** 的全部 TC-xxx，得到基准列表 N。

### Step 2 · 提取自测记录

从 self-test-report：

- 「测试用例覆盖数据」统计表
- 「P0 用例自测明细」每一行 TC ID、结果、证据链接

### Step 3 · 计算覆盖率

```
P0 自测覆盖率 = 已自测且 Pass 的 P0 TC 数 / P0 总数 × 100%
```

| 指标 | 值 |
|------|-----|
| P0 总数 | |
| 已自测（有明细行） | |
| Pass | |
| Fail | |
| 未测（test-plan 有但 self-test 无） | |
| **覆盖率** | % |

**硬门槛：P0 覆盖率 = 100%，Fail = 0。**

### Step 4 · 差集分析

| TC ID | test-plan 有 | self-test 有 | 结果 | 证据 | 判定 |
|-------|:------------:|:------------:|:----:|:----:|------|
| TC-001 | Y | Y | Pass | 有链接 | OK |
| TC-002 | Y | N | — | — | **遗漏** |

列出全部 **遗漏** 和 **Fail** 和 **Pass 但无证据** 的 TC。

### Step 5 · AC 交叉核对

| AC ID | 关联 P0 TC | 是否全部 Pass | AC 行 Pass |
|-------|------------|:-------------:|:----------:|

AC 自测 Fail 必须为 0。

### Step 6 · Spot Check 证据（≥3 条）

随机 3 个 P0 TC：

| TC ID | 用例关键步骤 | 证据是否匹配 | Pass |
|-------|--------------|:------------:|:----:|

证据不匹配 → 视为未有效自测。

### Step 7 · 结论

| 检查项 | Pass |
|--------|:----:|
| G3-7 覆盖数据章节存在 | |
| G3-8 P0 覆盖率 100% | |
| G3-9 每条 P0 Pass + 证据 | |
| G3-10 spot check ≥3 有效 | |
| G3-11 AC Fail = 0 | |

## 输出格式

```markdown
## 自测覆盖检查报告

**结论**：可提测 / 不可提测

### 覆盖率
| P0 总数 | 已测 | Pass | 覆盖率 |
| | | | % |

### 遗漏 P0 用例
| TC ID | 关联 AC | 建议 |

### Fail / 无证据
| TC ID | 问题 |

### Spot Check
| TC ID | 结果 | 说明 |

### 必须修复（Block G3）
1. ...
```

## 开发自查 vs Leader 审核

| | 开发 | 测试 Leader |
|---|------|-------------|
| 时机 | 填完 self-test 后、提交 G3 前 | 收到提测后 4h 内 |
| 动作 | 按差集补测、补证据 | 同上 + 签字 |

**AI Delivery Kit**: `ai-delivery-kit/core/coverage.md` §7.4

## 禁止

- 编造 Pass 或证据
- 覆盖率未 100% 仍建议提测
- 代替 G3 签字
