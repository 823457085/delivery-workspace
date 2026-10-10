# Gate Result Schema

> 公共 AI Delivery Gate Engine 的结构化输出契约。报告可读性给人，Schema 给流水线、PR Check、看板和复盘。

## 1. 结果枚举

| Result | 含义 | 流水线行为 |
|--------|------|------------|
| `Pass` | 无阻断项 | blocking 模式允许通过 |
| `ConditionalPass` | 有条件通过，须人工确认 | blocking 模式要求签字或豁免 |
| `Fail` | 存在阻断项 | blocking 模式阻断 |
| `Waived` | 已批准豁免 | blocking 模式允许通过，但进入跟踪 |

## 2. 严重级别

| Severity | 含义 | 默认结果 |
|----------|------|----------|
| `blocker` | 违反硬门槛、覆盖不足、敏感信息、跳 Gate | `Fail` |
| `major` | 影响开发/测试/发布质量，但可补救 | `ConditionalPass` 或 `Fail` |
| `minor` | 格式、表达、轻微缺失 | `Pass` with warnings |
| `info` | 建议项 | 不阻断 |

## 3. JSON Schema 草案

```json
{
  "schema_version": "1.0",
  "kit_id": "delivery-workspace/ai-delivery-kit",
  "kit_version": "1.0.0",
  "gate": "G2a",
  "mode": "blocking",
  "result": "Fail",
  "score": 72,
  "context_pack": "requirements/2026-W23-order-export/",
  "runner": {
    "name": "ai-delivery-engine",
    "version": "0.1.0",
    "model": "MODEL_NAME",
    "run_at": "2026-06-08T10:00:00+08:00"
  },
  "required_inputs": [
    {
      "path": "PRD.md",
      "status": "present"
    }
  ],
  "findings": [
    {
      "id": "G2A-COVERAGE-001",
      "severity": "blocker",
      "rule": "Coverage_PRD MUST = 100%",
      "evidence": "AC-004 not mapped in tech-design §10",
      "impact": "Implementation may miss an accepted behavior.",
      "suggested_action": "Add AC-004 mapping to tech-design §10 coverage matrix.",
      "owner": "开发 Owner",
      "blocks_gate": true
    }
  ],
  "metrics": {
    "coverage_prd": 0.92,
    "trace_ac": 1,
    "coverage_p0": null
  },
  "waiver": {
    "status": "none",
    "path": null,
    "expires_at": null
  },
  "human_signoff_required": true
}
```

## 4. Markdown 嵌入

`artifacts/templates/gate-report.md` MUST 包含一个 fenced JSON 块，供机器读取：

````markdown
```json gate-result
{ "...": "..." }
```
````

## 5. ID 规则

Finding ID SHOULD 使用：

```text
{GATE}-{CATEGORY}-{序号}
```

示例：

| ID | 含义 |
|----|------|
| `R0-AC-001` | AC 缺失或不可测 |
| `G2A-COVERAGE-001` | 技术方案覆盖缺口 |
| `G2B-TRACE-001` | AC 到 TC 不可追溯 |
| `G3-PLAN-001` | implementation-plan 缺失或未确认 |
| `G6P-CI-001` | PR CI / lint / scan 未通过 |
| `G3-P0-001` | P0 自测覆盖不足 |
| `G8-ROLLBACK-001` | 回滚方案缺失 |
