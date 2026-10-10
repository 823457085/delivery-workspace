# Go 编程规范

> 适用范围：所有 Go 服务、工具、脚本、SDK 与测试代码。若项目已有更严格约定，以项目约定为准；若冲突，须在 `implementation-plan.md` 或 PR Checklist 中说明。

## 1. 规范基线

团队 Go 代码规范以官方与主流工程实践为基线：

| 来源 | 用途 |
|------|------|
| Effective Go | 语言惯用法、包、接口、错误、并发基础 |
| Go Code Review Comments | Code Review 检查口径 |
| Google Go Style Guide | 企业级风格、命名、包设计、可维护性 |
| Uber Go Style Guide | 后端工程实践、错误处理、并发、测试、性能 |
| [unit-test-standard.md](unit-test-standard.md) | 团队单元测试分层、必测范围、覆盖率和 G3/PR/MR 证据口径 |

**Normative**: 本规范不重复全部外部条款；代码 Owner MUST 在 G3 提测准入阶段按本文件执行，遇到未覆盖问题时优先参考上述基线。

## 2. 自动化工具链

Go 项目 SHOULD 在仓库内提供等价命令，例如 `make lint`、`make test`、`make vulncheck` 或 CI Job。

| 工具 | 目标 | Gate 要求 |
|------|------|-----------|
| `gofmt` / `gofumpt` | 格式统一 | G3 MUST Pass |
| `go test ./...` | 单元测试与包级回归 | G3 MUST Pass |
| `golangci-lint` | 聚合 lint | G3 MUST Pass |
| `staticcheck` | 静态分析与 bug pattern | SHOULD 纳入 CI |
| `govulncheck` | 官方漏洞扫描 | 涉及依赖升级、外部输入、发布包时 MUST 执行 |

推荐最小命令：

```bash
gofumpt -w .
go test ./...
golangci-lint run ./...
govulncheck ./...
```

## 3. 包与命名

| 规则 | 要求 |
|------|------|
| 包名 | MUST 简短、小写、无下划线；避免 `common`、`utils`、`base` 等无边界包 |
| 导出标识符 | MUST 有清晰职责；公开 API MUST 有注释，注释以标识符开头 |
| 接口名 | SHOULD 描述行为，例如 `Reader`、`Store`、`Notifier` |
| 接收者名 | SHOULD 短且一致，避免 `this`、`self` |
| 文件名 | SHOULD 反映主要职责；测试文件以 `_test.go` 结尾 |

**Normative**: 新增包 MUST 能用一句话说明职责边界。若只能命名为 `utils`，说明边界尚未设计清楚。

## 4. 错误处理

| 规则 | 要求 |
|------|------|
| 错误返回 | MUST 显式处理，不允许静默丢弃关键错误 |
| 错误包装 | SHOULD 使用 `%w` 保留根因，便于 `errors.Is` / `errors.As` |
| Sentinel error | SHOULD 放在产生该错误的包内，避免跨层暴露过多实现细节 |
| Panic | MUST 仅用于不可恢复的程序员错误或进程启动期配置错误 |
| 日志 | MUST 避免同时“记录并返回”同一个错误，除非跨进程/异步边界需要留痕 |

示例：

```go
if err := repo.Save(ctx, order); err != nil {
	return fmt.Errorf("save order %s: %w", order.ID, err)
}
```

## 5. Context 与并发

| 规则 | 要求 |
|------|------|
| `context.Context` | SHOULD 作为首参传递，禁止存入结构体作为长期字段 |
| goroutine 生命周期 | MUST 有退出条件；后台任务 MUST 可取消或有明确 owner |
| channel | SHOULD 由发送方关闭；关闭语义必须清楚 |
| 共享状态 | MUST 用锁、channel 或原子操作保护 |
| 定时器 | MUST 正确释放 `Ticker` / `Timer`，避免泄漏 |

**Normative**: 新增 goroutine、定时任务、worker pool 时，技术方案或 PR Checklist MUST 说明取消、错误传播与资源释放方式。

## 6. 接口与分层

| 规则 | 要求 |
|------|------|
| 接口定义位置 | SHOULD 由消费者定义，避免提供方过早抽象 |
| 小接口 | SHOULD 优先单一行为接口，避免胖接口 |
| 依赖方向 | 业务层 MUST 不依赖传输层实现细节 |
| DTO / Model | SHOULD 区分 API 入参、领域对象、存储对象 |
| 全局变量 | MUST 避免承载可变业务状态 |

## 7. 测试规范

通用单元测试口径见 [unit-test-standard.md](unit-test-standard.md)。Go 项目在此基础上补充以下约定：

| 规则 | 要求 |
|------|------|
| 表驱动测试 | SHOULD 作为多分支逻辑的默认写法 |
| 测试命名 | SHOULD 描述行为与场景，例如 `TestCreateOrder_WhenStockInsufficient` |
| 并发测试 | MUST 可重复执行，避免依赖 sleep 猜时间 |
| 外部依赖 | SHOULD 使用 fake / stub / httptest，避免单测依赖真实外部服务 |
| Bug Fix | MUST 先补失败复现用例，再修复 |
| 核心业务覆盖 | SHOULD 对新增/修改核心业务代码达到 80% 行覆盖率；未达标须在 PR Checklist 说明 |
| 覆盖口径 | G3 仍以 `self-test-report.md` 的 P0 覆盖率为权威 |

## 8. 性能与资源

| 规则 | 要求 |
|------|------|
| 大对象拷贝 | SHOULD 避免无意义复制；是否用指针以语义和成本共同决定 |
| 字符串拼接 | 热路径 SHOULD 使用 `strings.Builder` 或字节缓冲 |
| JSON / IO | MUST 检查 decode、encode、close、flush 错误 |
| defer | SHOULD 用于清理资源；热路径中大量 defer 需评估成本 |
| benchmark | 性能敏感改动 SHOULD 提供 benchmark 或压测证据 |

## 9. 安全与依赖

| 规则 | 要求 |
|------|------|
| 输入校验 | 外部输入 MUST 校验边界、长度、枚举值与权限上下文 |
| 敏感信息 | MUST 不写入日志、错误信息、测试快照与 AI 上下文 |
| SQL / 命令 | MUST 使用参数化 API，禁止拼接未可信输入 |
| 依赖升级 | MUST 说明影响范围；发布前 SHOULD 运行 `govulncheck` |
| 配置 | Secret MUST 来自安全配置源，禁止硬编码 |

## 10. G3 提测准入接入

### implementation-plan

`implementation-plan.md` 涉及 Go 代码时 SHOULD 补充：

| 项 | 内容 |
|----|------|
| Go 影响面 | 包、接口、goroutine、存储、外部依赖 |
| 错误策略 | wrap、sentinel、重试、降级、日志边界 |
| 并发策略 | 取消、超时、资源释放、共享状态保护 |
| 测试策略 | 单测、表驱动、fake、race/benchmark 是否需要 |

### PR Checklist

Go PR MUST 满足：

| 检查项 | Pass |
|--------|:----:|
| 格式化已执行：`gofmt` 或 `gofumpt` | |
| `go test ./...` 通过，或说明无法执行原因 | |
| 核心业务/金额/权限/状态机改动已有单测或例外说明 | |
| Bug Fix 已补复现用例 | |
| `golangci-lint` / 等价 CI 通过 | |
| 关键错误未被静默丢弃 | |
| 新增 goroutine / 定时器有退出与释放机制 | |
| 外部输入、Secret、SQL/命令调用已做安全检查 | |
| 涉及依赖或发布包时已执行 `govulncheck` | |

## 11. 例外处理

若因遗留代码、第三方约束或紧急修复无法满足本规范，代码 Owner MUST 在 PR Checklist 中记录：

| 字段 | 要求 |
|------|------|
| 例外项 | 明确违反哪条规则 |
| 原因 | 为什么当前不能修复 |
| 风险 | 对质量、安全、稳定性的影响 |
| 补偿措施 | 测试、监控、灰度、后续任务 |
| 关闭时间 | 后续清理的版本或日期 |
