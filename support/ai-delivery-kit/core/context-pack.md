# 13 · AI Context Pack

> 解决 Agent「缺背景、乱猜」问题。每个需求在交给 Cursor/Codex/Claude **之前** Must 具备可读的上下文包。

---

## 13.1 目录结构

在 `requirements/{迭代}-{需求}/` 下组织（**粗体为交付主线强制**）：

```
requirements/{迭代}-{需求}/
├── **PRD.md**
├── **prd-self-check.md**
├── **dev-prd-review.md**
├── **qa-prd-review.md**
├── **review-minutes.md**
├── **tech-design.md**
├── **test-plan.md**
├── **self-test-report.md**
├── **test-report.md**
├── **acceptance-record.md**
│
├── opportunity-brief.md          # G0
├── discovery-report.md           # PDF-G1
├── implementation-plan.md        # G3 提测准入（编码执行计划）
├── release-plan.md               # G8
├── outcome-review.md             # G9
├── gate-report.md                 # 公共 AI Delivery Gate Engine 输出
├── gate-waiver.md                 # 可选：Gate 豁免记录
│
├── api/                          # 可选
│   └── openapi.yaml
├── ai/
│   └── source-notes.md
└── CHANGELOG-context.md          # Context Pack 版本变更
```

---

## 13.2 规则（Normative）

| 规则 | 要求 |
|------|------|
| **唯一入口** | Agent 开发时 Must `@` 上述 Markdown 路径，禁止仅聊天片段 |
| **版本留痕** | 进入 R0/G2a/G5 前更新 `CHANGELOG-context.md` |
| **权限继承** | 不复制密钥/PII；只引用授权文档或脱敏样例（core/ai-governance.md） |
| **过期治理** | G9 后更新 outcome-review、指标、经验教训供 RAG |
| **公共审核** | 关键 Gate 的 `gate-report.md` Must 回写 Context Pack 或 PR Check |

---

## 13.3 Agent 读取顺序

| 任务 | 必读 | 选读 |
|------|------|------|
| R0 自检 | PRD、PRD §4、原型说明 | opportunity-brief、discovery-report |
| R1 预研 | PRD §4、prd-self-check | opportunity-brief、discovery-report |
| 写 tech-design | PRD、review-minutes | discovery-report、代码路径 |
| 写 test-plan | PRD、tech-design | discovery-report |
| G3 编码执行 | implementation-plan、tech-design、test-plan P0 | PRD、api/ |
| G3 PR Review | pr-checklist、implementation-plan、test-plan | — |
| G8 发布 | release-plan、test-report、tech-design §9 回滚 | — |

---

## 13.4 喂料模板

```
Context Pack：requirements/{迭代}-{需求}/
阶段：G3 编码执行
必读：implementation-plan.md, tech-design.md, test-plan.md
代码：{service}/cmd/..., {service}/internal/...
禁止：未在 plan 中的文件改动；生产密钥
```

详见 [ai-friendly.md](ai-friendly.md)。
