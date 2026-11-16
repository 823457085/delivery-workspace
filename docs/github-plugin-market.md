# GitHub 插件来源

在「连接与策略设置 → 固定插件 → 自定义插件 → 配置」选择 **GitHub 仓库**。HTTP 仍为默认方式，原 HTTP/MCP 连接不需要迁移。

填写仓库根地址 `https://github.com/owner/repo`，选择「市场仓库」或「单插件仓库」。目录可留空，或填写 `releases`、`plugins/notes` 等仓库内相对目录，不能填写 URL、绝对路径或 `..`。当前只支持 github.com，不支持 GitHub Enterprise。

版本策略：

- 稳定版本：读取已发布、非预发布的 Releases。
- 包含预发布：读取所有非草稿 Releases。
- 固定标签：只读取指定 Release，例如 `v1.0.0`；固定的是发布标签，不是分支名。

宿主先将标签解析为提交，再读取该提交中的声明。分支上的新文件不会直接成为发布版本。仅安装上传到对应 Release 的已构建 `.dwp` 资产，不下载源码构建、不执行安装脚本。更新需选择版本、重新检查并确认；不会自动安装。

## 市场仓库

在每个发布标签的所选目录放置 `catalog.json`，格式与 HTTP 市场相同：`{ "protocol": 1, "releases": [...] }`。每条发布项包括 `id`、`version`、完整 `manifest`、`package` 文件名和 `sha256`；使用插件构建产出的目录，避免手工维护重复声明。

例如标签 `market-2026-11-16` 的文件布局：

```text
releases/catalog.json
```

配置目录为 `releases`。该目录引用的每一个 `.dwp` 必须上传到**同一 Release** 的资产列表，文件名和 SHA256 与目录一致。一个 Release 可提供多个插件和多个版本；不同 Release 中相同插件版本的元数据必须一致，不同版本不能复用相同包文件名。

## 单插件仓库

所选目录在 Release 对应提交中包含完整 `plugin.json`。例如声明 ID 为 `example-notes`、版本为 `1.0.0`：

```text
仓库文件：plugins/notes/plugin.json
Release 标签：v1.0.0（或 1.0.0）
Release 资产：example-notes-1.0.0.dwp
```

配置目录为 `plugins/notes`。标签必须与声明版本一致。优先使用 GitHub 资产返回的 SHA256；若旧资产没有 `digest`，同时上传 `example-notes-1.0.0.dwp.sha256`。维护者可在本地生成：

```sh
shasum -a 256 example-notes-1.0.0.dwp > example-notes-1.0.0.dwp.sha256
```

这些是发布者准备步骤；工作台不会替用户上传或发布。

## 凭据与安装边界

公共仓库可不填 Token。私有仓库填写仅允许目标仓库读取的凭据；细粒度 Token 需要 Contents 读取权限。组织策略或 SSO 仍须由仓库管理方授权，工作台不会扩大权限。[GitHub Contents 文档](https://docs.github.com/en/rest/repos/contents)、[Release assets 文档](https://docs.github.com/en/rest/releases/assets)

Token 仅存宿主后端，页面只显示是否已配置；留空保留同一仓库的既有凭据，切换仓库或改用 HTTP/MCP 会清除旧 Token，也可显式清除。Token 仅发送至构造的 GitHub API 请求，不放入地址、日志、目录响应或插件包。资产下载允许 GitHub 指定的两个 HTTPS CDN 域名，跳转时不转发认证头；其他跳转拒绝。

下载会检查大小、摘要以及实际包声明，再显示现有安装授权。拒绝授权不会安装；本机代码信任仍需单独确认。SHA256 是完整性检查，不是发布者身份签名。更新保持既有配置、数据和菜单偏好，新能力不能静默获得授权。

## 限制及排查

- 扫描范围少于 50 个 Releases，每个 Release 少于 100 个资产，最多 500 个插件版本；达到扫描上限会明确失败，请改用固定标签或拆分发布目录，不静默截断。
- 目录最多 2 MB，下载包最多 41 MB，仍需通过宿主更严格的包内容限制。
- “未发现兼容插件”：检查仓库类型、目录、发布标签和 `.dwp` 资产；普通源码仓库不能直接安装。
- 401 检查凭据；403 检查只读权限或限流；404 可能是不存在或凭据无权读取。限流时稍后重试或缩小版本范围。
- 包摘要、大小或声明变化会拒绝本次安装，重新刷新并检查来源后再选择版本。失败不会替换已安装版本。
- GitHub 离线不影响「已安装」及本机导入；本机导入同样需要包校验与授权。

验证：`node --import tsx --test test/github-plugin-market.test.ts test/plugin-distribution.test.ts test/integration-plugins.test.ts`。用模拟 GitHub 验证发现、下载跳转、私有凭据隔离、授权与更新；真实公开仓库只验证了 API 可访问和不兼容发布的错误提示，未使用真实私有凭据或实际发布资产完成安装。
