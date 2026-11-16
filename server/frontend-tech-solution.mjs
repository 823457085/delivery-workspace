import { fileURLToPath } from 'node:url';

export const frontendTechSolutionSkill = fileURLToPath(new URL('../support/skills/frontend-tech-solution/SKILL.md', import.meta.url));
export const frontendTechSolutionPrompt = `编写或修订前端技术方案（含 S2a/G2a）时，唯一的生成与版式规则是 ${JSON.stringify(frontendTechSolutionSkill)}。按该技能读取团队模板最新版；仅在用户当次明确指定时改用指定模板。按实际栏目和顺序输出单篇 Markdown，已有方案仅提供核实后的内容，按当前模板重排后交付。在适用栏目内说明需求与验收映射、代码证据、契约、验证与风险。读取模板失败时如实说明并标记草案待核验。`;
