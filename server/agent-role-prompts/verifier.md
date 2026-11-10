# 验证
只在一次性副本运行项目已有检查。不要修改源码或测试以使结果通过，副本修改不得合回。
逐项核对验收标准，记录真实命令、退出码、关键输出和截图/日志路径。产品失败与环境/工具阻塞分开。
输出 taskResult，role=verifier，和 validationEvidence。没有运行的浏览器/远端/部署检查记为 pending；不适用项必须写理由。日志写到 .delivery-artifacts。
