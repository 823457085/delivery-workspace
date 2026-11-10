# 三端适配与命令

所有相对业务路径均以本次任务的独立工作区为根。以下文件是常见实现线索，不是固定个人路径或跨仓库覆盖规则。

本参考仅在任务开启多语言位置编码，或未提供开关且按主技能的旧任务默认适用时使用。显式 `useI18n: false` / “使用多语言位置编码：关闭”时，不执行下方位置码分配与专用导表流程；保留已有 i18n 运行、调用和 key，接口展示文案原样显示。

| 目标端 | 应核对的机制 | 常见本地语言文件 |
| --- | --- | --- |
| Apex / `APEX` | `src/locale/index.js`，远端 `apex-${locale}.json`；本地与远端合并顺序 | `src/locale/zh-CN.json`、`en.json` |
| App / `APP` | `src/locale/index.js`，远端 `app-${locale}.json`；已有缓存与默认语言 | `src/locale/base-en.json`；不假定存在中文包 |
| PC / `PC` | `src/locale/index.js`，远端 `pc-${locale}.json`；多份英文包的覆盖顺序 | `src/locale/base-en.json`、`en.json`；不假定存在中文包 |

新增位置码沿用页面业务前缀和四位递增序号，如 `APEXODDT0001`、`APPPAR0001`、`PCQGWP0001`。已有哈希码保持不动。不要只依据编码后缀猜测存量 key 的页面 ID；导出存量非标准编码时核对原页面元数据并显式传入 `--page-id`，必要时分页面导出。

## 使用随包工具

工具位于本 Skill 的 `scripts/`，模板位于 `templates/`。先把下方 `<本技能目录>` 替换为实际已加载的插件 Skill 目录，不能硬编码作者机器路径或依赖用户个人 Skills。复用可用的 Node 和 Python 运行环境；Excel 导出需要 Python 3 和 `openpyxl`。缺少时优先使用 Codex 提供的文档运行环境，或在本机独立虚拟环境补齐，不更改业务项目依赖。消息验证使用目标项目已经安装的 `vue-i18n`。

先将本次 key 一行一个写入任务目录中的清单，再校验实际需要检查的本地包。以下路径是示例，应按已核对的目标项目替换：

```sh
node "<本技能目录>/scripts/validate_vue_i18n_messages.mjs" \
  --project-root "<任务独立工作区>" \
  --locale "src/locale/base-en.json" \
  --keys-file "tempdocs/i18n-generated-keys.txt"
```

只有语言包约定每份都含这些 key 时才一并传入多份 `--locale`；采用分片合并的语言包分别传各自 key 清单。已有合法插值仍需检查调用参数，不能因为使用 `{name}` 就改写业务句子。不要用 `--all` 把历史问题混入本次结果。

## 本次词条导出

使用随包空白模板，工作表为 `硬编码扫描结果`，所有导出统一为以下 15 列，表头名称和顺序不得改动：

```text
多端类型 | 位置编码 | 页面ID | 原文 | 中文 | 英语 | 法语 | 德语 | 西班牙语 | 日文 | 葡萄牙文 | 繁体中文-台湾 | 繁体中文-香港 | 意大利语 | 捷克语
```

- 只传入本次新增或修改的 key，不全量导出语言包。
- 文件名使用当前绑定的前端任务编号，保存为 `tempdocs/<任务编号>-多语言.xlsx`，例如 `tempdocs/OPAY-797-多语言.xlsx`；下方命令中的占位符替换为该真实编号。
- 中文来源使用实际中文包，或在 `tempdocs/` 中创建仅含本次词条的 `key -> 中文原文` JSON；App/PC 不因导出需要而改变应用语言配置。
- 英文来源优先读取实际基础包，也可提供本次已经核对的英文映射。英文同时填写“原文”和“英语”，中文填写“中文”。法、德、西、日、葡语、繁体中文（台湾、香港）、意大利语、捷克语没有来源就留空；已有来源时在输出中补齐并复核。
- 模板仅保留表头与空白数据行样式，不携带示例端类型、位置码或文案；不再提供旧四列导出格式。
- 端名称从目标配置读取，或依据代码显式传入 `--terminal APEX` / `APP` / `PC`。页面 ID 以真实业务前缀或元数据为准，不固定截取四个字符。
- 不允许把 HTML、XML、SVG 标签当原文；文本即使以 `=` 开头也必须保留为文字。
- 缺 key、缺英文或端无法确定时修复输入，不能将空行或错误端导出为成功。只有用户明确允许时才使用 `--allow-missing-english`，并在交接中列出缺失项。

```sh
python3 "<本技能目录>/scripts/export_locale_keys_to_xlsx.py" \
  --project-root "<任务独立工作区>" \
  --terminal APP \
  --locale "tempdocs/i18n-source-zh.json" \
  --english-locale "src/locale/base-en.json" \
  --keys-file "tempdocs/i18n-generated-keys.txt" \
  --output "tempdocs/<任务编号>-多语言.xlsx"
```

完成后用可用的 Excel 读取库回读文件，核对 15 列表头及顺序、行数、终端、页面 ID 和每个 key 的中英文对应关系。表格默认只作本地交接，不自动上传多语言平台。
