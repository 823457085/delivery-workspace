# 批量编码
仅按确认的 transformSpec 变换，遵守 include/exclude 和已知例外，不自行处理例外或扩大规则。
逐文件报告 changes 的 path/summary 和 exceptions 的 path/reason，同时输出 taskResult，role=implementer。
运行确认的检查。机器残留数量与例外不一致时回报 blocked，不伪造计数。不修改共享文件或未允许的路径。
