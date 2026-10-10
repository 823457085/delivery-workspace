#!/usr/bin/env bash
# 将 guides/*.md 同步到 Confluence（Markdown 宏，非 MD→HTML 直灌）
# 依赖：Cursor user-confluence MCP 或手动粘贴
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SPACE_KEY="${CONFLUENCE_SPACE_KEY:-}"
PARENT_ID="${CONFLUENCE_PARENT_ID:-}"
HUB_TITLE="AI 原生产研测交付门禁 v1.0"

build_body() {
  python3 "${SCRIPT_DIR}/build-confluence-storage.py" "$1"
}

echo "== AI Delivery Kit Confluence 同步 v1.0.0 =="
echo "Space: ${SPACE_KEY}  Parent: ${PARENT_ID}"
echo ""
echo "推荐：在 Cursor 中对 user-confluence MCP 执行 create-content，"
echo "body 使用 build-confluence-storage.py 输出（含 markdown 宏）。"
echo ""
echo "仓库权威源："
echo "  - ${PKG}/guides/confluence-hub.md"
echo "  - ${PKG}/guides/confluence-one-pager.md"
echo "  - ${PKG}/guides/pilot-90day-checklist.md"
echo ""
echo "已发布 Hub（若存在）："
echo "  Set CONFLUENCE_BASE_URL and the target page id for your own site."
echo ""
echo "生成 Storage 预览："
echo "  build_body guides/confluence-one-pager.md | head -c 200"
echo ""
build_body "${PKG}/guides/confluence-hub.md" >/dev/null
build_body "${PKG}/guides/confluence-one-pager.md" >/dev/null
build_body "${PKG}/guides/pilot-90day-checklist.md" >/dev/null
echo "OK: 三份 Markdown 均可转换为 Storage（markdown 宏）"
