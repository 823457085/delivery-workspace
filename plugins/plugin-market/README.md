# 自定义插件

固定外部服务中的统一入口。沿用 `plugin-market` 标识和原配置，显示名称改为“自定义插件”；不再提供另一份插件市场入口或内附目录。通过「连接与策略设置 → 自定义插件」或固定卡片打开相同管理界面。

在固定卡片配置市场连接：默认 HTTP；也可选 MCP（Streamable HTTP）。HTTP 填服务根地址或 catalog.json 地址，MCP 填 /mcp 端点。两种方式均支持 HTTPS；明文 HTTP 仅接受 localhost、127.0.0.1、[::1]，localhost 固定连接 127.0.0.1。拒绝凭据、查询参数、片段和重定向。没有默认站点，不自动覆盖旧链接；旧页面链接仍保留，但需要用户调整为市场服务地址后才能读取目录。

保存即时生效，测试连接只读取目录。停用或移除停止读取市场，配置继续保留；本机“已安装”仍可管理。本机导入无需市场在线。

也可选择 GitHub 仓库，支持市场目录仓库和单插件仓库的 Releases 资产，填写目录、版本策略及可选私有凭据。完整布局和限制见 [GitHub 插件来源](../../docs/github-plugin-market.md)。凭据仅保存在宿主后端，不返回前端，不在安装时构建源码。

通用宿主能力由 connection.type: catalog 声明，通过版本 1 目录协议读取声明、分类、版本和发布包；HTTP 读取 catalog.json 及相邻包，MCP 读取 plugin-market://catalog 和 plugin-market://packages/{name}，不执行工具、启动本机命令或跟随远端返回的下载地址。MCP stdio 未在宿主配置界面开放。

安装仍经过宿主限流限大小、摘要和实际包声明检查、授权预览与确认；市场无本机管理权。已安装状态、配置、数据、授权和菜单偏好继续由宿主维护。

验证：`node --import tsx --test test/integration-plugins.test.ts test/plugin-distribution.test.ts test/agent-workspace-navigation.test.ts`、`pnpm build`。
