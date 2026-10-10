# S3 · 自测报告提示词

Skill：`self-test-coverage-check` · 模板：`artifacts/templates/self-test-report.md`

```text
根据提供的真实自测结果生成 self-test-report.md，并使用对应模板结构。

逐项对应 @test-plan.md 的 P0 TC 和 AC，记录结果、执行命令、可复核证据与适用的接口、前端、数据或日志证据。只填写已提供或已实际执行的结果；缺失、失败、跳过和 N/A 必须说明原因、影响和后续措施，不能编造 Pass、覆盖率或链接。

涉及单测时说明测试文件、关键用例和需求映射；只有在输入有可靠数据时统计覆盖率。报告应清楚区分本地检查、浏览器实测、接口实测、CI 与生产证据。该报告供 G3 审核，不表示 G3 已通过。
```

提测前：按 `self-test-coverage-check` Skill 对 P0 覆盖和证据进行自查。
