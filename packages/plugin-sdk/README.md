# Delivery Plugin SDK 2.2.0

Protocol 1. Build-time package with browser bridge, theme snapshots, manifest validation and server contract. Bundle it into plugin artifacts. Legacy hostApi 1 and 2 remain supported. No host private modules. See docs/plugin-repository-contract.md in the host distribution for management protocol.

## 2.2.0：通用会话工作区和后台任务

兼容 2.1.0 声明和摘要；新增字段均可选，不向旧声明注入默认值。
`PluginApplicationHost.workspaces` 提供 `access/list/preview/remove`。读取需 `workspaces.read`，回收需 `workspaces.cleanup`；插件不能选择强制丢弃。只接受会话关联的 linked worktree，复用宿主目录/分支身份、Git 状态、进程占用及会话锁校验。手动调用提交预览 revision 与文件夹名称；周期调用另提交 idleBefore，需后台授权且至少闲置一天，只允许宿主管理目录。最近使用时间取会话、目录元数据和 reflog 的最大值。

应用可声明 `background: { method, intervalSeconds }`（最小 60 秒），并申请 `background.run`。宿主启动后对当前启用且获授权的插件运行方法；停用、移除、撤权、升级及宿主关闭使旧实例和排队操作失效。隐藏菜单不停止任务。后台错误不自动重放本次方法；插件必须保存业务结果及待核对状态。工作台关闭期间不执行、不逐次补跑错过的周期。

RPC 检查发起 worker 实例、启用状态、当前授权；回收在工作区锁内再次检查。超时返回结果待核对，不保证操作未发生。安装授权并不取代插件的业务预览确认。本机代码仍以当前用户权限运行，不是系统沙箱。
