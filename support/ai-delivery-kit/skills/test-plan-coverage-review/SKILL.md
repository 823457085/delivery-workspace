---
name: test-plan-coverage-review
description: Review test-plan against PRD full coverage, industry boundary testing techniques, and tech-design change impact. For test leaders at G2b. Use when auditing 测试方案, G2b, 用例覆盖, test plan review, or boundary test coverage.
---

# 测试方案覆盖度审核（G2b · 测试 Leader）

## 何时使用

- 审核 `test-plan.md` 是否覆盖 PRD、常见边界测试、**tech-design 改动点**
- Gate **G2b**，审核人：测试负责人 + 产品

## 必填输入

1. `@PRD.md`
2. `@review-minutes.md`（本期 US）
3. `@test-plan.md`（含第 8 章 PRD 覆盖度矩阵）
4. `@tech-design.md`（影响范围、接口、回归面）

## 审核流程

### Step 1 · PRD 覆盖度

同 tech-design 审核：导出 US/AC/EX/NFR/CL 清单，对照 test-plan 第 8 章矩阵。

| 检查 | 标准 |
|------|------|
| 矩阵存在 | 第 8 章 |
| Gap = 0 | |
| 覆盖率 | 100% |
| AC→TC | 每条 AC ≥1 条 P0 TC |

### Step 2 · 验收标准可测性

每条 AC：用例步骤能否验证 Given/When/Then 的 **Then**；预期结果是否可判定 Pass/Fail。

### Step 3 · 业内常见边界测试清单

对本期功能逐项检查是否有对应用例（或 PRD/N/A 合理豁免）：

| # | 类别 | 检查要点 | 关联 TC | Pass |
|---|------|----------|---------|:----:|
| 1 | 等价类 | 有效/无效输入分区 | | |
| 2 | 边界值 | 0、1、min、max、max+1 | | |
| 3 | 空值 | null、空串、缺字段、全空格 | | |
| 4 | 长度 | 超长、截断、emoji | | |
| 5 | 类型 | 错误类型、格式非法 | | |
| 6 | 幂等/重复 | 双击、重复提交、重试 | | |
| 7 | 权限 | 未登录、无权限、越权、角色差异 | | |
| 8 | 并发 | 同时编辑、库存扣减竞态 | | |
| 9 | 超时/失败 | 下游 500、超时、部分成功 | | |
| 10 | 数据态 | 不存在、已删、已过期、状态非法 | | |
| 11 | 业务规则 | 额度、次数、时间窗口 | | |
| 12 | 安全 | 注入、XSS（若涉及输入展示） | | |
| 13 | 兼容 | 端/版本/分辨率（若 PRD 要求） | | |

PRD 中每条 **EX-xxx** 须至少有 1 条 TC 对应。

### Step 4 · 技术方案改动点覆盖

从 tech-design **§3 影响范围** 提取改动项，逐项检查 test-plan：

| 改动项（服务/接口/表/MQ） | 回归/对应用例 TC | Pass |
|---------------------------|------------------|:----:|

| 检查 | 标准 |
|------|------|
| 新接口 | 每个新/改接口 ≥1 用例 |
| 改表/字段 | 数据校验、迁移、旧数据兼容 |
| 配置/MQ | 开关、消息消费、失败重试 |
| 回归范围 | 与 tech-design 一致 |

### Step 5 · Spot Check（≥3 条）

随机 3 条 TC：步骤是否包含 PRD 中的 **字段名、边界值、文案、错误提示**；非空泛「验证功能正常」。

### Step 6 · 可执行性

- 前置条件、环境、造数方案可行
- P0 步骤无歧义

## 输出格式

```markdown
## G2b 测试方案审核报告

**结论**：通过 / 不通过

### PRD 覆盖率
| 指标 | 值 |
| 覆盖率 | % |
| AC→TC 追溯率 | % |

### 边界测试覆盖
| 类别 | 覆盖 | 缺失 TC 建议 |
（表格 13 项）

### 技术方案改动点覆盖
| 改动项 | TC | Pass |

### 必须修复项
1. ...

### Spot Check 发现
1. ...
```

## 硬门槛

- PRD 覆盖率 < 100% → 不通过
- 任一本期 AC 无 P0 用例 → 不通过
- tech-design 影响项无对应用例/回归 → 不通过
- EX 条目无对应用例 → 不通过

**AI Delivery Kit 边界目录**: `ai-delivery-kit/core/boundaries.md`

## 禁止

代替人工签字。
