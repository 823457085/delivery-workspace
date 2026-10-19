/** 使用真实草稿与上传 composable、可控网络完成顺序验证归属；不访问实际附件接口。 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, shallowRef } from 'vue';
import { useAgentAttachments } from '../src/features/agent-workbench/useAgentAttachments.js';
import { useAgentConversationDrafts } from '../src/features/agent-workbench/useAgentConversationDrafts.js';
import type { AgentAttachment } from '../shared/agent-runtime.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const image = (id: string): AgentAttachment => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 3, url: `/attachments/${id}` });
const file = (id: string) => ({ name: `${id}.png`, size: 3, type: 'image/png' } as File);
const response = (value: unknown) => ({ ok: true, json: async () => value } as Response);

function fixture(t: TestContext, deferredRemoval = false) {
  const originalReader = globalThis.FileReader;
  globalThis.FileReader = class {
    result = 'data:image/png;base64,AAAA';
    onload?: () => void;
    readAsDataURL() { queueMicrotask(() => this.onload?.()); }
  } as unknown as typeof FileReader;
  t.after(() => { globalThis.FileReader = originalReader; });
  const uploads: ReturnType<typeof deferred<Response>>[] = [];
  const removals: { id: string; request: ReturnType<typeof deferred<Response>> }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    const request = deferred<Response>();
    if (path === '/api/agent-runtimes/attachments') uploads.push(request);
    else {
      const match = path.match(/^\/api\/agent-runtimes\/attachments\/([^/]+)\/delete$/);
      assert.ok(match, `Unexpected request: ${path}`);
      removals.push({ id: match[1], request });
      if (!deferredRemoval) request.resolve(response({ deleted: true }));
    }
    return request.promise;
  });
  const active = shallowRef('a');
  const drafts = useAgentConversationDrafts(active);
  const scope = effectScope();
  const editor = scope.run(() => useAgentAttachments(drafts.attachments, () => false, () => drafts.attachmentDraft.value))!;
  t.after(() => { drafts.dispose(); scope.stop(); });
  async function waitForUpload(count: number) {
    for (let attempt = 0; uploads.length < count && attempt < 10; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads.length, count);
  }
  return { active, drafts, editor, uploads, removals, scope, waitForUpload };
}

test('A、B 会话交错上传分别写回各自草稿，忙状态也按草稿隔离', async t => {
  const f = fixture(t);
  f.drafts.draft.value = 'A 草稿';
  const uploadA = f.editor.addFiles([file('a')]);
  await f.waitForUpload(1);
  assert.equal(f.editor.pending.value, true);
  f.active.value = 'b';
  f.drafts.draft.value = 'B 草稿';
  assert.equal(f.editor.pending.value, false);
  const uploadB = f.editor.addFiles([file('b')]);
  await f.waitForUpload(2);
  f.uploads[1].resolve(response(image('b')));
  await uploadB;
  assert.deepEqual(f.drafts.attachments.value, [image('b')]);
  f.uploads[0].resolve(response(image('a')));
  await uploadA;
  assert.deepEqual(f.drafts.attachments.value, [image('b')]);
  f.active.value = 'a';
  assert.equal(f.drafts.draft.value, 'A 草稿');
  assert.deepEqual(f.drafts.attachments.value, [image('a')]);
  assert.equal(f.editor.pending.value, false);
  assert.deepEqual(f.removals, []);
});

test('移除附件晚返回仍修改原会话，不影响后来选择的会话', async t => {
  const f = fixture(t, true);
  f.drafts.attachments.value = [image('a')];
  const removing = f.editor.remove(image('a'));
  assert.equal(f.editor.pending.value, true);
  f.active.value = 'b';
  f.drafts.attachments.value = [image('b')];
  assert.equal(f.editor.pending.value, false);
  f.removals[0].request.resolve(response({ deleted: true }));
  await removing;
  assert.deepEqual(f.drafts.attachments.value, [image('b')]);
  f.active.value = 'a';
  assert.deepEqual(f.drafts.attachments.value, []);
  assert.equal(f.editor.pending.value, false);
});

test('草稿清空后，晚返回的上传会被回收，不写入重新输入的同会话草稿', async t => {
  const f = fixture(t);
  const uploading = f.editor.addFiles([file('old')]);
  await f.waitForUpload(1);
  f.drafts.clear('a');
  f.drafts.draft.value = '清空后新输入';
  assert.equal(f.editor.pending.value, false);
  f.uploads[0].resolve(response(image('old')));
  await uploading;
  assert.equal(f.drafts.draft.value, '清空后新输入');
  assert.deepEqual(f.drafts.attachments.value, []);
  assert.deepEqual(f.removals.map(item => item.id), ['old']);
});

test('删除会话后上传晚返回不会复活草稿或污染当前会话', async t => {
  const f = fixture(t);
  f.drafts.draft.value = '将删除的会话';
  const uploading = f.editor.addFiles([file('deleted')]);
  await f.waitForUpload(1);
  f.active.value = 'b';
  f.drafts.draft.value = '保留 B';
  f.drafts.clear('a');
  f.uploads[0].resolve(response(image('deleted')));
  await uploading;
  assert.equal(f.drafts.draft.value, '保留 B');
  assert.deepEqual(f.drafts.attachments.value, []);
  f.active.value = 'a';
  assert.equal(f.drafts.draft.value, '');
  assert.deepEqual(f.drafts.attachments.value, []);
  assert.deepEqual(f.removals.map(item => item.id), ['deleted']);
});

test('会话 ID 迁移时上传跟随草稿，完成前目标会话仍不能发送', async t => {
  const f = fixture(t);
  f.drafts.draft.value = '原会话草稿';
  const uploading = f.editor.addFiles([file('migrated')]);
  await f.waitForUpload(1);
  f.drafts.move('a', 'canonical');
  f.active.value = 'canonical';
  assert.equal(f.editor.pending.value, true);
  f.uploads[0].resolve(response(image('migrated')));
  await uploading;
  assert.equal(f.drafts.draft.value, '原会话草稿');
  assert.deepEqual(f.drafts.attachments.value, [image('migrated')]);
  assert.equal(f.editor.pending.value, false);
});

test('两个存在异步操作的草稿合并后，忙计数等待所有操作完成', async t => {
  const f = fixture(t);
  const uploadA = f.editor.addFiles([file('a')]);
  await f.waitForUpload(1);
  f.active.value = 'b';
  const uploadB = f.editor.addFiles([file('b')]);
  await f.waitForUpload(2);
  f.drafts.move('a', 'b');
  f.uploads[0].resolve(response(image('a')));
  await uploadA;
  assert.equal(f.editor.pending.value, true);
  f.uploads[1].resolve(response(image('b')));
  await uploadB;
  assert.deepEqual(f.drafts.attachments.value, [image('a'), image('b')]);
  assert.equal(f.editor.pending.value, false);
});

test('页面卸载后回收未归属到运行的晚到上传，且不再恢复草稿', async t => {
  const f = fixture(t);
  const uploading = f.editor.addFiles([file('unmounted')]);
  await f.waitForUpload(1);
  f.drafts.dispose();
  f.scope.stop();
  f.uploads[0].resolve(response(image('unmounted')));
  await uploading;
  f.drafts.restore('a', { text: '晚到恢复', attachments: [image('unmounted')] });
  assert.equal(f.drafts.draft.value, '');
  assert.deepEqual(f.drafts.pendingAttachments(), []);
  assert.deepEqual(f.removals.map(item => item.id), ['unmounted']);
});
