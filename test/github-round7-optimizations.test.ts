import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSingleHunkPatch, parseUnifiedDiffHunks } from '../shared/git-hunk-patch.js';
import { classifyCommitLaneCategory, planAtomicCommitLanes } from '../shared/git-commit-lanes.js';
import {
  buildDiffReviewCommentKey,
  formatDiffReviewBasketPrompt,
  groupDiffReviewCommentsByFile,
  removeDiffReviewComment,
  upsertDiffReviewComment,
} from '../shared/diff-review-basket.js';
import { executeProjectGitAction, readProjectDiff, readProjectGitSnapshot } from '../server/project-git.js';
import type { SourceBackend } from '../server/source-backend.js';

const exec = promisify(execFile);

test('Round 7 · Hunk 补丁解析器精确拆分多处 Hunk、保留无换行标记与 CRLF 并拦截不支持类型', () => {
  const multiPatch = [
    'diff --git a/src/billing.ts b/src/billing.ts',
    'index 1111111..2222222 100644',
    '--- a/src/billing.ts',
    '+++ b/src/billing.ts',
    '@@ -3,4 +3,5 @@ export function calcSubtotal()',
    '   const base = 100;',
    '-  return base;',
    '+  const discount = 10;',
    '+  return base - discount;',
    ' }',
    '@@ -28,3 +29,4 @@ export function logSummary()',
    '   const ok = true;',
    '+  console.debug("temp-debug");',
    '   return ok;',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  const parsed = parseUnifiedDiffHunks(multiPatch);
  assert.equal(parsed.canStageIndividualHunks, true);
  assert.equal(parsed.oldPath, 'src/billing.ts');
  assert.equal(parsed.newPath, 'src/billing.ts');
  assert.equal(parsed.hunks.length, 2);
  assert.equal(parsed.hunks[0]!.rangeLabel, '-3,4 +3,5');
  assert.equal(parsed.hunks[0]!.sectionHeading, 'export function calcSubtotal()');
  assert.equal(parsed.hunks[0]!.added, 2);
  assert.equal(parsed.hunks[0]!.removed, 1);
  assert.equal(parsed.hunks[1]!.added, 1);
  assert.equal(parsed.hunks[1]!.removed, 0);

  const hunk0Patch = buildSingleHunkPatch(parsed, 0);
  assert.ok(!hunk0Patch.includes('index 1111111..2222222'), '单块补丁必须剥离整文件 blob index 行');
  assert.ok(hunk0Patch.includes('--- a/src/billing.ts\n+++ b/src/billing.ts\n@@ -3,4 +3,5 @@'));
  assert.ok(!hunk0Patch.includes('temp-debug'), '第 0 块补丁不应混入第 1 块内容');

  const hunk1Patch = buildSingleHunkPatch(parsed, 1);
  assert.ok(hunk1Patch.includes('\\ No newline at end of file'));
  assert.ok(hunk1Patch.endsWith('\n'));

  // CRLF 内容行尾保留校验
  const crlfPatch = 'diff --git a/win.ts b/win.ts\n--- a/win.ts\n+++ b/win.ts\n@@ -1 +1 @@\n-old\r\n+new\r\n';
  const singleCrlf = buildSingleHunkPatch(crlfPatch, 0);
  assert.ok(singleCrlf.includes('-old\r\n+new\r\n'));

  // 未跟踪、新增文件、二进制文件与越界序号安全拦截
  assert.equal(parseUnifiedDiffHunks('+line1\n+line2').canStageIndividualHunks, false);
  assert.equal(
    parseUnifiedDiffHunks('diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n')
      .canStageIndividualHunks,
    false,
  );
  assert.equal(parseUnifiedDiffHunks('Binary files a/a.png and b/a.png differ').canStageIndividualHunks, false);
  assert.throws(() => buildSingleHunkPatch(parsed, 9), /超出范围/);
});

test('Round 7 · 真实本地 Git 仓库：按 Hunk 独立暂存、取消暂存、丢弃单块及并发修订号防呆', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-round7-hunk-'));
  const repo = path.join(tempRoot, 'repo');
  const git = async (...args: string[]) => (await exec('git', ['-C', repo, ...args])).stdout;
  const source = { readLocalProjects: async () => ({ projects: [] }) } as unknown as SourceBackend;

  try {
    await fs.mkdir(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Round7 Tester');
    await git('config', 'user.email', 'round7@localhost');

    const baseLines = Array.from({ length: 20 }, (_, idx) => `line-${idx + 1}: baseline`);
    await fs.writeFile(path.join(repo, 'service.ts'), `${baseLines.join('\n')}\n`, 'utf8');
    await fs.writeFile(path.join(repo, 'tiny.txt'), 'alpha\n', 'utf8');
    await git('add', '.');
    await git('commit', '-qm', 'chore: initial baseline');

    // 在同一文件顶部与底部制造两处彼此独立的修改块
    const edited = [...baseLines];
    edited[1] = 'line-2: production bugfix';
    edited[18] = 'line-19: temporary console.log debug';
    await fs.writeFile(path.join(repo, 'service.ts'), `${edited.join('\n')}\n`, 'utf8');

    const initialDiff = await readProjectDiff(repo, 'service.ts', false);
    const initialParsed = parseUnifiedDiffHunks(initialDiff.patch);
    assert.equal(initialParsed.hunks.length, 2, '应包含顶底 2 处独立 Hunk');

    // 1. 仅暂存第 0 块（顶部 bugfix），底部 debug 留在工作区
    const snap1 = await readProjectGitSnapshot(repo);
    await executeProjectGitAction(
      {
        path: repo,
        revision: snap1.revision,
        action: 'stage-hunk',
        file: 'service.ts',
        hunkIndex: 0,
        hunkHeader: initialParsed.hunks[0]!.header,
      },
      source,
    );

    const snap2 = await readProjectGitSnapshot(repo);
    const serviceItem = snap2.files.find(f => f.path === 'service.ts');
    assert.ok(serviceItem?.staged && serviceItem.unstaged, 'service.ts 应同时存在已暂存块与未暂存块');

    const stagedDiff = await readProjectDiff(repo, 'service.ts', true);
    const unstagedDiff = await readProjectDiff(repo, 'service.ts', false);
    assert.match(stagedDiff.patch, /production bugfix/);
    assert.doesNotMatch(stagedDiff.patch, /temporary console\.log debug/);
    assert.match(unstagedDiff.patch, /temporary console\.log debug/);
    assert.doesNotMatch(unstagedDiff.patch, /production bugfix/);

    // 2. 安全防呆：缺少 confirmed 或 hunkHeader 过期时拒绝丢弃
    await assert.rejects(
      executeProjectGitAction(
        {
          path: repo,
          revision: snap2.revision,
          action: 'discard-hunk',
          file: 'service.ts',
          hunkIndex: 0,
        },
        source,
      ),
      /确认要丢弃/,
    );
    await assert.rejects(
      executeProjectGitAction(
        {
          path: repo,
          revision: snap2.revision,
          action: 'discard-hunk',
          file: 'service.ts',
          hunkIndex: 0,
          hunkHeader: '@@ -999,1 +999,1 @@ stale',
          confirmed: true,
        },
        source,
      ),
      /位置已变化/,
    );

    // 3. 丢弃工作区剩余的 debug Hunk，保留暂存区中的 bugfix Hunk
    const remainingUnstaged = parseUnifiedDiffHunks(unstagedDiff.patch);
    assert.equal(remainingUnstaged.hunks.length, 1);
    await executeProjectGitAction(
      {
        path: repo,
        revision: snap2.revision,
        action: 'discard-hunk',
        file: 'service.ts',
        hunkIndex: 0,
        hunkHeader: remainingUnstaged.hunks[0]!.header,
        confirmed: true,
      },
      source,
    );

    const snap3 = await readProjectGitSnapshot(repo);
    const afterDiscardItem = snap3.files.find(f => f.path === 'service.ts');
    assert.equal(afterDiscardItem?.staged, true);
    assert.equal(afterDiscardItem?.unstaged, false);
    const diskText = await fs.readFile(path.join(repo, 'service.ts'), 'utf8');
    assert.match(diskText, /production bugfix/);
    assert.doesNotMatch(diskText, /temporary console\.log debug/);

    // 4. 取消暂存已暂存的 Hunk，回到工作区未暂存状态
    const currentStagedParsed = parseUnifiedDiffHunks((await readProjectDiff(repo, 'service.ts', true)).patch);
    await executeProjectGitAction(
      {
        path: repo,
        revision: snap3.revision,
        action: 'unstage-hunk',
        file: 'service.ts',
        hunkIndex: 0,
        hunkHeader: currentStagedParsed.hunks[0]!.header,
      },
      source,
    );
    const snap4 = await readProjectGitSnapshot(repo);
    assert.equal(snap4.counts.staged, 0);
    assert.equal(snap4.files.find(f => f.path === 'service.ts')?.unstaged, true);

    // 5. 零上下文单行文件 (--unidiff-zero) 同样支持 Hunk 暂存与取消暂存
    await fs.writeFile(path.join(repo, 'tiny.txt'), 'beta\n', 'utf8');
    const snap5 = await readProjectGitSnapshot(repo);
    await executeProjectGitAction(
      { path: repo, revision: snap5.revision, action: 'stage-hunk', file: 'tiny.txt', hunkIndex: 0 },
      source,
    );
    const snap6 = await readProjectGitSnapshot(repo);
    assert.equal(snap6.files.find(f => f.path === 'tiny.txt')?.staged, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Round 7 · 虚拟原子提交泳道规划器按架构关注点聚类、生成规范标题并隔离敏感凭据文件', () => {
  assert.equal(classifyCommitLaneCategory('shared/git-hunk-patch.ts'), 'shared-contract');
  assert.equal(classifyCommitLaneCategory('server/project-git.ts'), 'backend-core');
  assert.equal(classifyCommitLaneCategory('src/features/project-inventory/ProjectGitDrawer.vue'), 'frontend-ui');
  assert.equal(classifyCommitLaneCategory('test/github-round7-optimizations.test.ts'), 'verification-tests');
  assert.equal(classifyCommitLaneCategory('README.md'), 'docs-config');

  const plan = planAtomicCommitLanes([
    { path: 'shared/git-hunk-patch.ts', status: '??', staged: false, unstaged: false, untracked: true },
    { path: 'server/project-git.ts', status: ' M', staged: false, unstaged: true, untracked: false },
    { path: 'src/features/project-inventory/ProjectGitDrawer.vue', status: 'M ', staged: true, unstaged: false, untracked: false },
    { path: 'test/github-round7-optimizations.test.ts', status: '??', staged: false, unstaged: false, untracked: true },
    { path: 'docs/guide.md', status: ' M', staged: false, unstaged: true, untracked: false },
    { path: '.env.local', status: '??', staged: false, unstaged: false, untracked: true },
    { path: 'certs/server.pem', status: '??', staged: false, unstaged: false, untracked: true },
  ]);

  assert.equal(plan.shouldSuggestSplit, true);
  assert.equal(plan.totalEligibleFiles, 5);
  assert.deepEqual(plan.excludedSensitiveFiles, ['.env.local', 'certs/server.pem']);
  assert.deepEqual(plan.lanes.map(lane => lane.id), [
    'shared-contract',
    'backend-core',
    'frontend-ui',
    'verification-tests',
    'docs-config',
  ]);

  const uiLane = plan.lanes.find(lane => lane.id === 'frontend-ui')!;
  assert.equal(uiLane.isExactStagedMatch, true, '当前仅暂存了前端文件，应识别为已独立暂存匹配');
  for (const lane of plan.lanes) {
    assert.ok(Array.from(lane.suggestedSubject).length <= 50, `标题超长：${lane.suggestedSubject}`);
    assert.match(lane.suggestedSubject, /^(?:feat|fix|refactor|test|docs|chore)(?:\([^)]+\))?: /);
  }
});

test('Round 7 · 行级代码审查批注篮支持跨文件聚合并输出脱敏后的结构化返修提示词', () => {
  const syntheticToken = `${'gh'}${'p_'}${'A9b8C7d6'.repeat(5)}`;
  let basket = upsertDiffReviewComment([], {
    file: './src/api/checkout.ts',
    line: 88,
    side: 'new',
    codeSnippet: 'const total = items.reduce((sum, i) => sum + i.price, 0);',
    comment: '需要对负数单价与 NaN 做防御兜底',
    severity: 'must_fix',
  });
  basket = upsertDiffReviewComment(basket, {
    file: 'src/api/checkout.ts',
    line: 24,
    side: 'old',
    codeSnippet: `const token = "${syntheticToken}";`,
    comment: `确认移除调试硬编码凭据 ${syntheticToken}`,
    severity: 'question',
  });
  basket = upsertDiffReviewComment(basket, {
    file: 'src/views/CartPanel.vue',
    line: 15,
    side: 'new',
    codeSnippet: '<el-button @click="submitOrder">提交</el-button>',
    comment: '提交期间补充 :loading 防止连点重复下单',
    severity: 'nit',
  });
  // 同一位置二次编辑应原地覆盖而非重复追加
  basket = upsertDiffReviewComment(basket, {
    file: 'src/api/checkout.ts',
    line: 88,
    side: 'new',
    codeSnippet: 'const total = items.reduce((sum, i) => sum + i.price, 0);',
    comment: '需要对负数单价、空数组与浮点精度做兜底',
    severity: 'must_fix',
  });

  assert.equal(basket.length, 3);
  const grouped = groupDiffReviewCommentsByFile(basket);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0]!.comments.map(item => item.line), [24, 88], '同文件内应按行号升序排列');

  const prompt = formatDiffReviewBasketPrompt(basket);
  assert.match(prompt, /共 3 处，涉及 2 个文件/);
  assert.match(prompt, /`@src\/api\/checkout\.ts:88`/);
  assert.match(prompt, /`@src\/views\/CartPanel\.vue:15`/);
  assert.match(prompt, /浮点精度/);
  assert.ok(!prompt.includes(syntheticToken), '输出给 Agent 的返修提示词必须脱敏高危凭据');

  const afterRemove = removeDiffReviewComment(basket, buildDiffReviewCommentKey('src/views/CartPanel.vue', 'new', 15));
  assert.equal(afterRemove.length, 2);
});
