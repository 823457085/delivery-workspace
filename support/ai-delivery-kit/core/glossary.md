# 01 · 术语与 ID 体系

## 1.1 阶段代号

| 代号 | 名称 | 说明 |
|------|------|------|
| S0 | 产品产出 | PRD 编写 |
| R0 | PRD 门禁 | 研发+测试负责人审 PRD + prd-self-check |
| R1a/R1b | 预研门禁 | 开发/测试 AI 读 PRD+原型 |
| S1 | 需求评审 | G1 会议 |
| S2a/S2b | 方案并行 | 技术方案 / 测试方案 |
| S3 | 开发提测 | 代码 + 自测报告 |
| S4 | 测试执行 | 测试报告 |
| S5 | 产品验收 | 验收记录 |

## 1.2 Gate

人工审核关卡。审核人签字 = Pass；否则 Must Not 进入下一阶段。

## 1.3 PRD Item ID（Normative）

| 前缀 | 含义 | 示例 |
|------|------|------|
| BG- | 背景事实 | BG-001 |
| OBJ- | 目标 | OBJ-001 |
| SCOPE- | 范围 | SCOPE-001 |
| RISK- | 风险与约束 | RISK-001 |
| US- | 用户故事 | US-001 |
| BR- | 业务规则 | BR-001 |
| FR- | 字段规则 | FR-001 |
| SR- | 状态规则 | SR-001 |
| PERM- | 权限规则 | PERM-001 |
| AC- | 验收标准（G/W/T） | AC-001 |
| EX- | 边界与异常 | EX-001 |
| NFR- | 非功能要求 | NFR-001 |
| CL- | 验收清单项 | CL-001 |
| Q- | 自检 / 预研待确认问题 | Q-001 |
| TC- | 测试用例 | TC-001 |

## 1.4 覆盖状态

| 状态 | 含义 |
|------|------|
| Covered | 方案/用例/自测已明确回应 |
| Partial | 部分回应，**计为未覆盖** |
| Gap | 未回应，**Must Not 通过 G2** |

## 1.5 外部流程术语映射（参考）

| 外部术语 | 含义 | AI Delivery Kit 对应 |
|----------|------|----------------------|
| G0 | 需求入口 | opportunity-brief |
| PDF-G1 | 产品发现 | discovery-report |
| G2 | PRD Ready | S0 + R0 |
| Design Ready | 原型/页面准备 | PRD §4 页面索引 |
| Sprint Ready | 研发拆解准备 | jira-story |
| 提测准入 | 编码执行准出 | implementation-plan + self-test-report + pr-checklist |
| 验收准出 | 测试与产品验收 | test-report + acceptance-record |
| G8 | Release Ready | release-plan |
| G9 | Outcome Review | outcome-review |

详见 [lifecycle.md](lifecycle.md)。**注意**：本包 **G1=需求评审会**，≠ PDF-G1。

## 1.6 ID 扩展

| 前缀 | 含义 |
|------|------|
| EVT- | 埋点事件 |
| OPP- | 机会简述 |
| PG- | 原型页面 |
| UI- | UI 组件 / 状态 / 文案 | UI-001 |

## 1.7 AI 证据文档

由 AI 生成、人工修订、提交 Gate 审核的结构化 Markdown，须含 [ai-governance.md](ai-governance.md) 留痕块。
