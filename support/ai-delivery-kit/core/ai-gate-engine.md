# 公共 AI Delivery Gate Engine 规范

> 目标：把个人本地 AI 审核沉淀升级为团队公共流水线/Agent 能力。个人仍可用 Codex、Cursor 等工具生成产物；关键 Gate 的准入/准出审核 MUST 由公共 AI Delivery Gate Engine 统一执行并留痕。

## 1. 定位

AI Delivery Gate Engine 是一个公共审核执行器，负责在关键节点读取 Context Pack、AI Delivery Kit 规范、模板与 Gate Policy，输出结构化审核结果。

| 项 | 说明 |
|----|------|
| 不负责 | 代替产品/开发/测试写正文、代替人工签字、绕过 CI |
| 负责 | 规范一致性、覆盖率、可追溯性、缺失项、敏感信息、准出建议 |
| 权威输入 | `requirements/{迭代}-{需求}/` Context Pack + `ai-delivery-kit/` |
| 权威输出 | `gate-report.md` + 结构化结果块 |

**Normative**: R0、R1a、R1b、G2a、G2b、G3、G5、G8 SHOULD 接入公共 AI Delivery Gate Engine；试点成熟后 MUST 作为 required check。

## 2. 触发点

| Gate | 触发时机 | Gate Engine 输入 | 阻断策略 |
|------|----------|-------------|----------|
| R0 | PRD 提交评审前 | PRD、prd-self-check | Fail 阻断 G1 前流程 |
| R1a/R1b | 开发/测试预研提交后 | dev/qa-prd-review、PRD | Fail 阻断 G1 |
| G2a | tech-design 提交后 | tech-design、PRD、review-minutes | Fail 阻断编码 |
| G2b | test-plan 提交后 | test-plan、PRD、tech-design | Fail 阻断提测 |
| G3 | 提测前 / GitLab MR 更新后 | implementation-plan、self-test-report、pr-checklist、test-plan、CI/证据链接、MR diff、单测结果 | Fail 阻断测试准入 |
| G5 | 验收前 | test-report、acceptance-record、PRD 验收清单 | Fail 阻断验收准出 |
| G8 | 发布前 | release-plan、test-report、回滚方案 | Fail 阻断发布 |

## 3. 执行模型

```text
本地产出
  ↓
Context Pack 更新
  ↓
Git / PR / CI / 内部流程触发
  ↓
AI Delivery Gate Engine
  ├─ 读取 README.md / kit.yaml
  ├─ 读取 core/gates.md
  ├─ 读取 core/gate-policy.md
  ├─ 读取 core/gate-result-schema.md
  ├─ 读取当前 Gate 相关质量规范
  ├─ 读取对应模板与 prompt
  └─ 读取需求 Context Pack
  ↓
gate-report.md
  ↓
Pass / Conditional Pass / Fail / Waived
  ↓
人工签字或阻断流转
```

## 4. 输入契约

Gate Engine MUST 接收以下参数：

| 参数 | 示例 | 必填 |
|------|------|:----:|
| `gate` | `R0` / `G2a` / `G3` | 是 |
| `context_pack` | `requirements/2026-W23-order-export/` | 是 |
| `kit_path` | `ai-delivery-kit/` | 是 |
| `mode` | `advisory` / `blocking` | 是 |
| `changed_files` | PR diff 文件列表 | G3 涉及 PR 时必填 |
| `ci_result` | CI 状态或链接 | G3 涉及 PR 时必填 |
| `output` | `gate-report.md` | 是 |

Gate Engine SHOULD 支持从 GitHub Actions、GitLab CI、Jenkins、内部流水线、Webhook 或命令行触发。

当输入来自 GitLab MR/Push Webhook 时，G3/代码 Review MUST 同时读取 [code-review-standard.md](code-review-standard.md)、[unit-test-standard.md](unit-test-standard.md)、[api-contract-standard.md](api-contract-standard.md)、[db-change-standard.md](db-change-standard.md)、[self-test-evidence-standard.md](self-test-evidence-standard.md) 和 [frontend-quality-standard.md](frontend-quality-standard.md)，检查变更范围、必测范围、接口契约、DB 变更、自测证据、前端状态和缺测例外说明。

## 5. 输出契约

Gate Engine MUST 输出：

1. 人类可读报告：使用 `artifacts/templates/gate-report.md`
2. 结构化结果：符合 `core/gate-result-schema.md`
3. 阻断项列表：每项含规则、证据、影响、修复建议
4. 豁免状态：若存在豁免，链接 `gate-waiver.md`

**Normative**: Gate Engine 输出 “Pass” 时，必须没有 Blocker；输出 “Conditional Pass” 时，必须说明条件、责任人和截止时间。

## 6. 公共能力沉淀

公共 Gate Engine 的规则与提示词 MUST 进入版本库，禁止只存在于个人工具配置或聊天记录中。

| 资产 | 路径 |
|------|------|
| Gate 判定策略 | `core/gate-policy.md` |
| 结果结构 | `core/gate-result-schema.md` |
| 审核报告模板 | `artifacts/templates/gate-report.md` |
| 豁免模板 | `artifacts/templates/gate-waiver.md` |
| 公共审核 Prompt | `prompts/ai-gate-engine.md` |
| 研发质量规范 | `core/code-review-standard.md`、`core/unit-test-standard.md`、`core/api-contract-standard.md`、`core/db-change-standard.md`、`core/self-test-evidence-standard.md`、`core/frontend-quality-standard.md` |

## 7. 渐进落地

| 阶段 | 策略 | 目标 |
|------|------|------|
| Phase 1 | Advisory，不阻断 | 收集误报、补齐规则 |
| Phase 2 | 关键 Gate blocking | R0/G2/G3/G5/G8 进入 required check |
| Phase 3 | 看板化与复盘 | Gate 通过率、Fail TopN、豁免关闭率 |

## 8. 安全要求

| 规则 | 要求 |
|------|------|
| 敏感信息 | Gate Engine MUST 执行 D 级信息拦截，不得上传密钥、PII、支付数据 |
| 权限 | Gate Engine 只读 Context Pack 与 PR diff，写入报告，不直接发布 |
| 审计 | 每次运行 MUST 记录模型/工具版本、AI Delivery Kit 版本、运行时间 |
| 人工责任 | AI Delivery checkpoint 不能代签；最终 checkpoint 仍由指定角色签字 |
