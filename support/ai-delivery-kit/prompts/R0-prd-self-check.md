# R0 · PRD AI Delivery 自检提示词

| 项 | 内容 |
|----|------|
| 阶段 | R0 提交前 / R0 审核辅助 |
| 角色 | 产品 / 审核人 |
| 输出 | `prd-self-check.md` |
| 模板 | `ai-delivery-kit/artifacts/templates/prd-self-check.md` |
| 规范 | `ai-delivery-kit/core/gates.md` R0 |
| Gate | R0（研发负责人 + 测试负责人） |

## 必填输入

- `@PRD.md`
- 原型页面索引 / 主流程说明（优先使用 PRD §4 UI 层）
- 原始需求、会议记录、补充材料（如有）

---

## 主提示词（复制使用）

```
你是研发交付门禁审核人。请对 @PRD.md 和原型材料做 AI Delivery Kit R0 自检，输出 prd-self-check.md。

【硬性要求】
1. 输出格式必须与 ai-delivery-kit/artifacts/templates/prd-self-check.md 一致
2. 对照 ai-delivery-kit/core/gates.md 的 R0-1~R0-14 逐项判断 Pass / Partial / Fail / N/A
3. 自检报告只指出问题、解释原因、给出改进方向，不得替 PRD 补写未出现的产品决策
4. 对材料未说明的内容，明确写“原文未说明 / 原型未说明 / 待评审确认”
5. 所有 Fail / Partial / Pass with Warning 必须填写：
   - 原文/原型证据
   - 问题解释
   - 评审影响
   - 改进方向
   - 是否阻塞 R0 / G1
6. 禁止只写“需补充 / 需确认 / 描述不清”
7. 问题清单 Q-001 起，必须引用 BG / BR / FR / SR / PERM / EX / AC / PG / UI / NFR / CL / EVT 或章节
8. 使用中文

【输入材料】
（在此粘贴或 @ PRD、原型索引、原始需求材料）
```

---

## 质量底线

- `Fail / Partial` 项必须可被评审会直接讨论
- 每个问题都能回答：问题是什么、为什么是问题、影响谁、建议怎么改
- 不得把 AI 推断写成已确认事实
- 不得输出“无明显问题”作为 R0 自检结论
