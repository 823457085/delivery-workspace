import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRenderer, nextTick } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { useJiraFix } from '../src/features/jira-fix/useJiraFix.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';

const renderer = createRenderer<object, object>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
});
const failed: JiraFixRecord = {
  id: randomUUID(), status: 'failed', workspacePath: '', headSha: '', runId: '', error: 'SSH connection timed out', createdAt: new Date().toISOString(),
  input: { issueKey: 'TEST-123', repository: 'git@example.test:team/repo.git', parentDirectory: '/tmp', baseBranch: 'test', branch: 'feature/TEST-123', notes: '原记录', rememberProject: true },
};
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('重试沿用原记录、生成新请求，重复点击只提交一次；表单修改不打断等待，成功只跳转一次', async t => {
  let records = [structuredClone(failed)];
  const posts: { requestId: string; input: JiraFixRecord['input']; authorization: string }[] = [];
  let release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return response({ records });
  });
  let state!: ReturnType<typeof useJiraFix>;
  const opened: string[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const app = renderer.createApp({ setup() { state = useJiraFix(id => opened.push(id)); return () => null; } });
  app.use(VueQueryPlugin, { queryClient: client }); app.mount({});
  try {
    await state.query.refetch();
    state.form.value.issueKey = 'TEST-999';
    const pending = state.retry(records[0]!);
    await state.retry(records[0]!);
    assert.equal(posts.length, 1);
    assert.notEqual(posts[0]!.requestId, failed.id);
    assert.deepEqual(posts[0]!.input, failed.input);
    assert.equal(posts[0]!.authorization, 'clone-and-fix-jira');
    assert.equal(state.retryingId.value, failed.id);
    assert.equal(state.busy.value, true);
    state.form.value.notes = '另一个草稿';
    const preparing = { ...failed, id: posts[0]!.requestId, status: 'preparing' as const, error: '' };
    records = [preparing, structuredClone(failed)];
    release(response(preparing)); await pending;
    assert.equal(state.busy.value, true);
    await state.retry(failed);
    assert.equal(posts.length, 1);
    assert.deepEqual(opened, []);
    records[0] = { ...preparing, status: 'started', runId: 'new-run', runStatus: 'running' };
    await state.query.refetch(); await nextTick();
    assert.deepEqual(opened, ['new-run']);
    assert.equal(state.busy.value, false);
    assert.equal(state.retryingId.value, '');
    assert.equal(state.form.value.issueKey, 'TEST-999');
    assert.equal(state.form.value.notes, '另一个草稿');
    assert.deepEqual(records[1], failed);

    // 轮询比 POST 响应先确认成功时，迟到的响应不能再次打开会话。
    const late = state.retry(failed);
    const started = { ...preparing, id: posts[1]!.requestId, status: 'started' as const, runId: 'second-run' };
    records = [started, structuredClone(failed)];
    await state.query.refetch(); await nextTick();
    assert.deepEqual(opened, ['new-run', 'second-run']);
    release(response(started)); await late;
    assert.deepEqual(opened, ['new-run', 'second-run']);

    const rejected = state.retry(failed);
    const nextFailure = { ...failed, id: posts[2]!.requestId };
    records = [nextFailure, structuredClone(failed)];
    release(response(nextFailure)); await rejected;
    assert.equal(state.busy.value, false);
    assert.equal(state.retryingId.value, '');
    await state.retry({ ...failed, status: 'uncertain' });
    await state.retry({ ...failed, runId: 'existing-run' });
    assert.equal(posts.length, 3);
  } finally { app.unmount(); client.clear(); }
});
