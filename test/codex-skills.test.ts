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
