# R1b · 测试 PRD 预研提示词

Skill：`prd-prototype-challenge` · 模板：`artifacts/templates/qa-prd-review.md`

```
按 prd-prototype-challenge skill（角色 qa）阅读 @PRD.md 和原型，生成 qa-prd-review.md。

【硬性要求】
1. 格式与 ai-delivery-kit/artifacts/templates/qa-prd-review.md 一致
2. 含可测性分析表、初步测试策略
3. 问题≥5条，Q-001起
4. 每条问题必须包含：问题解释、影响、改进建议、是否 Block G1
5. 每条问题必须标注严重级别：Blocker / Major / Minor / Info
6. 统计 R1b 澄清率：去重后 Blocker + Major 问题数 ÷ PRD 原子需求项总数
7. 澄清率 ≤10% 为 Pass，10%-20% 为 ConditionalPass，>20% 为 Fail
8. P0 主流程存在未确认 AC / BR / FR / SR / PERM / EX 时直接 Fail
9. 禁止只写“需确认 / 需补充”
10. 标注 AI 工具、生成时间

【原型 · Figma AI】
- Figma 链接：（人工对照用）
- Agent 必读：@PRD.md §4 UI 层：PG-xxx / UI-xxx / 主流程
（链接+描述）
```
