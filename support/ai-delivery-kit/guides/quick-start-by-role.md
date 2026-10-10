# 角色速查 · 一页纸

AI Delivery Kit 包：`ai-delivery-kit/`

## 产品

| 时机 | 动作 | Skill/提示词 |
|------|------|--------------|
| 迭代初 | 写 PRD | prompts/S0-PRD.md |
| R0 前 | PRD 自检：挑毛病、作解释、给方向 | prompts/R0-prd-self-check.md |
| R1 | 审 dev/qa 预研 | [gate-review.md](../prompts/gate-review.md) R1a/R1b |
| G1 后 | 纪要 | prompts/S1-review-minutes.md |
| 上线前 | 验收 | prompts/S5-acceptance-record.md |

## 开发

| 时机 | 动作 | Skill |
|------|------|-------|
| G1 前 | **必做** 挑刺 PRD | prd-prototype-challenge |
| G1 后 | 技术方案+覆盖矩阵 | delivery-gate-docs + S2a |
| 提测前 | 自测+TC覆盖自查 | self-test-coverage-check |

## 测试

| 时机 | 动作 | Skill |
|------|------|-------|
| G1 前 | **必做** 预研 PRD | prd-prototype-challenge |
| G1 后 | 测试方案+覆盖矩阵 | delivery-gate-docs + S2b |
| 提测 | 审 G3 | self-test-coverage-check |

## 研发 Leader

G2a：`tech-design-coverage-review skill 审核 @tech-design.md @PRD.md`

## 测试 Leader

G2b：`test-plan-coverage-review skill 审核 @test-plan.md`  
G3：`self-test-coverage-check skill 审核 @self-test-report.md`

## 安装到本地 AI 工具

```bash
cd ai-delivery-kit
./install.sh both --validate --workspace /path/to/workspace
```

Confluence：[Hub](https://confluence.example.com/spaces/TEAM/pages/1001/) · `guides/confluence-one-pager.md` · `guides/pilot-90day-checklist.md`
