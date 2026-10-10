# AI 交付门禁 · 90 天试点检查清单

> **AI Delivery Kit** **v1.0.0**  
> **Confluence**：[90 天试点检查清单](https://confluence.example.com/spaces/TEAM/pages/1003/)（TEAM · 示例 ID 1003）  
> **试点周期**：Day 0–90（建议先 4 周基线，再 86 天评估）  
> **指标权威源**：[core/metrics.md](../core/metrics.md)

---

## 1. 试点目标

| 维度 | 90 天目标 |
|------|-----------|
| 流程 | 试点团队 100% 走 Context Pack + Gate 签字链 |
| AI 使用 | 活跃使用率 ≥80%；需求 AI 留痕 ≥80% |
| 质量 | 缺陷逃逸率、CFR 不劣于基线 |
| 效率 | Lead Time、提测一次通过率第二迭代起改善 |

---

## 2. Day 0 · 启动（第 1 周前）

| # | 检查项 | 负责人 | Pass |
|---|--------|--------|:----:|
| 0-1 | 选定试点团队（产品+研发+测试+发布） | Leader | |
| 0-2 | 全员阅读 [lifecycle.md](./lifecycle.md) + [quick-start-by-role.md](./quick-start-by-role.md) | Leader | |
| 0-3 | 执行 `./install.sh`，确认 5 Skills 可用 | 研发 | |
| 0-4 | Confluence 宣贯页已发布（[confluence-one-pager.md](./confluence-one-pager.md)） | Leader | |
| 0-5 | 建立 4 周基线数据采集表（见 §6） | Leader | |
| 0-6 | 明确 Gate 签字人（R0/G1/G2/G3/G5/G8） | Leader | |
| 0-7 | 试点需求 ≥2 个进入 R0（验证端到端） | 产品 | |

---

## 3. 第 1–4 周 · 基线期

每周勾选（W1–W4）：

| # | 检查项 | W1 | W2 | W3 | W4 |
|---|--------|:--:|:--:|:--:|:--:|
| 1-1 | 新需求均建 `requirements/{迭代}-{需求}/` | | | | |
| 1-2 | PRD 含 §11 页面索引（有 UI 时） | | | | |
| 1-3 | prd-self-check 已生成，Fail/Partial 有解释和改进方向 | | | | |
| 1-4 | R1a/R1b 在 G1 前完成且 Q≥5，Q 有解释/影响/建议 | | | | |
| 1-5 | G2 覆盖矩阵 Gap=0 | | | | |
| 1-6 | implementation-plan 先于提测 | | | | |
| 1-7 | G3 P0 TC 自测覆盖 100% | | | | |
| 1-8 | B 级 AI 产出含留痕块 | | | | |
| 1-9 | 无口头绕过 Gate 记录 | | | | |

**基线记录**（W4 末汇总）：

| 指标 | W1 | W2 | W3 | W4 | 四周均值 |
|------|----|----|----|----|----------|
| R1 驳回率 | | | | | |
| G2 一次通过率 | | | | | |
| G3 提测一次通过率 | | | | | |
| Lead Time（天） | | | | | |
| 返工次数/需求 | | | | | |

---

## 4. 第 5–12 周 · 强化期

### 4.1 每迭代必查（Gate 合规）

| Gate | 硬门槛 | 审计方式 |
|------|--------|----------|
| R0 | §11 原型；AC 可测；prd-self-check 解释充分 | gate-review 预检 + 人签 |
| R1 | 双 Pass；Q≥5；Q 有解释/影响/建议 | 抽查 dev/qa-prd-review |
| G1 | Q 关闭 | review-minutes |
| G2a/b | 覆盖 100% | coverage Skill 输出 |
| G3 | implementation-plan、自测证据和 PR 准备齐全 | artifact 时间戳 + 抽查 |
| G3 | P0 100% + 证据 | self-test-coverage-check |
| G5 | CL Fail=0 | acceptance-record |
| G8 | 灰度回滚 | release-plan |
| G9 | 指标对比 | outcome-review |

### 4.2 双周抽查（每 2 周）

| # | 动作 | 样本量 | Pass |
|---|------|--------|:----:|
| 4-1 | 抽查 AI 需求留痕完整性 | 5 个需求 | |
| 4-2 | 抽查 AI PR pr-checklist | 5 个 PR | |
| 4-3 | 抽查 §11 与 Figma 一致性 | 3 个有 UI 需求 | |
| 4-4 | 抽查 P0 Pass 证据真实性 | 3 条 TC | |
| 4-5 | 记录阻塞项与规范缺口 | 清单 | |

---

## 5. 第 13 周 · 90 天评估

| # | 评估项 | 90 天目标 | 实际 | 达标 |
|---|--------|-----------|------|:----:|
| 5-1 | AI 活跃使用率 | ≥80% | | |
| 5-2 | 需求 AI 留痕占比 | ≥80% | | |
| 5-3 | PR AI 留痕占比 | ≥70% | | |
| 5-4 | Prompt/Skill 模板使用率 | ≥80% | | |
| 5-5 | implementation-plan 先行率 | ≥90% | | |
| 5-6 | G3 提测一次通过率 | ≥60% | | |
| 5-7 | Outcome Review 完成率 | ≥90% | | |
| 5-8 | 缺陷逃逸率 vs 基线 | 不劣化 | | |
| 5-9 | Change Failure Rate vs 基线 | 不劣化 | | |
| 5-10 | Lead Time vs 基线 | 下降或持平 | | |

**决策**（三选一）：

- [ ] **推广**：全团队强制；更新 Confluence 与 onboarding
- [ ] **调整**：保留 Gate，放宽非核心项；修订 spec 后 v1.1
- [ ] **暂停**：记录根因；回退至部分 Skill 可选

---

## 6. 数据采集模板

### 6.1 单需求跟踪表

| 字段 | 说明 |
|------|------|
| 需求 ID | `requirements/{迭代}-{需求}/` |
| R0 Pass 日 | |
| G1 Pass 日 | |
| G2 Pass 日 | |
| implementation-plan 日 | |
| G3 Pass 日 | |
| 上线日 | |
| R1 驳回次数 | |
| G2 驳回次数 | |
| G3 驳回次数 | |
| AI 留痕 Y/N | PRD/方案/用例/代码 |
| G9 完成 Y/N | |

### 6.2 周报（Leader 填写）

```
周次：W__
试点团队：__
本周新进入需求数：__
R0/G1/G2/G3 Pass 数：__
主要阻塞（Top3）：__
规范缺口（需修订 spec）：__
下周动作：__
```

---

## 7. 常见失败模式与对策

| 现象 | 根因 | 对策 |
|------|------|------|
| R1「暂无问题」 | 未用 Skill 或敷衍 | 驳回；强制 prd-prototype-challenge |
| G2 Gap>0 | 矩阵未维护 | 驳回；coverage Skill 预检 |
| 无 plan 直接编码 | G3 未执行 | 代码不合并；补 implementation-plan |
| 仅 Figma 无 §11 | 双轨未落地 | R0 不通过 |
| P0 Pass 无证据 | 自测走过场 | G3 驳回 |
| AI 留痕缺失 | B 级未执行 | 合规审计；补 _ai-usage-block |

---

## 8. 相关文档

| 文档 | 路径 |
|------|------|
| 全流程 | [lifecycle.md](./lifecycle.md) |
| Gate 检查表 | [core/gates.md](../core/gates.md) |
| 指标定义 | [core/metrics.md](../core/metrics.md) |
| 宣贯一页纸 | [confluence-one-pager.md](./confluence-one-pager.md) |
| Cursor 实操 | [cursor-guide.md](./cursor-guide.md) |
