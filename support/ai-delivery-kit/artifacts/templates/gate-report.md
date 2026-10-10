# Gate Report

| 项 | 内容 |
|----|------|
| 需求 ID | |
| Context Pack | |
| Gate | |
| 模式 | advisory / blocking |
| 结果 | Pass / ConditionalPass / Fail / Waived |
| 分数 | |
| Gate Engine | |
| 模型/工具版本 | |
| AI Delivery Kit 版本 | |
| 运行时间 | |

## 结论

（一句话说明是否允许进入下一 Gate，以及是否需要人工签字/豁免。）

## 输入检查

| 输入 | 状态 | 说明 |
|------|------|------|
| README.md / kit.yaml | | |
| core/gates.md | | |
| core/gate-policy.md | | |
| Context Pack | | |
| Gate 必需产物 | | |

## 阻断项

| ID | 规则 | 证据 | 影响 | 修复建议 | Owner |
|----|------|------|------|----------|-------|
| | | | | | |

## 主要风险

| ID | 风险 | 影响 | 建议 | 是否阻断 |
|----|------|------|------|:--------:|
| | | | | |

## 指标

| 指标 | 值 | 要求 | 结果 |
|------|----|------|------|
| PRD 覆盖率 | | 100% | |
| AC→TC 追溯率 | | 100% | |
| P0 自测覆盖率 | | 100% | |

## 豁免

| 项 | 内容 |
|----|------|
| 是否申请豁免 | |
| 豁免文件 | |
| 批准人 | |
| 有效期 | |

## 人工签字

| 角色 | 签字 | 时间 |
|------|------|------|
| | | |

## 结构化结果

```json gate-result
{
  "schema_version": "1.0",
  "kit_id": "delivery-workspace/ai-delivery-kit",
  "kit_version": "1.0.0",
  "gate": "",
  "mode": "advisory",
  "result": "",
  "score": null,
  "context_pack": "",
  "runner": {
    "name": "ai-delivery-engine",
    "version": "0.1.0",
    "model": "",
    "run_at": ""
  },
  "required_inputs": [],
  "findings": [],
  "metrics": {
    "coverage_prd": null,
    "trace_ac": null,
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
