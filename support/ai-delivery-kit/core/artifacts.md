# 04 · 产出物规范

| 文件 | 阶段 | 负责人 | Gate | 模板 |
|------|------|--------|------|------|
| PRD.md | S0 | 产品 | R0 | artifacts/templates/PRD.md |
| prd-self-check.md | R0 提交前 / R0 审核 | 产品 / 审核人 | R0 | artifacts/templates/prd-self-check.md |
| prototype-notes.md | S0 / R1 | 产品 | R0 / R1 | artifacts/templates/prototype-notes.md |
| dev-prd-review.md | R1a | 开发主程 | R1a | artifacts/templates/dev-prd-review.md |
| qa-prd-review.md | R1b | 测试主测 | R1b | artifacts/templates/qa-prd-review.md |
| review-minutes.md | S1 | 产品 | G1 | artifacts/templates/review-minutes.md |
| tech-design.md | S2a | 开发 | G2a | artifacts/templates/tech-design.md |
| test-plan.md | S2b | 测试 | G2b | artifacts/templates/test-plan.md |
| test-cases.md | S2b / G5 | 测试 | G2b / G5 | artifacts/templates/test-cases.md |
| self-test-report.md | S3 | 开发 | G3 | artifacts/templates/self-test-report.md |
| implementation-plan.md | 编码执行 | 开发 Owner | G3 | artifacts/templates/implementation-plan.md |
| pr-checklist.md | 编码执行 | 代码 Owner | G3 | artifacts/templates/pr-checklist.md |
| test-report.md | 验收发布 | 测试 | G5 | artifacts/templates/test-report.md |
| acceptance-record.md | S5 | 产品 | G5 | artifacts/templates/acceptance-record.md |

### 全链路扩展产出物

| 文件 | Gate | 负责人 | 模板 |
|------|------|--------|------|
| opportunity-brief.md | G0 | 产品 | artifacts/templates/opportunity-brief.md |
| discovery-report.md | PDF-G1 | 产品 | artifacts/templates/discovery-report.md |
| jira-story.md | G5 拆解 | PM/Tech Lead | artifacts/templates/jira-story.md |
| release-plan.md | G8 | 发布负责人 | artifacts/templates/release-plan.md |
| outcome-review.md | G9 | 产品 | artifacts/templates/outcome-review.md |
| gate-report.md | 公共 AI Delivery checkpoint | AI Delivery Gate Engine | artifacts/templates/gate-report.md |
| gate-waiver.md | Gate 豁免 | Gate 对应 A 角色 | artifacts/templates/gate-waiver.md |

## 关键章节（不可省略）

| 文件 | 强制章节 |
|------|----------|
| PRD | 五层结构；BG/OBJ/SCOPE/RISK/US/BR/FR/SR/PERM/EX/AC/PG/UI/NFR/CL/EVT ID；§3.5 埋点；§3.6 灰度；§4 UI 层；§5.3 AI 留痕 |
| prd-self-check | R0 逐项结果；Fail/Partial 的证据、解释、影响、改进方向；Q-xxx 问题清单 |
| prototype-notes | 页面索引、页面流转、关键状态、表单校验、权限可见性、原型链接/截图索引、Q-xxx 问题清单 |
| dev/qa-prd-review | 摘要、Q-xxx≥5、问题解释/影响/改进建议、AI 元信息 |
| tech-design | §2 映射；§4 接口契约、DB 变更、前端状态、可观测性；§10 PRD 覆盖度矩阵；代码路径 |
| test-plan | §3 TC 表；§8 PRD 覆盖矩阵；§9 方案改动点；§10 接口/DB/前端专项覆盖 |
| test-cases | TC ID、优先级、类型、步骤、预期结果、追溯 ID、执行记录、覆盖自检 |
| self-test-report | §1 P0 TC 覆盖数据；§2 P0 明细；§4 单测命令、CI、覆盖率和 AC/EX/NFR 映射；§5 证据清单；§6 例外 |
| pr-checklist | 需求链接、AI 使用、风险、代码评审检查、接口/DB/前端专项、单测结果、证据检查、灰度回滚 |
| test-report | P0/P1 执行摘要、用例明细、探索性测试、回归结果、专项验证结果、遗留缺陷、结论 |
| gate-report | Gate 结果、阻断项、证据、指标、结构化 `json gate-result` |
| gate-waiver | 规则 ID、批准人、有效期、风险、补偿措施、关闭计划 |

AI 友好写法详见 [ai-friendly.md](ai-friendly.md)。

## 版本与链接

每份文档元信息 Must 含：需求 ID、版本、最后更新。  
review-minutes Must 链接 dev/qa-prd-review。
