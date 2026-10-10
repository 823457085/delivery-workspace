---
name: hardcode-i18n-scanner
description: Scan,改造, and validate frontend hardcoded Chinese/i18n workflows. Use when Codex needs to inspect hardcoded Chinese text, update or run a hardcode scanner, normalize Apex or app i18n position codes, export locale keys to Excel, or review team-skills hardcode-scanner output formats.
---

# Hardcode I18n Scanner

## Overview

Use this skill to handle team hardcode-scanner and i18n Excel workflows with small, reviewable changes. Prefer existing project scripts and configuration over inventing new paths.

## Workflow

1. State the exact files you plan to inspect or edit before changing anything.
2. Inspect the repository first:
   - Find scanner scripts with `rg -n "scan_hardcode|hardcode-scanner|scan_invalid_i18n_key|TERMINALNAME" .`.
   - Find locale config with `rg -n "TERMINALNAME|zh-CN|en-US" src/locale .`.
   - Confirm package and Python dependencies from actual files before running commands.
3. Decide the task type:
   - Scanner output change: read `references/hardcode-scanner-output.md`.
   - Locale key Excel export: use `scripts/export_locale_keys_to_xlsx.py`.
   - Hardcoded Chinese replacement: locate existing scanner and replacement scripts, then follow local patterns.
4. Keep edits small:
   - Change only the scanner, locale, or docs files required by the request.
   - Preserve existing CLI flags unless the user asks to remove them.
   - Add backward-compatible flags such as `--legacy-format` when changing output formats.
5. Validate behavior:
   - Run the smallest relevant command first.
   - For Excel output, open the workbook with `openpyxl` and verify headers and representative rows.
   - After generating or replacing i18n position codes, validate the affected message values with `scripts/validate_vue_i18n_messages.mjs` before running the page.
   - When a project needs local dev to fail fast, wire the validator into the project's existing `dev`, `check:ci`, or static-check entrypoint only after confirming the changed/generated key scope.
   - For code changes, run the project's existing test/build/lint command when available.

Generated Excel workbooks, intermediate key lists/maps, scanner reports, and files under `tempdocs/` are local delivery evidence by default. Do not stage, commit, or include them in an MR unless the user explicitly requests that exact artifact and the repository contract requires it. Locale source-code changes remain normal implementation files.

Any file named `zh-CN.json`, in any directory, is a local integration artifact for this workflow. It may be generated or updated for local verification, but must never be staged, committed, pushed, or included in an MR diff. This rule does not exclude other verified locale source files required by the implementation.

## Output Standards

For the optimized hardcode scanner Excel format, use the batch import template header:

```text
多端类型 | 位置编码 | 页面ID | 原文 | cn_text | en_text | fr_text | de_text | es_text | ja_text | pt_text
```

Rules:

- Use sheet name `硬编码扫描结果` when generating batch-import xlsx files.
- Use `templates/多语言模板-后台导入.xlsx` as the default batch-import workbook template.
- Keep the required template columns above unless the user explicitly asks for a different platform template.
- Preserve the template header and data-row styles instead of rebuilding workbook styling by hand.
- Put the English translation in both `原文` and `en_text`.
- Put the Chinese source text in `cn_text`.
- Leave `fr_text`, `de_text`, `es_text`, `ja_text`, and `pt_text` blank unless a translation source is explicitly provided.
- Do not write Chinese text into `原文` or `en_text`. If no English translation source is available, fail generation unless the user explicitly allows blanks.
- Normalize position codes to uppercase.
- Keep terminal input case-compatible, but generate position-code prefixes with `terminal_name.upper()`.
- For Apex admin projects, prefer `export const TERMINALNAME = "APEX"` in `src/locale/index.js`.
- For Apex-style generated position codes, prefer the existing nearby page prefix when present and generate codes as `<TERMINAL><PAGE_ID><NNNN>`, for example `APEXFIGP0013`.
- The numeric suffix `NNNN` must be zero-padded to 4 digits and assigned in ascending order. Before choosing a new suffix, scan the repository for the same `<TERMINAL><PAGE_ID>` prefix, extract existing numeric suffixes, and use the next available number after the current maximum.
- When generating multiple new codes for the same prefix in one pass, assign suffixes in source order from small to large.
- Treat same original text in different files or different lines as separate i18n keys.
- Do not reuse a position code only because the text is identical; generate a distinct position code for each UI position or source occurrence that needs an i18n key.
- Never export HTML, XML, or SVG markup as an original-text value. Any candidate matching an HTML-like tag such as `/<\/?[A-Za-z][^>]*>/` must not be written to the batch-import workbook.
- Keep markup and attributes in source code. Extract only the user-visible text fragments inside the markup and replace those fragments with independent `t()`/`$t()` position codes.
- If a scanner cannot safely separate visible text from markup, skip that candidate and report it for manual review instead of assigning a position code.
- Before exporting the workbook, validate the entire `原文` column and fail generation when any HTML-like tag remains.
- Before publishing or running local dev, validate Vue I18n message syntax for every newly generated key. Vue I18n may log compilation errors without throwing during rendering, so do not rely on the browser page alone to catch bad language-package values.
- Use `--legacy-format` to preserve old columns when existing users still depend on them.

## Vue I18n Message Syntax Guard

Vue I18n treats some punctuation as message syntax, not plain text. Generated position-code values must be checked before they enter a local JSON file, CDN language package, or batch-import workbook.

High-risk patterns:

- Bare `@`, `@:key`, and `@.modifier:key`: linked-message syntax. Plain text such as `test@example.com` or `!@#$%^&*` must be escaped or parameterized.
- `{...}`: list or named interpolation. Plain braces must be escaped; real placeholders must have matching `t()`/`$t()` params at call sites.
- `|`: choice/plural separator. Plain vertical bars must be escaped or the message may render only one segment.
- HTML-like tags such as `<br/>`, `<span>`, `<b>`: Vue I18n warns and `v-html` can create an XSS boundary. Prefer markup in Vue templates or CSS `white-space` for line breaks.

Safe patterns:

```text
包含特殊字符（如 !{'@'}#$%^&*）
符号 {'{'}
符号 {'}'}
符号 {'|'}
```

Prefer parameters when the symbol/example is data rather than copy text:

```js
t('APEXXOS60007', ['!@#$%^&*'])
```

```text
包含特殊字符（如 {0}）
```

Validation commands:

```bash
# Validate newly generated keys that already exist in src/locale/zh-CN.json.
node "${DELIVERY_SKILLS_ROOT:-${CODEX_HOME:-$HOME/.codex}/skills}/hardcode-i18n-scanner/scripts/validate_vue_i18n_messages.mjs" \
  --project-root . \
  --locale src/locale/zh-CN.json \
  --keys-file tempdocs/i18n-generated-keys.txt \
  --strict-placeholders

# Validate one raw message before it is imported to the language platform/CDN.
node "${DELIVERY_SKILLS_ROOT:-${CODEX_HOME:-$HOME/.codex}/skills}/hardcode-i18n-scanner/scripts/validate_vue_i18n_messages.mjs" \
  --project-root . \
  --message "包含特殊字符（如 !@#$%^&*）"
```

Local dev awareness:

- Vue I18n render-time compilation often logs errors/warnings and returns fallback text instead of throwing. To make local dev fail, run the validator before `npm run dev` or from the project's static-check script.
- For existing projects with historical HTML or placeholder messages, validate only the generated/changed keys first. Do a full-package audit separately and report existing failures instead of blocking unrelated work.
- If the runtime value comes from a remote/CDN language package and is not present in local JSON, validate the imported workbook row or fetched JSON value directly with `--message`, or sync the remote package locally before validation.

## Locale Key Export

Use the bundled script to export selected locale keys from a project:

```bash
python3 "${DELIVERY_SKILLS_ROOT:-${CODEX_HOME:-$HOME/.codex}/skills}/hardcode-i18n-scanner/scripts/export_locale_keys_to_xlsx.py" \
  --project-root . \
  --keys APEXM501B0D4,APEXS7O62196 \
  -o tempdocs/locale-keys-export.xlsx
```

Use `--keys-file` for newline or comma separated key lists. The script reads `src/locale/zh-CN.json` by default and infers `TERMINALNAME` from `src/locale/index.js` unless `--terminal` is provided.

For the current batch-import template, provide English translations with either an English locale JSON or a small mapping JSON:

```bash
python3 "${DELIVERY_SKILLS_ROOT:-${CODEX_HOME:-$HOME/.codex}/skills}/hardcode-i18n-scanner/scripts/export_locale_keys_to_xlsx.py" \
  --project-root . \
  --keys APEXM501B0D4,APEXS7O62196 \
  --english-map tempdocs/i18n-english-map.json \
  -o tempdocs/locale-keys-export.xlsx
```

The `--english-map` file supports either `位置编码 -> English` or `中文原文 -> English`. Use `--english-locale src/locale/en.json` when a project already has a local English package. Use `--legacy-format` only when an existing consumer still needs the old four-column output.

## Safety Notes

- Do not expose API keys, tokens, internal credentials, or private URLs in reports.
- Do not hardcode absolute local paths into project files.
- Do not claim a scanner path exists until verified with `rg`, `find`, or direct file reads.
