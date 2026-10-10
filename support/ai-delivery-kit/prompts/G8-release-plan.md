# G8 · Release Plan 提示词

| 项 | 内容 |
|----|------|
| 阶段 | G8 发布灰度 |
| 产出 | `release-plan.md` |
| 模板 | `ai-delivery-kit/artifacts/templates/release-plan.md` |

## 主提示词

```
你是发布负责人助手。基于 @test-report.md @tech-design.md（回滚§9）和 PR 列表，
生成 release-plan.md。

【硬性要求】
1. 格式与 ai-delivery-kit/artifacts/templates/release-plan.md 一致
2. 中高风险须含 Feature Flag / 灰度阶段 / 回滚 / 监控指标
3. Release Notes 与 FAQ 区分内部与客户可见版本
4. 客户可见文案标注「须产品审核」
5. 包含 AI 使用说明块
```
