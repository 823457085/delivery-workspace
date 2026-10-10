---
name: confluence-markdown-publish
description: Publish or update a Markdown document in Confluence while preserving its structure, tables, Mermaid, and code blocks.
---

# Confluence Markdown Publish

Use this skill when a local Markdown document or AI Delivery artifact must be archived to Confluence.

## Rules

- Prefer Confluence's `markdown` macro as the storage carrier for full Markdown text.
- Do not upload Markdown converted to raw Storage XHTML unless the user explicitly accepts the rendering risk.
- Do not write Confluence unless the user explicitly asks for publication/archive/sync.
- Do not store Confluence PATs, cookies, or passwords in repository files.
- Use environment variables or an approved MCP connector for credentials.

## Workflow

1. Identify the Markdown source file and target Confluence page.
2. Confirm the page ID if it is not provided or discoverable from a trusted mapping.
3. Build Storage XML with a `markdown` macro and CDATA body.
4. Publish through an approved Confluence MCP tool or the bundled script.
5. Report the page title, new version, and URL.

## Bundled Script

For deterministic REST publishing, use:

```bash
python3 "${AI_DELIVERY_KIT_ROOT:?Set AI_DELIVERY_KIT_ROOT}/scripts/publish-confluence-markdown.py" <page_id> <markdown_file>
```

Environment variables:

- `CONFLUENCE_BASE_URL`, required: your own Confluence site URL
- `CONFLUENCE_PAT`, required unless `CONFLUENCE_TOKEN` is set: your own access token
- `CONFLUENCE_TOKEN`, alternative to `CONFLUENCE_PAT`
- `CONFLUENCE_INSECURE_SKIP_VERIFY=true`, only for internal test certificates

## Rendering Notes

The Markdown macro preserves:

- Mermaid fenced blocks
- Markdown tables
- code fences
- inline identifiers such as `snake_case`

If a Confluence space does not render Mermaid inside Markdown macros, publish the Markdown macro anyway and add exported diagrams only when requested.
