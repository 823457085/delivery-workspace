# 07 · 覆盖度计算

## 7.1 PRD 条目集合 P

本期范围 = review-minutes「本期交付 US」关联的全部 Item：

```
P = { US-xxx } ∪ { AC-xxx } ∪ { EX-xxx } ∪ { NFR-xxx }
```

（CL 由 AC 派生，G2 矩阵可含 CL 或仅 AC+EX+NFR，团队统一即可。）

## 7.2 PRD 覆盖率（G2a / G2b）

```
Coverage_PRD = |{ i ∈ P : status(i) = Covered }| / |P| × 100%
```

**Normative**: Coverage_PRD MUST = 100% 方可 G2 Pass。

Partial、Gap 不计入 Covered。产品书面豁免的 Partial 可计 Covered（须记录豁免 ID）。

## 7.3 AC→TC 追溯率（G2b）

```
Trace_AC = |{ ac ∈ AC : ∃ TC 关联 ac 且 priority=P0 }| / |AC| × 100%
```

**Normative**: Trace_AC MUST = 100%。

## 7.4 P0 TC 自测覆盖率（G3）

```
P0 = { tc ∈ test-plan : priority(tc) = P0 }
Covered_P0 = { tc ∈ P0 : self-test 有行且 result=Pass 且 有证据链接 }

Coverage_P0 = |Covered_P0| / |P0| × 100%
```

**Normative**: Coverage_P0 MUST = 100%。

## 7.5 示例

| P0 总数 | 已测 Pass+证据 | 覆盖率 | G3 |
|--------:|---------------:|-------:|:--:|
| 12 | 12 | 100% | Pass |
| 12 | 11 | 91.7% | **Fail** |

## 7.6 AI 输出要求

生成/审核报告 Must 显式输出上述公式与计数，便于 Leader spot check。
