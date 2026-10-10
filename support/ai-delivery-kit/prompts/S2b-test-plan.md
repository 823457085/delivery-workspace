# S2b · 测试方案提示词

模板：`artifacts/templates/test-plan.md` · Gate：G2b

```
你是资深测试工程师。根据 PRD 生成 test-plan.md。

【硬性要求】
1. 格式与 ai-delivery-kit/artifacts/templates/test-plan.md 一致
2. §8 PRD 覆盖度矩阵：本期全部 US/AC/EX/NFR，Gap=0，覆盖率100%
3. §9 技术方案改动点：对照 @tech-design.md §3 每项有 TC
4. 每条 AC ≥1 P0 TC；每条 EX ≥1 TC
5. 覆盖 core/boundaries.md B1-B13（有 UI/输入/接口则必查）
6. 用例步骤含 PRD 字段/边界值/文案细节
7. 输出 AC→TC 映射与覆盖率统计
8. 涉及接口时，对照 core/api-contract-standard.md 覆盖成功、错误码、权限、幂等、空数据
9. 涉及 DB/migration 时，对照 core/db-change-standard.md 覆盖数据校验、兼容、回滚/补偿
10. 涉及前端时，对照 core/frontend-quality-standard.md 覆盖 Loading/Empty/Error/Disabled/Success/刷新状态
11. 中文

【PRD】【review-minutes】【tech-design】
（@ 引用）
```

G2b 审核：`按 test-plan-coverage-review skill 审核 @test-plan.md`
