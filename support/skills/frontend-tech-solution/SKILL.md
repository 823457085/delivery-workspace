---
name: frontend-tech-solution
description: 编写或修订前端技术方案，统一使用团队 Confluence 最新模板输出单篇方案，支持用户当次明确指定的模板；也支持明确要求的前端技术方案产物包、输入完整性检查和 AI Coding 准出建议。用于前端技术方案编写、方案更新及前端专项产物包，不用于直接实现业务代码。
metadata:
  author: hu
  version: "0.2.0"
---

# Frontend Tech Solution Workflow

## 设计说明

这个 Skill 用于编写前端技术方案，并保留专项产物包流程。单篇方案沿用当前适用模板，四文档结构用于明确要求分拆研发、测试和 AI Coding 材料的场景；两者共享基于证据编写和标记待确认项的原则。

## 选择输出形式

本技能是前端技术方案唯一的生成与修订流程，适用于 Codex、工作台和正式评审交付。普通方案走单篇流程。只有当次明确要求前端专项产物包时，才进入下方四文档流程。

1. 使用团队 [前端技术方案模板](https://confluence.hahabianli.com/pages/viewpage.action?pageId=12320939)。编写前读取该页最新内容，以实际栏目及顺序为准。仅当用户在本次任务中明确指定另一份模板时才采用该模板。历史偏好、旧方案、旧 S2a 模板与配套技能中的旧章节仅供核对资料和适用要求，生成版式以本节为准。
2. 使用本次 PRD、设计稿、接口和代码中的可核实事实替换示例。模板示例仅用于理解栏目，遵循项目规则和用户约定，接口展示文案从正确字段原样输出（包括 L 码）。缺少关键依据时标记待确认；未读到代码或接口，不声称已确认组件复用、字段契约或具体文件路径。
3. 输出一份技术方案。已有方案可复用经核实的业务与技术内容，按当前模板栏目重排后交付。保留最新版栏目，不补回已删除的「代码合并及部署步骤」等栏目；有实际发布风险时，可在适用的现有栏目说明。用户当次明确要求的内容优先。
4. 模板无法读取时说明限制，继续整理可确定内容。先出草案时注明栏目待核验，模板核验后再形成正式方案。

单篇流程不加载下方产物包专用模板与 Prompt，也不额外输出判级表、审核报告或 AI Coding 附件。已有单篇方案的独立评审优先使用 `frontend-tech-design-review`（已安装时）；本机无该技能时按用户所选模板和需求证据评审，正式 G2a 覆盖评审可使用 `tech-design-coverage-review`。

## 四文档产物包规则

本节及下方的产物包结构、参考文件和工作流仅用于明确要求的前端专项产物包。

- Do not generate a complete package when key inputs are missing. Output missing information and pending questions first.
- The default lightweight package contains 4 Markdown files:
  - `00_前端技术方案评审摘要.md`
  - `01_前端实现与接口细节.md`
  - `02_测试验收与风险清单.md`
  - `03_AI_Coding上下文与审核报告.md`
- Every key conclusion must have an evidence source: PRD, design, API docs, mock data, code path, standards, or human confirmation.
- Mark uncertain content as `待确认`; never write assumptions as facts.
- P0 pending items may appear in a draft, but they block Coding go/no-go.
- Always choose a template level before generating: L1, L2, or L3.
- Agent chooses the level by default. If the user specifies a level, validate it; upgrade when the requested level is too low for the risk.
- Use Chinese for outputs unless the user asks otherwise.

## Package Structure

| 文件 | 读者 | 责任边界 |
|---|---|---|
| `00_前端技术方案评审摘要.md` | 研发负责人、产品、测试、评审参与人 | 需求范围、核心方案、影响范围、主要风险、准出建议 |
| `01_前端实现与接口细节.md` | 前端研发、AI Coding | 页面/模块、组件、数据流、接口字段、关键逻辑、文件变更建议 |
| `02_测试验收与风险清单.md` | 测试、产品、研发负责人 | 交互状态、测试重点、风险、待确认项、已确认结论 |
| `03_AI_Coding上下文与审核报告.md` | AI Coding、前端研发、准出负责人 | 已确认上下文、代码约束、重点任务、禁止项、AI 审核报告 |

Main-document length guidance:

- Do not hard-limit by word count.
- `00_前端技术方案评审摘要.md` must start with a 300-500 字方案摘要.
- Small changes usually fit in 800-1200 字 after the summary.
- Normal multi-page or multi-component work should target 1200-1800 字.
- Complex cross-system work can reach about 2500 字, but details must move to attachments.

## Reference Loading

Load only what the task needs:

| Task | Read |
|---|---|
| Prepare or inspect input materials | `references/01_前端技术方案输入清单.md` |
| Check whether inputs can support a package | `references/02_Prompt_输入完整性检查.md` |
| Decide L1 / L2 / L3 | `references/09_前端技术方案模板分级规则.md` |
| Generate a frontend technical solution package | `references/03_前端技术方案模板.md`, `references/04_Prompt_技术方案生成.md`, and `references/09_前端技术方案模板分级规则.md` |
| Review an existing package | `references/05_Prompt_技术方案审核.md`, `references/06_前端技术方案准出标准.md`, and `references/09_前端技术方案模板分级规则.md` |
| Explain common problems or calibrate severity | `references/07_常见问题库.md` |
| Need examples | Load only the specific file under `references/examples/` matching L1, L2, L3, review, or correction examples; if examples are single-document legacy examples, adapt their content into the 4-file package structure |

## Workflow

### 1. Classify the user's request

- If the user provides raw requirements or asks “能不能生成方案”: run input completeness first.
- If the user asks to generate a package: check input completeness, choose L1/L2/L3, then generate the 4-file package.
- If the user provides an existing package: review it against source materials, template level, package structure, and go/no-go criteria.
- If the user asks whether it can enter Coding: produce a go/no-go recommendation using准出标准.
- If the user asks for examples or rules: answer from the relevant reference without generating a full package.

### 2. Gather facts before conclusions

Before claiming code reuse or generating AI Coding context, check whether the user provided one of:

- local project path: `localPath`
- remote repository: `repo` plus `ref` and optional `subdir`
- explicit no-code choice: “本次不读取代码上下文 / 无代码上下文可用”

If none is provided, pause the generation flow and ask for one of those code sources. Do not silently continue into a complete package. Until a code source is provided or the user explicitly chooses no-code mode, do not write confirmed file paths, reusable components, API wrappers, type definitions, or AI Coding tasks.

When code context is available, inspect the project before claiming reuse or impact:

- Use `rg` / `rg --files` to find relevant pages, components, routes, API wrappers, type definitions, hooks/composables, stores, permissions, and tracking utilities.
- Only write “复用某组件 / 方法 / Hook / API 封装” when a real path or source is found.
- If not found, write “未发现明确可复用实现，建议新增或待人工确认”.
- Do not invent API paths, fields, components, permissions, routes, tracking events, or implementation details.

### 3. Input completeness gate

Use `references/02_Prompt_输入完整性检查.md`.

Return one of:

- `可以生成完整产物包`
- `只能生成部分产物`
- `不建议生成`

Rules:

- API docs / Mock data are conditionally required when the feature involves APIs, fields, data display, submission, export, state changes, pagination, filtering, or sorting.
- Pure static UI, text, or style changes may omit API docs only when the inputs explicitly say no interface or data changes are involved.
- If only part of the package can be generated, clearly list which files can be generated and which files are blocked.
- Unconfirmed APIs, fields, components, permissions, tracking events, and implementation details must not enter the AI Coding context package as confirmed tasks.
- P0 unresolved items block Coding go/no-go.

### 4. Template level gate

Use `references/09_前端技术方案模板分级规则.md`.

Output:

```markdown
## 模板级别判定

- 使用者指定级别：未指定 / L1 / L2 / L3
- 建议级别：L1 / L2 / L3
- 判定依据：
- 是否命中升级条件：
- 可简化文件或章节：
- 必须强化文件或章节：
```

Level rules:

- L1: pure UI/text/style/layout changes with no API, permission, route, tracking, shared component, or data-flow changes. Still use the 4-file package, but keep attachment content lightweight and mark irrelevant sections as `不涉及`.
- L2: normal page/module/business-component changes, commonly involving APIs, fields, forms, lists, filters, and local state. Use the default 4-file package.
- L3: shared utilities/components, permissions, core flows, multi-page/multi-role/multi-business impact, monitoring, rollback, gray release, or compatibility risk. Use the 4-file package and strengthen impact, regression, rollback, monitoring, and owner confirmation sections.

### 5. Generate the package

Use `references/03_前端技术方案模板.md` and `references/04_Prompt_技术方案生成.md`.

- Always output with explicit file separators.
- Keep `00_前端技术方案评审摘要.md` focused on review and decision-making.
- Put detailed implementation, interface fields, and code-path suggestions in `01_前端实现与接口细节.md`.
- Put interaction states, tests, risks, pending questions, and confirmed conclusions in `02_测试验收与风险清单.md`.
- Put AI Coding context and the full AI review report in `03_AI_Coding上下文与审核报告.md`.
- Keep cross-file conclusions consistent.

### 6. Review and go/no-go

Use `references/05_Prompt_技术方案审核.md` and `references/06_前端技术方案准出标准.md`.

Review first for blocking risks:

- Missing core requirement or acceptance criteria.
- Missing required package files or details placed in the wrong file.
- Unsupported API path or field.
- Unverified permission or tracking rule.
- Reuse claims without code evidence.
- Incorrect L1/L2/L3 level.
- Missing impact/regression/rollback for L3.
- P0 pending items still unresolved.

Then output:

- 审核结论：通过 / 有条件通过 / 不通过
- 是否建议进入 Coding：是 / 否 / 有条件
- P0/P1/P2 issues
- must-fix items before Coding
- owner confirmation points

## Final Self-Check

Before finishing:

- Did you run input completeness when source materials were incomplete?
- Did you ask for `localPath`, `repo/ref/subdir`, or explicit no-code confirmation when code source was missing?
- Did you output L1/L2/L3 judgment before generation?
- Did you output the default 4 files or clearly explain why only partial files can be generated?
- Did `00_前端技术方案评审摘要.md` avoid full interface fields, full test cases, and full AI review content?
- Did every API, field, component, permission, route, tracking event, and risk have a source?
- Did unresolved P0 items block Coding go/no-go?
- Did L3 include impact, regression, rollback, monitoring, and owner confirmation?
- Did you avoid adding unrelated process docs, implementation code, or speculative features?
