import assert from 'node:assert/strict';
import test from 'node:test';
import { readYunxiaoDeploymentLog } from '../server/yunxiao-deployment-log.js';

function fixture(content = '第一行\n') {
  const calls: string[] = [];
  const options = {
    run: { pipelineRunId: '42', steps: [{ jobId: '71' }, { jobId: '72' }] }, jobId: '71', start: 0,
    request: async (suffix: string): Promise<unknown> => { calls.push(suffix); return { content, last: 99, more: true }; },
    redact: (text: string) => text.split('secret-token').join('[凭据已隐藏]'),
  };
  return { calls, options };
}

test('云效读取绑定运行及任务的官方日志接口，按 UTF-8 字节偏移返回增量，不把 last 当作字节位置', async () => {
  const f = fixture();
  const first = await readYunxiaoDeploymentLog(f.options);
  assert.deepEqual(f.calls, ['/runs/42/job/71/log']);
  assert.deepEqual(first, { text: '第一行\n', nextOffset: Buffer.byteLength('第一行\n'), moreData: true });
  f.options.start = first.nextOffset;
  f.options.request = async suffix => { f.calls.push(suffix); return { content: '第一行\n第二行\n', last: 123, more: false }; };
  const second = await readYunxiaoDeploymentLog(f.options);
  assert.deepEqual(second, { text: '第二行\n', nextOffset: Buffer.byteLength('第一行\n第二行\n'), moreData: false });
  assert.equal(f.calls.every(path => !path.includes('?')), true);
});

test('读取前校验偏移、数字任务编号及任务归属，不请求任意任务或路径', async () => {
  const f = fixture();
  for (const start of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, start }), /非负整数/);
  }
  for (const jobId of ['99', '../71', '0', '71?token=x']) {
    await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, jobId }), /不正确|不属于/);
  }
  await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, run: { ...f.options.run, pipelineRunId: '../42' } }), /不正确/);
  assert.equal(f.calls.length, 0);
});

test('原始日志按文本保留，完整内容先脱敏后再截取，异常也不暴露凭据', async () => {
  const f = fixture('<script>raw</script> secret-token L000509\n');
  const result = await readYunxiaoDeploymentLog(f.options);
  assert.equal(result.text, '<script>raw</script> [凭据已隐藏] L000509\n');
  assert.equal(result.text.includes('secret-token'), false);
  // start 落在原始凭据区间也只能取得已脱敏后的文字。
  const offset = Buffer.byteLength('<script>raw</script> ');
  assert.equal((await readYunxiaoDeploymentLog({ ...f.options, start: offset })).text, '[凭据已隐藏] L000509\n');
  await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, request: async () => { throw new Error('bad secret-token'); } }), /bad \[凭据已隐藏\]/);
});

test('缺失或错误的原生日志字段不冒充成功，不向错误文案泄漏上游正文', async () => {
  const f = fixture();
  for (const value of [null, {}, { content: 1, last: 1, more: false }, { content: 'secret-token', more: false },
    { content: '', last: 1.5, more: true }, { content: '', last: 0, more: 'false' }]) {
    await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, request: async () => value }), /^Error: 云效未返回有效的任务日志$/);
  }
});

test('日志不增长可返回空增量，内容缩短、越界、UTF-8 中间偏移与超大日志保持偏移不变', async () => {
  const f = fixture('中文');
  assert.deepEqual(await readYunxiaoDeploymentLog({ ...f.options, start: 6 }), { text: '', nextOffset: 6, moreData: true });
  await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, start: 7 }), /从头读取/);
  await assert.rejects(readYunxiaoDeploymentLog({ ...f.options, start: 1 }), /文字边界/);
  const huge = fixture('x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(readYunxiaoDeploymentLog(huge.options), /超过 2 MB/);
  assert.equal(huge.options.start, 0);
});
