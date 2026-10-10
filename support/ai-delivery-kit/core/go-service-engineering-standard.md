# Go 服务工程规范

> 适用范围：团队 Go 后端服务、BFF、worker、cron、consumer、内部工具。通用 Go 语言规则见 [go-coding-standard.md](go-coding-standard.md)。

## 1. 分层架构

| 层 | 目录建议 | 职责 |
|----|----------|------|
| Domain | `internal/domain/` | 领域实体、仓储接口、领域服务；不依赖基础设施 |
| Service | `internal/service/` | 应用用例与完整业务流程；协调领域与基础设施 |
| Application | `internal/application/` | HTTP/gRPC/Cron/Consumer 接入；只做协议转换与分发 |
| Infrastructure | `internal/infrastructure/` | 数据库、Redis、MQ、外部服务客户端等实现 |
| Bootstrap | `internal/bootstrap/` | 配置加载、依赖组装、资源初始化与关闭 |

Cron 和 Consumer 只负责调度或消息分发；业务逻辑应通过 service 或 gRPC 用例执行，不应直接散落在调度入口中。

## 2. Bootstrap Adapter

Go 服务 SHOULD 使用 Bootstrap Adapter 集中完成：

- 加载配置并支持 `-f` 参数；
- 初始化数据库、Redis、MQ、外部客户端；
- 组装 repository、domain service、application service；
- 提供资源关闭能力；
- 让 `cmd/*/main.go` 保持简洁。

`main.go` 建议只保留：创建 Bootstrap、取出业务组件、启动服务、等待优雅关闭。

## 3. 配置规范

所有服务 MUST 支持：

```text
命令行 -f > CONFIG_PATH 环境变量 > 默认 config/config.yaml
```

配置结构 SHOULD 定义在组件内部，例如 `internal/infrastructure/database.Config`，并带 `yaml` 标签。可选组件 MUST 有 `enabled` 字段，未启用时不应导致服务启动失败。

敏感信息不得写入本地配置文件，应通过 Nacos、K8s Secret 或环境变量注入。

## 4. Nacos 多 DataID

复杂服务 SHOULD 使用多 DataID 并采用顶级前缀：

```yaml
main:
  mysql:
    enabled: true

feature:
  some_flag: true
```

要求：

- DataID 的 `type` 与顶级前缀一致；
- 不同 DataID 不共享裸顶级键，避免合并冲突；
- 热更新回调只更新可热变更配置，不重建不可热替换资源；
- 本地配置只保留 Nacos 连接与非敏感默认项。

## 5. Makefile 与 Docker

Makefile 只负责本地开发与开发环境镜像构建，SHOULD 包含：

- `build`, `build-linux`
- `test`, `fmt`, `vet`, `lint`
- `run` 或服务粒度 `run-http`, `run-worker`
- `build-docker`, `build-docker-push`

测试、预发、生产部署由 CI/Jenkins/运维流水线处理，不在 Makefile 中堆叠复杂环境分支。

Docker/Jenkins 镜像 SHOULD：

- 使用预编译二进制与明确配置入口；
- 支持 `./main -f ./conf/config.yaml`；
- 包含必要调试工具；
- 设置时区；
- 在 K8s 中配置健康检查。

## 6. 本地开发依赖

本地 Docker Compose 依赖放在 `local/` 目录，不作为线上部署配置：

- `local/docker-compose.yml`
- `local/docker/mysql/init.sql`

MySQL、Redis 等依赖需要健康检查和 volume 持久化。测试配置与本地 compose 的账号、端口、库名要保持一致。

## 7. 禁止事项

- 不在业务层依赖传输层实现细节。
- 不在仓库中提交真实密码、Token、Cookie、JWT 密钥。
- 不在普通服务代码中使用标准库 `log` 替代统一日志库。
- 不创建跨项目相对路径 `replace`，除非正在调试该共享库且不会提交。
- 不在 `main.go` 中写复杂初始化逻辑。
- 不创建循环导入；子包不导入父包。
- 不用粗粒度分布式锁包住完整业务执行。

## 8. Review Checklist

| 检查项 | 口径 |
|--------|------|
| 架构分层 | Domain 不依赖 Infrastructure/Application |
| 用例封装 | Service 层表达完整业务流程 |
| 启动入口 | `main.go` 简洁，Bootstrap 可测试 |
| 配置 | 支持 `-f`，敏感信息不在仓库 |
| Nacos | 多 DataID 有顶级前缀，热更新边界清楚 |
| 可选组件 | `enabled=false` 时服务可启动 |
| 日志 | 统一日志库，无敏感信息 |
| 错误 | 不静默丢弃关键错误，跨层保留根因 |
| 测试 | 核心领域/服务逻辑有表驱动测试；必测范围与例外说明符合 [unit-test-standard.md](unit-test-standard.md) |
| 部署 | Makefile/Docker/健康检查符合约定 |
