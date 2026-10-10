# Context Pack 标准布局

每个需求目录 `requirements/{迭代}-{需求}/` 即一个 Context Pack。

## 初始化（交付主线）

```bash
cd ai-delivery-kit
ITER=2026-W23 REQ=my-feature
DEST="../../requirements/${ITER}-${REQ}"
mkdir -p "$DEST/ai"
cp artifacts/templates/{PRD,prd-self-check,dev-prd-review,qa-prd-review,review-minutes,tech-design,test-plan,self-test-report,test-report,acceptance-record}.md "$DEST/"
```

## 全链路扩展

```bash
cp artifacts/templates/{opportunity-brief,discovery-report,implementation-plan,release-plan,outcome-review}.md "$DEST/"
```

细则：[core/context-pack.md](../core/context-pack.md)
