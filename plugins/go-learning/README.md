# Go 实训工坊：自定义应用插件

在 `codex/integration-plugins` 分支将 main（790dac0）的完整 Go 实训改为独立应用包。课程、编辑器、快照、代码执行、测试、HTTP 调试、笔记与进度都由本包实现。工作台仅提供通用安装授权、菜单、应用加载、专属目录、会话草稿和打开本机应用接口，不再注册 Go 接入插件或 `/api/go-learning` 业务路由。

## 添加到工作台

宿主升级并重启一次后，进入「设置 → 接入插件 → 自定义功能插件」，选择“Go 实训工坊（本机应用）”示例（指向本目录下的 `package`），检查来源与权限，明确勾选本机代码信任和菜单后添加。以后添加同协议的其他应用无需重启工作台。

也可从仓库根目录执行：

```sh
node plugins/go-learning/install.mjs http://localhost:5199 --trust-local-code
```

本机执行意味着运行可信代码，拥有当前用户文件和网络权限；独立进程不是操作系统安全沙箱。安装脚本只安装已打包并审查的本地文件；重复执行不会重置授权、启停、菜单或数据，不会覆盖不同版本。

打开 `/agent?view=plugins&plugin=go-learning`。主菜单由自定义插件设置控制，支持排序和图标修改。停用、移除和撤回授权沿用通用生命周期。它不再作为 Jira/Confluence 类型的服务接入出现。

## 构建与分发

```sh
node plugins/go-learning/build.mjs
```

分发整个 `package/`（plugin.json、ui.js、ui.css、server.mjs）即可添加到支持 hostApi 2 的工作台。构建时依赖仓库 Node 工具链；运行包不导入宿主业务源码或依赖固定仓库路径。

- `application.ts` / `service.ts` / `curriculum.ts`：插件自身业务与课程。
- `GoLearningStudio.vue` / `markdown/`：独立界面，使用通用 SDK，与工作台主题同步。
- `bridge.ts`：把页面请求映射到本插件入口。
- `plugin.json`：能力、应用入口与菜单来源声明。
- `routes.ts`：保留原实现的路由单元测试适配器，不注册到宿主。

## 数据与兼容

新应用的进度、代码和 Go 缓存存储在 `DELIVERY_DATA_DIR/custom-plugins/data/go-learning/application/`，练习目录在其 `workspace/work/go-taskmgr-lab/`。移除插件保留这些数据，恢复同版本继续使用。

之前固定版的 `.data/go-learning`、`work/go-taskmgr-lab` 和旧 `go-seven-days` 阅读插件的数据保持原样，**不会自动复制或覆盖**。本版本使用独立应用数据；如需迁入历史学习记录，应先核对来源并单独迁移。浏览器旧链接 `/go-studio` 不再作为宿主内置页面；请使用上述自定义插件链接。

插件保留 main 的内置七天课程数据、代码快照和详细文档缺失时的降级逻辑。本机详细课件可放在应用工作目录的 `work/go-learning-docs/`，不依赖分享者的私人目录。

## 宿主接口与验证

通用接口见 [自定义应用插件对接规范](../../docs/custom-plugin-application-api.md)。会话助教经宿主确认后只填入草稿；不会自动发送 AI 请求。打开终端/Cursor 仅限本插件工作目录。

```sh
node --import tsx --test test/plugin-applications.test.ts test/custom-plugins.test.ts test/go-learning.test.ts
pnpm build
```

覆盖独立 ID 安装、代码摘要变化、显式信任、进程环境、数据路径、状态/权限撤回、移除恢复、Go 实际运行以及原课程行为。真实 AI 执行和外部服务不属于本次测试。
