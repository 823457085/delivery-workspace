# AI Delivery Kit

AI Delivery Kit 是公司级的 AI 交付规范包，用来沉淀产品、研发、测试在需求协作过程中的公共规则、模板、提示词、Skills 和工具适配配置。

它不是单独的业务系统，也不是某个 AI 工具的私有配置。它的定位是：

```text
一套公司级交付标准，多种 AI 工具和平台统一消费。
```

AI Delivery Hub 负责承载需求流转、文档协作、本地 Codex Bridge、MCP 进度回传和人工确认；AI Delivery Kit 负责定义“每个阶段、每个角色、每类交付物应该怎么做、怎么检查、用什么模板和提示词”。

当前仓库仍处于试点建设阶段，可以快速迭代，不需要背历史包袱。但新增规则、模板、提示词和适配器时，应统一在本仓库内沉淀，避免散落在个人提示词、Hub 前端代码或某个项目目录里。

## 解决什么问题

传统的 Jira、TAPD、Confluence 更擅长记录任务和文档，但很难把页面上的需求流转和每个人本地 AI 工具的工作过程打通。AI Delivery Kit + AI Delivery Hub 的目标是：

- 让产品、研发、测试围绕同一个“需求”协作，而不是各写各的文档。
- 明确每个阶段要交付什么内容、由谁负责、怎么检查。
- 让 AI 不是自由发挥，而是按统一模板、统一规则、统一提示词生成和审查。
- 支持本地 Codex / Cursor 等工具读取同一套规范。
- 支持 AI Delivery Hub 根据 Kit 配置动态展示阶段、角色交付物和检查规则。
- 持续沉淀优秀样例、常见问题和团队最佳实践。

## 仓库地址

```text
git@git.example.com:team/ai-delivery-kit.git
```

包根目录就是仓库根目录。

运行时约定：

| 配置项 | 推荐值 |
|--------|--------|
| `kit_repo.path` | `.` |
| `kit_repo.target_path` | `ai-delivery-kit` |
| 运行时 `kit_path` | `ai-delivery-kit` |

后续不要在新规则、提示词、模板或适配器中继续引入旧的产品化包名。

## 快速开始

### 安装到 Codex

```bash
./install.sh codex --validate
./install.sh codex --write-codex-agents /path/to/workspace
```

安装后：

- Skills 会安装到 `~/.codex/skills`
- Kit 包会安装到 `~/.codex/ai-delivery-kit`
- 指定工作区会生成或更新 `AGENTS.md`，让 Codex 能定位 Kit

### 安装到 Cursor

```bash
./install.sh cursor --validate
./install.sh cursor --write-cursor-rules /path/to/workspace
```

安装后：

- Cursor 规则会写入 `/path/to/workspace/.cursor/rules/ai-delivery-kit.mdc`
- 项目本地会保留可读的 Kit 副本，方便 Cursor 引用规范、模板和提示词

### 同时安装 Codex 和 Cursor

```bash
./install.sh both --validate --workspace /path/to/workspace
```

这是项目工作区推荐用法。它会同时写入 Codex 的 `AGENTS.md` 和 Cursor 的项目规则。

### 仅校验仓库

```bash
./tests/validate-package.sh
```

每次调整 Kit 后都建议执行一次。

## 目录结构

```text
ai-delivery-kit/
├── kit.yaml                         # 包元信息和入口声明
├── core/                            # 核心规则、阶段、角色、检查点、工程质量标准
│   ├── checkpoints.yaml             # 面向产品化展示的阶段和检查点元数据
│   ├── deliverables.yaml            # 阶段 -> 角色 -> 交付物配置，Hub 工作台消费
│   ├── gates.md                     # 检查点规则说明
│   ├── gate-policy.md               # 检查点判定策略
│   ├── team-collaboration-model.md  # 团队协作模型
│   └── *-standard.md                # 工程、测试、前端、接口、数据库等质量标准
├── artifacts/
│   ├── templates/                   # PRD、技术方案、测试方案、自测报告等模板
│   ├── schemas/                     # 结构化结果和契约
│   └── examples/                    # 优秀样例和反例
├── prompts/                         # AI 生成、修订、自检、评审提示词
├── skills/                          # Codex Skills 源文件
├── adapters/
│   ├── codex/                       # Codex AGENTS 模板和安装说明
│   ├── cursor/                      # Cursor Rules 模板和安装说明
│   ├── ai-delivery-hub/             # Hub 消费 Kit 的契约说明
│   └── gate-engine/                 # 内置检查引擎消费 Kit 的契约说明
├── governance/                      # 贡献、Owner、评审策略
├── guides/                          # 团队落地指南、角色指南、试点指南
├── tests/                           # 包结构校验
└── install.sh                       # 安装器
```

## 团队协作主线

Hub 的主线是“需求”，不是“某一份 PRD”。产品、研发、测试都围绕同一个需求工作区协作。

当前 Kit 定义的主流程：

| 阶段 | 主要目标 | 典型交付物 |
|------|----------|------------|
| 产品需求设计 | 把需求讲清楚、边界讲清楚、验收口径讲清楚 | `PRD.md`、`prd-self-check.md`、`prototype-notes.md`、`dev-prd-review.md`、`qa-prd-review.md`、`review-minutes.md` |
| 技术方案设计 | 研发明确实现方案，测试明确测试策略 | `tech-design.md`、`test-plan.md`、`test-cases.md` |
| 编码执行 | 研发按方案实现并提供可检查的自测证据 | `implementation-plan.md`、`self-test-report.md`、`pr-checklist.md` |
| 验收发布 | 测试给出结果，产品确认验收，团队沉淀发布和复盘材料 | `test-report.md`、`acceptance-record.md`、`release-plan.md`、`outcome-review.md` |

检查点内部仍可以保留稳定 ID，例如 `R0`、`G1`、`G2a`、`G2b`、`G3`、`G5`，但对外展示应优先使用 `core/checkpoints.yaml` 中的中文名称，例如“需求完整性检查”“需求共识评审”“技术方案审核”“提测准入”。

## 各角色怎么用

### 产品

产品侧重点是把需求变成可评审、可实现、可测试的标准材料：

- 使用 `artifacts/templates/PRD.md` 编写产品需求文档。
- 使用 `artifacts/templates/prd-self-check.md` 完成 PRD 自检。
- 必要时补充 `prototype-notes.md`。
- 根据研发、测试预审问题补齐范围、用户故事、AC、边界、风险和验收口径。

常用入口：

- `prompts/S0-PRD.md`
- `prompts/R0-prd-self-check.md`
- `skills/delivery-gate-docs`

### 研发

研发侧重点是从需求出发，确认能不能做、怎么做、怎么自测、怎么提测：

- 使用 `dev-prd-review.md` 挑出需求中的技术疑问和不明确点。
- 使用 `tech-design.md` 输出技术方案。
- 使用 `implementation-plan.md` 规划实现。
- 使用 `self-test-report.md` 和 `pr-checklist.md` 给出提测前证据。
- 对 Go 服务、接口、数据库、前端交互、单元测试等质量要求，参考 `core/*-standard.md`。

常用入口：

- `skills/prd-prototype-challenge`
- `skills/tech-design-coverage-review`
- `skills/self-test-coverage-check`
- `skills/go-service-code-review`
- `skills/codex-cursor-handoff`，仅作为开发者便利流程，不是强制检查点

### 测试

测试侧重点是让需求可测、方案可覆盖、用例可追踪、验收可闭环：

- 使用 `qa-prd-review.md` 在需求阶段提前发现不可测、边界缺失和验收口径不清。
- 使用 `test-plan.md` 和 `test-cases.md` 输出测试方案和用例。
- 使用 `test-report.md` 输出测试结果。
- 使用 `acceptance-record.md` 支持最终验收。

常用入口：

- `skills/prd-prototype-challenge`
- `skills/test-plan-coverage-review`
- `prompts/S2b-test-plan.md`
- `prompts/S2b-test-cases.md`
- `prompts/S4-test-report.md`

## AI 工具如何消费 Kit

### Codex

Codex 通过三部分使用 Kit：

1. `~/.codex/ai-delivery-kit` 中的完整规范包。
2. `~/.codex/skills` 中安装的 Skills。
3. 项目工作区的 `AGENTS.md`，用于告诉 Codex 本项目使用 AI Delivery Kit。

当任务涉及 PRD、技术方案、测试方案、检查点、Hub Work Item 或文档修订时，Codex 应优先读取 Kit 中的模板、提示词和规则，不应凭记忆生成。

### Cursor

Cursor 通过项目内 `.cursor/rules/ai-delivery-kit.mdc` 和本地 Kit 副本读取规则。

建议把 Cursor 用作研发实现工具时，先由 Codex 输出计划和验收清单，再交给 Cursor 执行；这个流程属于开发者效率工具，不是团队评审强制项。

### AI Delivery Hub

Hub 应把 Kit 当作配置源和规则源，而不是在前端或后端硬编码流程：

- 阶段和检查点读取 `core/checkpoints.yaml`
- 角色交付物读取 `core/deliverables.yaml`
- 模板读取 `artifacts/templates/`
- 提示词读取 `prompts/`
- 检查规则读取 `core/gates.md` 和 `core/gate-policy.md`

### Gate Engine

检查引擎应读取 Kit 中的规则、模板和结果 Schema，输出可追踪的结构化检查结果。

权威入口：

- `core/gates.md`
- `core/gate-policy.md`
- `artifacts/schemas/gate-result-schema.md`
- `prompts/gate-review.md`

## 维护约定

### 修改规范

如果要调整阶段、角色、检查点或质量规则，优先修改：

- `core/checkpoints.yaml`
- `core/deliverables.yaml`
- `core/gates.md`
- `core/gate-policy.md`
- `core/*-standard.md`

### 修改模板

如果要调整某类文档应该怎么写，优先修改：

- `artifacts/templates/`

模板应尽量做到：

- 标题稳定
- 字段可复制
- ID 可追踪
- 能被 AI 和人类同时理解
- 能被 Hub 和 Gate Engine 读取或检查

### 修改提示词

如果要调整 AI 如何生成、修订、自检或评审文档，优先修改：

- `prompts/`

提示词不要散落在 Hub 前端、后端代码或个人笔记里。需要产品化复用的提示词，应沉淀回本仓库。

### 修改 Skills

如果要新增或调整 Codex Skills：

- 修改 `skills/<skill-name>/SKILL.md`
- 同步更新 `skills/manifest.tsv`
- 执行 `./install.sh codex --validate`

### 修改工具适配

如果要调整 Codex、Cursor、Hub 或 Gate Engine 的接入方式：

- 修改 `adapters/`
- 必要时同步更新 `install.sh`
- 更新对应目录下的 `README.md`

## 贡献流程

推荐流程：

1. 先明确要解决的问题：模板不够用、规则不清楚、提示词不好用，还是 Hub 消费契约要变。
2. 修改 Kit 源文件。
3. 更新 `CHANGELOG.md`。
4. 执行校验：

```bash
./tests/validate-package.sh
```

5. 如果影响 Codex 或 Cursor 使用方式，执行安装器验证：

```bash
./install.sh both --validate --dry-run --workspace /path/to/workspace
```

6. 合并后通知团队重新安装或让 Hub 拉取最新 Kit。

## 常用文件索引

| 目标 | 文件 |
|------|------|
| 包元信息 | `kit.yaml` |
| 阶段和检查点 | `core/checkpoints.yaml` |
| 角色交付物配置 | `core/deliverables.yaml` |
| 检查点规则 | `core/gates.md` |
| 检查策略 | `core/gate-policy.md` |
| 团队协作模型 | `core/team-collaboration-model.md` |
| 工程质量标准 | `core/code-review-standard.md`、`core/unit-test-standard.md`、`core/api-contract-standard.md`、`core/db-change-standard.md`、`core/frontend-quality-standard.md` |
| 文档模板 | `artifacts/templates/` |
| AI 提示词 | `prompts/` |
| Codex 适配 | `adapters/codex/` |
| Cursor 适配 | `adapters/cursor/` |
| Hub 适配 | `adapters/ai-delivery-hub/` |
| Gate Engine 适配 | `adapters/gate-engine/` |
| 贡献说明 | `governance/contribution.md` |
| 规划路线 | `ROADMAP.md` |

## 常见问题

### AI Delivery Kit 和 AI Delivery Hub 是什么关系？

Kit 是规则、模板、提示词和 Skills 的源头；Hub 是需求协作和流转平台。Hub 应消费 Kit，而不是把 Kit 的规则硬编码在系统里。

### 是否必须使用 Codex 或 Cursor？

不是。Kit 是工具无关的规范包。Codex 和 Cursor 只是当前优先适配的本地 AI 工具。

### 开发一定要使用 Codex -> Cursor 联动吗？

不是。`codex-cursor-handoff` 只是开发工程师的便利 Skill，用于“Codex 做规划、Cursor 做实现、Codex 做验收”。它不是团队强制检查点。

### 为什么要把模板和提示词放在仓库里？

因为团队需要共同维护、共同迭代、可审查、可回滚的公共知识。个人提示词无法形成组织能力。

### Hub 页面上应该展示 R0、G1 这些代号吗？

对用户优先展示中文名称，例如“需求完整性检查”“技术方案审核”。代号可以作为内部稳定 ID 保留，但不应成为主要产品文案。

## 当前状态

当前版本：`1.0.0`

当前状态：`experimental`

这意味着本仓库仍在试点中，欢迎快速调整。但所有调整都应回到同一个源头：AI Delivery Kit。
