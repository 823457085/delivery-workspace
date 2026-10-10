# 06 · 角色职责

## 四阶段职责

| 阶段 | 主责 | 参与 | 关键审核 |
|------|------|------|----------|
| 产品需求设计 | 产品负责人 | 开发、测试 | 产品负责人审内容真实性；研发/测试负责人审可实现、可测试 |
| 技术方案设计 | 研发负责人 | 产品、测试 | 研发负责人审方案质量；测试负责人审可测性；产品确认范围一致 |
| 编码执行 | 代码 Owner / 开发主程 | 研发负责人、测试 | 代码 Owner 审实现与自测；测试负责人审提测质量 |
| 验收发布 | 测试负责人 / 产品负责人 | 发布负责人、研发 | 测试审质量结论；产品审验收；发布负责人审灰度回滚 |

| 角色 | 产出 | 审核 | AI Skill 常用 |
|------|------|------|---------------|
| **产品** | PRD、prd-self-check、review-minutes、acceptance | R1a/R1b、G1、G5 | S0 / R0 提示词 |
| **开发主程** | dev-prd-review、tech-design、代码、self-test | 参与 G1 | prd-prototype-challenge、delivery-gate-docs、self-test-coverage-check |
| **测试主测** | qa-prd-review、test-plan、test-report | 参与 G1 | prd-prototype-challenge、delivery-gate-docs |
| **研发 Leader** | — | R0、G2a | tech-design-coverage-review |
| **测试 Leader** | — | R0、R1b、G2b、G3 | test-plan-coverage-review、self-test-coverage-check |
| **架构师** | — | 复杂需求 G2a | tech-design-coverage-review |
| **发布负责人** | release-plan | G8 | G8 prompt |
| **代码 Owner** | implementation-plan、PR、self-test-report | G3 | G3 prompt |

## RACI 摘要（）

| 活动 | 产品 | 开发 | 测试 | 研发L | 测试L |
|------|:----:|:----:|:----:|:-----:|:-----:|
| PRD | R/A | C | C | A | A |
| R0 自检 | R | C | C | A | A |
| 预研 R1 | A | R | R | I | A |
| G1 | R | C | C | I | I |
| 技术方案 | C | R | I | A | I |
| 测试方案 | C | I | R | I | A |
| 提测 G3 | I | R | A | I | A |
| 验收 G5 | R/A | C | C | C | I |

R=负责 A=批准 C=协商 I=知会

## RACI 扩展（全链路）

| 事项 | R | A | C | I |
|------|---|---|---|---|
| G0 需求准入 | 产品 | 产品负责人 | 销售/CSM | 提出方 |
| PDF-G1 发现 | 产品 | 产品负责人 | CSM/数据 | 产研 |
| G5 拆解 | PM/Tech Lead | 项目负责人 | 测试 | 团队 |
| G3 提测准入 | 开发/Agent | 代码 Owner | Tech Lead | PM |
| G8 发布 | 发布/运维 | 研发负责人 | 产品/测试 | 业务侧 |
| G9 复盘 | 产品 | 产品负责人 | 数据/研发 | 产研 |
