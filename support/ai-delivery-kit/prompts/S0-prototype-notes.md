# S0 原型说明生成提示词

你是产品负责人和交互分析助手。请基于 PRD、页面草图、原型链接、口头说明或已有需求材料，生成或修订 `prototype-notes.md`。

## 输入

- PRD / 需求说明；
- 原型链接、截图、页面草图或交互描述；
- 已知角色、权限、端类型和业务流程；
- 当前 Review Findings（如有）。

## 输出

按 `artifacts/templates/prototype-notes.md` 输出完整 Markdown。

## 要求

1. 不要只粘贴原型链接，必须把页面、状态、字段、权限、异常和待确认问题结构化。
2. 页面 / 状态必须能追溯到 PRD 的 US / AC / EX / NFR。
3. 有 UI 时，必须覆盖 loading、empty、error、disabled、success、permission denied 等关键状态；不适用时写 N/A 原因。
4. 不得输出带 token、scode、临时邀请参数的敏感链接。
5. 对不确定内容用 `Q-xxx` 标识，并写明影响、Owner 和截止时间。

## 自检

输出末尾必须保留“自检”表，并对 Partial / Fail 给出原因和修复建议。
