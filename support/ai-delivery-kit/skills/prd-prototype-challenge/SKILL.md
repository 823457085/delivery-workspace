---
name: prd-prototype-challenge
description: Challenge and question PRD and product prototypes before requirement review. Generates dev-prd-review or qa-prd-review with ambiguities, omissions, contradictions, and Q-xxx items. Use when dev or QA must AI-read PRD/prototype before G1, 挑刺 PRD, 预研报告, R1a, R1b, or dev-prd-review.
---

# PRD 与原型挑刺（R1a / R1b）

## 何时使用

- 开发/测试参加 **G1 需求评审前**（R0 通过后 1 工作日内）
- 用户说：挑刺 PRD、预研、评审前读 PRD、dev-prd-review、qa-prd-review

## 产出

| 角色 | 文件 | 模板 |
|------|------|------|
| 开发主程 | `dev-prd-review.md` | `ai-delivery-kit/artifacts/templates/dev-prd-review.md` |
| 测试主测 | `qa-prd-review.md` | `ai-delivery-kit/artifacts/templates/qa-prd-review.md` |

## 必填输入

1. `@PRD.md`（R0 已通过，含 BG/BR/FR/SR/PERM/EX/AC/PG/UI/NFR ID）
2. 原型（团队使用 **Figma AI**）：
   - **Agent 主读**：PRD §4 页面索引（PG-xxx + Figma Frame 列）+ 主流程文字
   - **人工辅助**：Figma 链接（开发/测试自行打开对照）
   - 有 UI 时 §4 页面索引 **不得为空**；禁止仅给 Figma 链接
3. 角色：`dev` 或 `qa`

## 执行步骤

### Step 1 · 通读 PRD

逐条提取：BG、OBJ、SCOPE、RISK、US、BR、FR、SR、PERM、EX、AC（Given/When/Then）、PG、UI、NFR、In/Out Scope、依赖风险。
标记：模糊词（「尽量」「优化体验」）、不可测描述、缺少数值/状态的 AC。

### Step 2 · 审查原型（有 UI 时）

**优先读 PRD §4**（Figma AI 誊写的页面索引与主流程）；若用户另提供 Figma 链接，提示人工对照，Agent 不得编造未见过的帧内容。

逐页/逐流程对比 PRD：

| 维度 | 检查 |
|------|------|
| 一致性 | 原型有但 PRD 无 / PRD 有但原型无 |
| 交互 | 缺省态、加载态、错误态、空态 |
| 字段 | 标签、校验、长度、格式 |
| 权限 | 不同角色看到的是否说明 |

### Step 3 · 挑刺（≥5 条，编号 Q-001）

| 分类 | 示例 |
|------|------|
| **歧义** | AC 中「快速响应」无具体指标 |
| **遗漏** | 未定义删除/编辑/取消流程 |
| **矛盾** | PRD 与原型字段不一致 |
| **技术疑虑**（dev） | 跨服务事务、幂等、数据迁移 |
| **测试疑虑**（qa） | 缺测试账号、无法造数、AC 不可测 |

每条必须引用 **PRD Item ID**（BG/BR/FR/SR/PERM/EX/AC/PG/UI/NFR）或 **原型页面**，并完整说明：

- 问题是什么
- 为什么这是问题
- 会影响谁（产品 / 开发 / 测试 / 发布 / 运营 / 财务 / 用户）
- 建议如何补齐或改写
- 是否阻塞 G1
- 严重级别：Blocker / Major / Minor / Info

禁止只写“需确认 / 需补充 / 描述不清”。若材料缺失，写明“原文未说明 / 原型未说明 / 待评审确认”，不要替产品补写决策。

### Step 3.1 · 计算澄清率

R1a/R1b 必须统计：

```text
澄清率 = 去重后 Blocker + Major 待澄清问题数 ÷ PRD 原子需求项总数
```

PRD 原子需求项总数优先取 `PRD.md` §2.3 / §5.2；缺失时按 BG+OBJ+SCOPE+RISK+US+BR+FR+SR+PERM+EX+AC+PG+UI+NFR 现场统计。

判定：

- ≤10%：Pass
- >10% 且 ≤20%：ConditionalPass，必须在 `review-minutes.md` 关闭 Blocker/Major
- >20%：Fail，PRD 退回产品补充
- P0 主流程存在未确认 AC/BR/FR/SR/PERM/EX：直接 Fail

### Step 4 · 输出报告

按对应模板填写：

- 元信息：**AI 工具、AI 生成时间**（必填）
- 阅读摘要 **≥200 字**，禁止复制 PRD 原文
- 问题表 Q-001 起，标注严重级别和是否 Block G1
- 澄清率统计表
- 开发：风险 ≥1 条；测试：可测性分析表 + 初步测试策略

### Step 5 · 人工修订

删除 AI 误报；补充真实疑问；签名后提交 R1 审核。

## 输出格式（摘要）

```markdown
## 问题与待确认事项
| Q ID | 严重级别 | 分类 | 关联 | 问题 | 问题解释 | 影响 | 改进建议 | Block G1 |
| Q-001 | Major | 遗漏 | AC-003 | ... | ... | ... | ... | 是 |
```

## 质量底线（R1 审核用）

- 问题 ≥5，且具体
- 每条问题都有解释、影响、改进建议
- 每条问题有严重级别，Blocker/Major 计入澄清率
- 澄清率统计非空
- 禁止「暂无问题」
- 禁止只写「需确认 / 需补充」
- 摘要体现个人理解

## 禁止

- 编造 PRD 中不存在的内容
- 敏感信息进入对话
- 代替人工签字
