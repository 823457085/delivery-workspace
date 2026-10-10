# Hardcode Scanner Output Reference

## Purpose

Use this reference when modifying or reviewing hardcode-scanner output for frontend i18n work.

## Expected Excel Format

Default output:

```text
多端类型 | 位置编码 | 页面ID | 原文 | cn_text | en_text | fr_text | de_text | es_text | ja_text | pt_text
```

Legacy output, only behind `--legacy-format`:

```text
多端类型 | 位置编码 | 页面ID | 原文
```

## Required Rules

- Use the skill template `templates/多语言模板-后台导入.xlsx` by default.
- Use 11 columns by default: `多端类型`, `位置编码`, `页面ID`, `原文`, `cn_text`, `en_text`, `fr_text`, `de_text`, `es_text`, `ja_text`, `pt_text`.
- Remove `文件` and `代码行号` from the default output.
- Write the English translation into both `原文` and `en_text`.
- Write the Chinese source text into `cn_text`.
- Leave `fr_text`, `de_text`, `es_text`, `ja_text`, and `pt_text` blank unless a translation source exists.
- Fail default workbook generation when an English translation is missing, unless the caller explicitly opts into blanks.
- Force `位置编码` to uppercase.
- Prefer uppercase `页面ID` when the scanner derives it from the position code.
- Support terminal names case-insensitively: `APP`, `app`, and `App` should all generate uppercase position-code prefixes.
- Preserve old output with `--legacy-format` if the scanner already has external users.

## Apex Rules

For Apex admin projects:

- Read `TERMINALNAME` from `src/locale/index.js` when present.
- Prefer `export const TERMINALNAME = "APEX"`.
- Generate position codes like `APEXS5VI6848`, not mixed-case variants.
- Align generated keys with `zh-CN.json` and downstream multilingual import tables.

## Duplicate Text Rules

Same Chinese text does not mean same i18n key.

- Same text in different files: generate different keys.
- Same text in the same file on different lines: generate different keys.
- Same text multiple times on the same file line: reuse the same key.

The Apex-style key formula is:

```python
key = terminal.upper() + file_code_4 + content_hash_4
```

Where `file_code_4` is a stable 4-character Base36 code from the relative file path, and `content_hash_4` is a 4-character uppercase MD5 prefix from text plus line number.

## Markup Rules

- Never export a complete HTML, XML, or SVG fragment as `原文`.
- Keep tags and attributes in source code, and generate position codes only for the visible text fragments inside the markup.
- Skip and report candidates that cannot be split safely; do not assign them a position code automatically.
- Fail workbook validation when any `原文` cell matches an HTML-like tag such as `/<\/?[A-Za-z][^>]*>/`.

## Validation Checklist

- Verify default workbook header equals `["多端类型", "位置编码", "页面ID", "原文", "cn_text", "en_text", "fr_text", "de_text", "es_text", "ja_text", "pt_text"]`.
- Verify default workbook puts English text in both `原文` and `en_text`, and Chinese text in `cn_text`.
- Verify legacy workbook header equals `["多端类型", "位置编码", "页面ID", "原文"]`.
- Verify position codes are uppercase.
- Verify `TERMINALNAME = "app"` still outputs position codes beginning with `APP`.
- Verify Apex projects output position codes beginning with `APEX`.
- Verify the scanner still finds representative hardcoded Chinese strings.
- Verify the `原文` column contains no HTML-like tags.

## Useful Commands

Inspect likely files:

```bash
rg -n "scan_hardcode|write_to_excel|legacy-format|TERMINALNAME|position_code" .
```

Check an output workbook:

```bash
python3 - <<'PY'
import openpyxl
wb = openpyxl.load_workbook("tempdocs/hardcode.xlsx")
ws = wb.active
print([cell.value for cell in ws[1]])
for row in ws.iter_rows(min_row=2, max_row=5, values_only=True):
    print(row)
PY
```
