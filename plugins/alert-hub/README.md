# Alert Hub 自定义功能插件

独立 Vue 页面和插件后端，通过本机 `alert-hub-mcp` stdio 工具操作 Alert Hub。没有加载远端网页、复用上游页面代码或在宿主注册专属业务入口。

## 安装与配置

宿主需包含通用插件配置及 MCP 接口。更新宿主代码后重启工作台，再执行：

```sh
node plugins/alert-hub/build.mjs
node plugins/alert-hub/install.mjs http://localhost:5199 --trust-local-code
```

也可在「设置 → 自定义功能插件」检查 `package` 的绝对路径，确认信任本机代码后添加/更新。安装器使用版本摘要检查，兼容更新保留现有权限、启停、菜单、配置和数据；不自动扩大授权。

进入「告警中心 → 配置」填写：

- 服务地址：默认 `https://thor-alert-hub.hahavending.com`，必须是 HTTPS。
- MCP 可执行文件：本机绝对路径，例如 `/Users/你的用户名/.local/bin/alert-hub-mcp`。
- 账号、密码：使用自己的账号，在配置表单输入，不发送到聊天。

密码在本机宿主配置文件中保存（0600，未做磁盘加密），不向前端回显。留空保留原密码；更换地址或账号必须重新填写密码。配置保存立即停止旧插件进程，下次连接读取新配置，无需再重启宿主。

打开 `/agent?view=plugins&plugin=alert-hub`，自动使用配置登录。配置更新或会话过期后点「重新连接 / 刷新」。不读取浏览器 Cookie、不继承宿主认证、不使用伪造身份请求头。MCP 登录失败不会自动重试。

## 插件能力

- 告警 Case、待办、事件、负责人、规则的分页查询、详情及适用的搜索/范围筛选。
- MCP 声明生成操作表单，提供 Case 确认、指派、评论、分诊、解决、关闭、噪音与重开；待办创建/编辑/状态流转；负责人和规则维护、规则试运行，以及手工导入工具。
- 所有非审核通过的只读工具都必须先预览，确认票据绑定工具和完整参数，2 分钟有效、一次使用。网络或工具错误不重放写入；结果未知时先查询远端。
- 详情和执行结果可经宿主确认填入会话草稿，不自动启动 AI。
- 原样显示远端文案，仅替换意外包含已配置密码的文本。配置密码不进入前端状态、URL、命令行参数或插件包。

以 MCP 实际工具清单为能力边界。当前本机 0.2.0 提供 35 个工具；团队管理、通知策略等未暴露的 API 不在本插件中伪装为可用。远端账号权限仍由服务校验。

## 使用的公开宿主能力

既有安装/菜单/页面/主题/专属进程、`application.local`、`conversation.compose`。

此次通用宿主扩展（基于本次配置诉求及会话中补充宿主公开能力的授权）：

1. manifest `configuration.fields`、脱敏读取和受保护的配置保存；后端 `host.configuration`。
2. `host.mcp.connect({command,args?,env?,timeoutMs?})`、工具发现/调用及子进程生命周期。
3. 安装接口 `replaceDigest`，仅支持权限和记录契约不变的显式兼容更新。

扩展中没有 Alert Hub 名称、ID、工具或账号字段的业务分支。其他插件可以复用；插件停用/移除/撤权后宿主停止其 MCP，保留配置和数据。本机信任不等于 OS 沙箱。

## 验证

```sh
node --import tsx --test test/alert-hub-plugin.test.ts test/plugin-mcp.test.ts test/plugin-applications.test.ts test/custom-plugins.test.ts
pnpm build
```

测试使用临时目录和模拟 MCP，验证配置脱敏/持久化、账号变更需要新密码、同源保护、版本更新保留状态、预览参数绑定/单次确认，以及子进程停止。真实本机 MCP 已完成握手并发现 35 个工具；真实账号登录与业务数据查询需要使用者在配置表单保存账号后验证。没有执行线上写操作或发送通知。
