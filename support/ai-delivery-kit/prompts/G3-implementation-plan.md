# G3 · Implementation Plan 提示词

| 项 | 内容 |
| --- | --- |
| 阶段 | 编码执行 / 提测准入 |
| 产出 | `implementation-plan.md` |
| 模板 | `artifacts/templates/implementation-plan.md` |
| Gate | G3 |

## 主提示词

```text
基于 @tech-design.md、@test-plan.md 中的 P0 用例和当前代码库，生成
implementation-plan.md；不要改代码。使用
@ai-delivery-kit/artifacts/templates/implementation-plan.md 的结构，中文输出。

先定位实际受影响的文件和现有测试。计划应列出改动目的、具体路径、接口或数据影响、验证方式，以及它们与 AC/EX/NFR 和 TC-xxx 的映射。

只为本期涉及的接口、数据库、前端、权限、安全、可观测性或发布风险补充对应实施与验证；不要把无关的通用检查写进计划。无法补齐单测或证据时，记录真实原因、风险和补偿措施。

明确范围外事项、回滚方式和需要人工决定的事项。计划可供实施和审核使用，但不表示代码、测试或 G3 已完成。
```

## 完成检查

- 文件与测试范围来自当前代码，而不是猜测。
- 每项关键变更都有可执行验证和需求或用例映射。
- 未验证项、例外和人工决策被明确保留。
