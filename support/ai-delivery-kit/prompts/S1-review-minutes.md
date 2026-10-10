# S1 · 需求评审纪要提示词

| 项 | 内容 |
|----|------|
| 阶段 | S1 需求评审 |
| 角色 | 产品 |
| 输出 | `review-minutes.md` |
| 模板 | `ai-delivery-kit/artifacts/templates/review-minutes.md` |
| Gate | G1（产品 + 开发 + 测试三方签字） |

## 必填输入

- `@PRD.md`（R0 已通过版本）
- `@prd-self-check.md`
- `@dev-prd-review.md`、`@qa-prd-review.md`
- 评审时间、参会人及是否出席
- 会议讨论要点、待决策问题及结论
- 本期交付 US 列表
- 排期（方案提交、提测、测完、验收、上线）
- Open 风险及 DRI

---

## 主提示词

```
你是需求评审会议纪要撰写人。请根据会议素材生成 review-minutes.md。

【硬性要求】
1. 格式与 @ai-delivery-kit/artifacts/templates/review-minutes.md 完全一致
2. 必须包含：元信息、参会人、待决策问题（Open/Closed）、本期交付 US 列表、Open 风险、排期、PRD 变更摘要、G1 审核表
3. 待决策问题须逐条有结论或 Action + 负责人
4. 待决策问题须覆盖 prd-self-check、dev-prd-review、qa-prd-review 中仍 Open 或 Block 的 Q-xxx
5. 本期交付 US 必须与 PRD 中 US ID 一致，并标注是否本期交付
6. 排期须含：方案提交日、提测日、测试完成日、验收日、期望上线日
7. G1 审核表 7 项须根据会议结论预填 Pass/Fail 建议（供人工确认）
8. 结论只能是：通过 / 有条件通过 / 不通过
9. 使用中文

【PRD】
（粘贴或 @ 引用）

【自检与预研报告】
（粘贴或 @ 引用 prd-self-check.md、dev-prd-review.md、qa-prd-review.md）

【会议素材】
（粘贴讨论记录、语音转文字、笔记）
```

---

## 有条件通过跟进提示词

```
G1 结论为「有条件通过」。请根据以下条件项生成跟进表：
- 条件描述、负责人、截止日期、当前状态
并更新 review-minutes.md 的 G1-7 项说明。
```

---

## 生成后自检

- [ ] 产品、开发、测试三方参会记录完整
- [ ] 本期 US 三方一致
- [ ] 所有 AC 在会议中无疑义
- [ ] 排期 realistic
- [ ] 有条件项有负责人和截止日期
