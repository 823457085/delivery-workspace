# 09 · 合规与驳回

## 9.1 直接驳回（Must Not Pass）

| 情形 | Gate |
|------|------|
| prd-self-check 缺失或 Fail/Partial 无解释/影响/改进方向 | R0 |
| 预研问题 <5 或「暂无问题」 | R1 |
| R1 Q-xxx 只有“需确认/需补充”，无解释/影响/改进建议 | R1 |
| 摘要复制 PRD 原文 | R1 |
| 无 AI 工具/时间 | R1 |
| 覆盖矩阵缺失 | G2 |
| Gap > 0 或未豁免 Partial | G2 |
| P0 TC 覆盖率 < 100% | G3 |
| Pass 无证据链接 | G3 |
| 跳过 R1 开 G1 | G1 |
| 无 implementation-plan 或自测证据直接提测 | G3 |
| PR 无 AI 留痕/无人工 Review | G3 |
| 无灰度/回滚方案发布中高风险 | G8 |
| 正式上线无 Outcome Review | G9 |
| 口头绕过 Gate | 全部 |

## 9.2 审核重点 vs 审核结论

| Gate | 审「有没有做」 | 审「做得对不对」 |
|------|----------------|----------------|
| R0 | PRD + prd-self-check 齐全 | Fail/Partial 是否解释充分、改进方向是否可执行 |
| R1 | 主：认真读、问题具体 | 次：问题是否成立 |
| G2a | 覆盖率 100% | spot check 设计质量 |
| G2b | 覆盖率+边界+改动点 | spot check 用例步骤 |
| G3 | P0 100%+证据 | spot check 证据真实 |

## 9.3 文档存放

Must 存于需求目录或 Wiki，禁止仅 IM 口头确认。

## 9.4 与编码规范

配置/proto/安全变更仍须按 core.md 单独确认。
