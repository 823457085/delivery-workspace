# Self-Contained Plan Template（面向零上下文执行器的计划模板）

每份计划写入 `plans/NNN-<slug>.md`（三位序号递增），供未参与前期讨论的便宜模型、备用模型、Cursor Agent 或团队群聊实现成员直接执行。

---

## 单份计划结构：`plans/NNN-<slug>.md`

```markdown
# NNN — <简明标题>

- **类别**：correctness | security | perf | tests | tech-debt | migration | dx | docs | direction
- **优先级**：P0 | P1 | P2 | P3
- **工时与风险**：Effort S|M|L · Fix Risk LOW|MED|HIGH
- **前置依赖**：无 | 依赖 Plan NNN（原因）
- **规划基线**：`<git short SHA，若非 Git 目录则记录关键文件 sha256 前 12 位>`（YYYY-MM-DD）

## 为什么改（Why this matters）

2～4 句讲清当前问题、实际影响与期望结果，供实施者与代码审查者对齐意图。

## 基线漂移检查（动手前必跑）

```bash
# Git 仓库使用：
git diff --stat <planned-at-sha> -- <in-scope-path-1> <in-scope-path-2>
# 非 Git 源码包使用：
shasum -a 256 <in-scope-path-1> <in-scope-path-2>
```

若输出显示目标文件核心逻辑已发生预期外变化，先核对下文的“现状代码摘录”是否仍然成立；若不成立，触发 **STOP 条件**停止执行并回报。

## 现状代码摘录（Current state）

列出顾问亲自读取确认的真实代码片段（精确到 `path/file.ts:L10-L28`，严禁包含真实密钥值）：

```ts
// path/file.ts:10-22
...
```

## 项目约定与示范文件（Repo conventions & Exemplar）

- **参考示范文件**：对齐 `path/exemplar.ts:L15-L45` 的错误处理、命名与模块组织风格（附简短示范片段）。
- **仓库验证门禁命令**（Recon 阶段实测确认，禁止猜测）：
  | 检查项 | 命令 | 期望结果 |
  | --- | --- | --- |
  | 类型检查与构建 | `pnpm build` | 退出码 0 |
  | 单元测试 | `pnpm test` | 退出码 0 |

## 修改范围（Scope）

**允许修改（In Scope — 仅限以下文件）**：
- `path/file.ts`
- `test/file.test.ts`（新增或更新）

**禁止触碰（Out of Scope — 即使看似相关也绝不修改）**：
- `path/legacy-file.ts` — 原因说明（如历史兼容链路或非本批职责）
- 任何未列出的公共接口响应结构或 `.env.local` 配置

## 实施步骤（Steps）

### Step 1：<祈使句步骤标题>
精确指明修改的文件、函数/类型符号及关键目标代码形态（保持每步之后代码可编译）。
- **本步验证**：`<具体命令>` → `<期望输出与退出码>`

### Step 2：...

## 测试计划（Test plan）

- 在哪个测试文件、模仿哪个既有测试（如 `test/exemplar.test.ts`）新增哪几类用例（正常路径、本次修复的缺陷回归、关键边界）。
- **注意**：测试必须包含针对业务行为的真实断言，严禁写空断言或只断言 Mock 被调用的形式化测试。

## 完成门禁（Machine-checkable Done Criteria）

全部满足才可标记完成：
- [ ] `pnpm build` 退出码为 0
- [ ] 相关单测命令退出码为 0，新增回归测试全部通过
- [ ] 无任何超出 In Scope 列表的文件被修改
- [ ] 未引入硬编码密钥、`as any` 逃生舱或静默空 `catch`

## STOP 熔断条件（遇到以下任一情况立即停手回报，禁止硬凑）

1. 目标文件实际代码与“现状代码摘录”不符（基线已漂移）。
2. 某一步的验证命令在合理修复尝试后连续失败 2 次。
3. 发现必须修改 Out of Scope 文件或改变公共契约才能完成。
4. 发现计划隐含的关键假设不成立。

## 维护与审查提示（Maintenance notes）

- 代码审查者（Reviewer）重点关注的风险点；
- 本次明确延后不做的后续事项及原因。
```

---

## 计划总索引：`plans/README.md`

```markdown
# Implementation Plans

由 `codebase-improve` 生成于 YYYY-MM-DD。请按顺序与依赖关系执行；遇到 STOP 条件立即停止并报告。

## 执行顺序与状态

| 编号 | 标题 | 优先级 | 工时 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 001 | ... | P1 | S | — | TODO |

状态取值：`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED（附一句话原因）` | `REJECTED（附一句话理由）`

## 已评估暂不修改项（Findings considered and rejected）

- `[SEC-01] ...`：刻意设计（by-design）— <一句话说明原因，后续巡检不再重复上报>。
```
