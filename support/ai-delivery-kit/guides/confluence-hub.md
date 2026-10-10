# AI 原生产研测交付门禁 v1.0

| 字段 | 值 |
|------|-----|
| **AI Delivery Kit** | `ai-delivery-kit/` |
| **版本** | 1.0.0（初版） |
| **仓库路径** | `team/ai-delivery-kit/` |
| **上位方案** | 《AI 原生产研全流程落地方案》V1.0 |

## 铁律

- 每一关 **人工 Gate 签字**，AI 不能代替
- **G3 提测准入前必须有 implementation-plan**
- **G2 覆盖 100%** · **G3 P0 100%**
- 有 UI 时 PRD **§11 页面索引**（Figma AI 双轨）

## Confluence 页面（SOP 空间）

| 页面 | ID | 仓库源 |
|------|-----|--------|
| [AI 原生产研测交付门禁 v1.0](https://confluence.example.com/spaces/TEAM/pages/1001/) | 1001 | 本文件 |
| [宣贯一页纸](https://confluence.example.com/spaces/TEAM/pages/1002/) | 1002 | confluence-one-pager.md |
| [90 天试点检查清单](https://confluence.example.com/spaces/TEAM/pages/1003/) | 1003 | pilot-90day-checklist.md |

同步方式：`scripts/sync-confluence.sh` + `scripts/build-confluence-storage.py`（Markdown 宏）

## 快速安装

```bash
cd ai-delivery-kit && ./install.sh
```

## 权威源

- 规范总纲：`README.md` · `kit.yaml`
- 全流程图：`guides/lifecycle.md`
- Gate 检查表：`core/gates.md`
