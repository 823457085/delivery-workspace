import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCodexSkills, skillDisplayDescription } from '../server/codex-skills.js';

test('Apex Skill 候选使用中文说明', () => {
  assert.equal(
    skillDisplayDescription('apex-jira-feature-development', 'English description'),
    '从 Jira 需求开始实现或继续 Apex 前端开发，包含工作区、分支和验证流程。',
  );
  assert.equal(skillDisplayDescription('delivery-test-skill', 'English description'), 'English description');
});

test('Apex Skill 中文化后仍可按原英文说明搜索', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-localized-skill-test-'));
  const skillDirectory = path.join(workspace, '.agents', 'skills', 'hardcode-i18n-scanner');
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), `---
name: hardcode-i18n-scanner
description: Scan Apex hardcoded text and export locale keys.
---
`);
  try {
    const skills = await listCodexSkills(workspace, 'apex');
    const skill = skills.find((item) => item.invocation === 'hardcode-i18n-scanner');
    assert.equal(skill?.description, '扫描并改造前端硬编码中文与国际化问题，支持位置码规范化、校验和 Excel 导出。');
    assert.equal('searchDescription' in (skill || {}), false);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('Codex Skill 候选读取当前项目元数据并保留完整描述', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-skill-test-'));
  const skillDirectory = path.join(workspace, '.agents', 'skills', 'delivery-test-skill');
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.writeFile(path.join(skillDirectory, 'SKILL.md'), `---
name: delivery-test-skill
description: >
  Verify that project skills are discoverable
  from the unified mention picker.
---
`);
  try {
    const skills = await listCodexSkills(workspace, 'delivery-test-skill');
    assert.deepEqual(skills, [{
      name: 'delivery-test-skill',
      invocation: 'delivery-test-skill',
      description: 'Verify that project skills are discoverable from the unified mention picker.',
      source: 'project',
      sourceLabel: '当前项目',
    }]);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('附包 Skill 可从其他工作区发现，同名 Skill 保留当前项目版本', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-bundled-skills-'));
  const workspace = path.join(directory, 'workspace');
  const bundled = path.join(directory, 'bundled');
  const previous = process.env.DELIVERY_SKILLS_ROOT;
  try {
    for (const [base, name, description] of [
      [path.join(workspace, '.agents/skills'), 'delivery-scoped-skill', 'Project-owned version'],
      [bundled, 'delivery-scoped-skill', 'Bundled version'],
      [bundled, 'delivery-bundled-only', 'Available from the workbench bundle'],
    ]) {
      const target = path.join(base, name);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    process.env.DELIVERY_SKILLS_ROOT = path.relative(process.cwd(), bundled);
    const skills = await listCodexSkills(workspace, 'delivery-');
    const projectSkill = skills.find(item => item.name === 'delivery-scoped-skill');
    assert.equal(projectSkill?.description, 'Project-owned version');
    assert.equal(projectSkill?.sourceLabel, '当前项目');
    assert.equal(skills.filter(item => item.name === 'delivery-scoped-skill').length, 1);
    assert.equal(skills.find(item => item.name === 'delivery-bundled-only')?.sourceLabel, '工作台配套 Skill');
  } finally {
    if (previous === undefined) delete process.env.DELIVERY_SKILLS_ROOT; else process.env.DELIVERY_SKILLS_ROOT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
