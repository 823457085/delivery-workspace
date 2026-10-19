import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRenderer, nextTick, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { RequirementDevelopmentRecord } from '../shared/requirement-development.js';
import { useRequirementDevelopmentRetry } from '../src/features/requirement-development/useRequirementDevelopmentRetry.js';

const renderer = createRenderer<object, object>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
  parentNode: () => null, nextSibling: () => null,
});
const failed: RequirementDevelopmentRecord = {
  id: randomUUID(), status: 'failed', workspacePath: '/tmp/original-failed-directory', headSha: '', runId: '',
  error: '克隆仓库失败', createdAt: '2026-10-15T00:00:00Z',
  input: { title: '原需求', issueKey: 'APEX-123', prdUrl: '', requirement: '', project: '', fixVersion: '', assignee: '',
    startDate: '2026-10-15', endDate: '2026-10-16', repository: 'git@example.test:team/repo.git', parentDirectory: '/tmp',
    branch: 'feature/APEX-123', confluenceParentUrl: '' },
};
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
test.beforeEach(t => { if ('mock' in t) t.mock.method(ElMessage, 'error', () => ({ close() {} })); });

function mountRetry(read?: () => Promise<RequirementDevelopmentRecord[]>) {
  const records = shallowRef<RequirementDevelopmentRecord[]>([structuredClone(failed)]);
  const blocked = shallowRef(false);
  const opened: string[] = [];
  async function refresh() {
    try {
      if (read) records.value = await read();
      blocked.value = false;
      return { data: records.value };
    } catch (error) { blocked.value = true; throw error; }
  }
  let state!: ReturnType<typeof useRequirementDevelopmentRetry>;
  const app = renderer.createApp({ setup() {
    state = useRequirementDevelopmentRetry({ records, blocked: () => blocked.value,
      refresh, openRun: id => opened.push(id) });
    return () => null;
  } });
  app.mount({});
  return { app, state, records, blocked, opened, refresh };
}

test('需求重试使用原输入和新请求，准备期间锁住重复点击，保留旧记录与目录', async t => {
  const posts: { requestId: string; input: RequirementDevelopmentRecord['input']; authorization: string }[] = [];
  let release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const { app, state, records, opened } = mountRetry();
  try {
    const pending = state.retry(records.value[0]!);
    await state.retry(records.value[0]!);
    assert.equal(posts.length, 1);
    assert.notEqual(posts[0]!.requestId, failed.id);
    assert.deepEqual(posts[0]!.input, failed.input);
    assert.equal(posts[0]!.authorization, 'create-jira-design-transition-and-develop');
    assert.equal(state.retryingId.value, failed.id);
    assert.equal(state.busy.value, true);

    const preparing = { ...failed, id: posts[0]!.requestId, status: 'preparing' as const, error: '', workspacePath: '' };
    records.value = [preparing, records.value[0]!];
    release(response(preparing)); await pending;
    await state.retry(failed);
    assert.equal(posts.length, 1);
    assert.equal(state.busy.value, true);
    assert.deepEqual(opened, []);

    records.value = [{ ...preparing, status: 'started', runId: 'new-run', workspacePath: '/tmp/new-attempt' }, records.value[1]!];
    await nextTick();
    assert.deepEqual(opened, ['new-run']);
    assert.equal(state.busy.value, false);
    assert.equal(state.retryingId.value, '');
    assert.deepEqual(records.value[1], failed);
  } finally { app.unmount(); }
});

test('轮询先取得启动结果时迟到的 POST 不重复打开会话', async t => {
  let postedId = '', release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    postedId = JSON.parse(String(init?.body)).requestId;
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const { app, state, records, opened } = mountRetry();
  try {
    const pending = state.retry(failed);
    const started = { ...failed, id: postedId, status: 'started' as const, runId: 'new-run', error: '' };
    records.value = [started, failed];
    await nextTick();
    assert.deepEqual(opened, ['new-run']);
    release(response(started)); await pending;
    assert.deepEqual(opened, ['new-run']);
  } finally { app.unmount(); }
});

test('不确定、已创建会话、非失败或其他操作忙碌时不发起需求重试', async t => {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async () => { posts++; return response(failed); });
  const { app, state, records, blocked } = mountRetry();
  try {
    for (const record of [{ ...failed, status: 'uncertain' as const }, { ...failed, runId: 'existing-run' },
      { ...failed, status: 'preparing' as const }, { ...failed, status: 'started' as const }]) {
      records.value = [record];
      await state.retry(failed); // 旧按钮引用也必须遵守刷新后的状态。
    }
    records.value = [failed]; blocked.value = true;
    await state.retry(failed);
    assert.equal(posts, 0);
    assert.equal(state.busy.value, false);
  } finally { app.unmount(); }
});

test('新尝试失败后可再次重试，但服务返回 uncertain 时只核对该记录', async t => {
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const id = JSON.parse(String(init?.body)).requestId; ids.push(id);
    return response({ ...failed, id, status: ids.length === 1 ? 'failed' : 'uncertain' });
  });
  const { app, state, records, opened } = mountRetry();
  try {
    await state.retry(failed);
    assert.equal(state.busy.value, false);
    const nextFailure = { ...failed, id: ids[0]! };
    records.value = [nextFailure, failed];
    await state.retry(nextFailure);
    assert.equal(state.busy.value, true);
    assert.equal(new Set([...ids, failed.id]).size, 3);
    const uncertain = { ...failed, id: ids[1]!, status: 'uncertain' as const };
    records.value = [uncertain, nextFailure, failed];
    await state.retry(uncertain);
    await state.retry(failed);
    assert.equal(ids.length, 2);
    assert.deepEqual(opened, []);
  } finally { app.unmount(); }
});

async function readRecords() {
  const result = await fetch('/api/agent-runtimes/requirement-development');
  if (!result.ok) throw new Error('启动记录读取失败');
  return (await result.json() as { records: RequirementDevelopmentRecord[] }).records;
}

test('POST 响应丢失后按原 ID 回读，preparing 时不产生新 POST', async t => {
  const ids: string[] = [];
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      ids.push(JSON.parse(String(init.body)).requestId);
      throw new Error('POST 响应丢失');
    }
    reads++;
    return response({ records: [{ ...failed, id: ids[0], status: 'preparing', error: '' }, failed] });
  });
  const { app, state, refresh, opened } = mountRetry(readRecords);
  try {
    await state.retry(failed);
    assert.equal(reads, 1);
    assert.equal(state.busy.value, true);
    assert.equal(state.retryingId.value, failed.id);
    await state.retry(failed);
    await refresh(); await nextTick();
    await state.retry(failed);
    assert.equal(ids.length, 1);
    assert.deepEqual(opened, []);
  } finally { app.unmount(); }
});

test('POST 响应丢失后回读到 started，仅打开一次开发会话', async t => {
  let requestId = '', posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; requestId = JSON.parse(String(init.body)).requestId;
      throw new Error('POST 响应丢失');
    }
    return response({ records: [{ ...failed, id: requestId, status: 'started', runId: 'accepted-run', error: '' }, failed] });
  });
  const { app, state, refresh, opened } = mountRetry(readRecords);
  try {
    await state.retry(failed);
    await refresh(); await nextTick();
    await refresh(); await nextTick();
    assert.equal(posts, 1);
    assert.equal(state.busy.value, false);
    assert.deepEqual(opened, ['accepted-run']);
  } finally { app.unmount(); }
});

test('POST 响应丢失后回读确认 failed，下一次重试才生成新 ID', async t => {
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const id = JSON.parse(String(init.body)).requestId; ids.push(id);
      if (ids.length === 1) throw new Error('POST 响应丢失');
      return response({ ...failed, id });
    }
    return response({ records: ids.map(id => ({ ...failed, id })).concat(failed) });
  });
  const { app, state, records, opened } = mountRetry(readRecords);
  try {
    await state.retry(failed);
    assert.equal(state.busy.value, false);
    await state.retry(failed);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(state.busy.value, false);
    assert.deepEqual(records.value.at(-1), failed);
    assert.deepEqual(opened, []);
  } finally { app.unmount(); }
});

test('POST 与回读均失败时保留待核对尝试，后续刷新恢复到同一 ID', async t => {
  let requestId = '', posts = 0, reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; requestId = JSON.parse(String(init.body)).requestId;
      throw new Error('POST 响应丢失');
    }
    if (++reads === 1) throw new Error('GET 请求中断');
    return response({ records: [{ ...failed, id: requestId, status: 'started', runId: 'recovered-run', error: '' }, failed] });
  });
  const { app, state, refresh, opened } = mountRetry(readRecords);
  try {
    await assert.doesNotReject(state.retry(failed));
    assert.equal(state.busy.value, true);
    await state.retry(failed);
    assert.equal(posts, 1);
    await refresh(); await nextTick();
    assert.equal(state.busy.value, false);
    assert.deepEqual(opened, ['recovered-run']);
  } finally { app.unmount(); }
});

test('完整回读无该 ID 时可再次点击，但复用原请求 ID', async t => {
  const ids: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const id = JSON.parse(String(init.body)).requestId; ids.push(id);
      if (ids.length === 1) throw new Error('POST 响应丢失');
      return response({ ...failed, id, status: 'started', runId: 'same-request-run', error: '' });
    }
    return response({ records: [failed] });
  });
  const { app, state, opened } = mountRetry(readRecords);
  try {
    await state.retry(failed);
    assert.equal(state.busy.value, false);
    assert.equal(state.retryingId.value, '');
    await state.retry(failed);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.deepEqual(opened, ['same-request-run']);
  } finally { app.unmount(); }
});

test('回读失败后刷新成功但列表引用未变，仍允许复用原 ID 继续重试', async t => {
  const ids: string[] = [];
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    ids.push(JSON.parse(String(init?.body)).requestId);
    throw new Error('POST 响应丢失');
  });
  const fixture = mountRetry(async () => {
    if (++reads === 1) throw new Error('GET 请求中断');
    return fixture.records.value;
  });
  try {
    await fixture.state.retry(failed);
    assert.equal(fixture.state.busy.value, true);
    await fixture.refresh(); await nextTick();
    assert.equal(fixture.state.busy.value, false);
    await fixture.state.retry(failed);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  } finally { fixture.app.unmount(); }
});

test('待核对 ID 暂未出现后晚到 uncertain，刷新可重新锁住旧失败记录', async t => {
  let requestId = '', posts = 0, reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; requestId = JSON.parse(String(init.body)).requestId;
      throw new Error('POST 响应丢失');
    }
    return response({ records: ++reads === 1 ? [failed]
      : [{ ...failed, id: requestId, status: 'uncertain' }, failed] });
  });
  const { app, state, refresh } = mountRetry(readRecords);
  try {
    await state.retry(failed);
    assert.equal(state.busy.value, false);
    await refresh(); await nextTick();
    assert.equal(state.busy.value, true);
    await state.retry(failed);
    assert.equal(posts, 1);
  } finally { app.unmount(); }
});
