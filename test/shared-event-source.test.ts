import test from 'node:test';
import assert from 'node:assert/strict';

test('同标签页与多订阅者共享单一聚合 SSE 连接，重启挂起时立即关闭物理连接并在恢复后重连', async () => {
  const created: MockEventSource[] = [];
  class MockEventSource {
    readonly url: string;
    closed = false;
    private readonly listeners = new Map<string, Set<(event: Event) => void>>();
    constructor(url: string) {
      this.url = url;
      created.push(this);
    }
    addEventListener(type: string, listener: (event: Event) => void) {
      let bucket = this.listeners.get(type);
      if (!bucket) { bucket = new Set(); this.listeners.set(type, bucket); }
      bucket.add(listener);
    }
    removeEventListener(type: string, listener: (event: Event) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    dispatch(type: string, event: Event) {
      for (const fn of this.listeners.get(type) || []) fn(event);
    }
    close() {
      this.closed = true;
    }
  }

  const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
  try {
    const mod = await import(`../src/shared/sse/sharedEventSource.ts?t=${Date.now()}`);
    const runSubA = mod.openSharedEventSource('/api/agent-runtimes/events?updates=summaries');
    const runSubB = mod.openSharedEventSource('/api/agent-runtimes/events?updates=summaries');
    const teamSub = mod.openSharedEventSource('/api/agent-runtimes/team-tasks/events');
    const workflowSub = mod.openSharedEventSource('/api/workflow/events');

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(created.length, 1, '4 个 SSE 订阅者应合并为唯一 1 条物理连接');
    assert.equal(created[0]!.url, '/api/workspace/events?agentRuns=summaries');

    const receivedRuns: string[] = [];
    const receivedTeam: string[] = [];
    runSubA.addEventListener('runs', event => receivedRuns.push(`A:${(event as MessageEvent<string>).data}`));
    runSubB.addEventListener('runs', event => receivedRuns.push(`B:${(event as MessageEvent<string>).data}`));
    teamSub.addEventListener('workflow.updated', event => receivedTeam.push((event as MessageEvent<string>).data));

    created[0]!.dispatch('open', new Event('open'));
    created[0]!.dispatch('envelope', new MessageEvent('envelope', {
      data: JSON.stringify({ url: '/api/agent-runtimes/events?updates=summaries', event: 'runs', data: '{"revision":7,"runs":[]}', id: '7' }),
    }));
    created[0]!.dispatch('envelope', new MessageEvent('envelope', {
      data: JSON.stringify({ url: '/api/agent-runtimes/team-tasks/events', event: 'workflow.updated', data: '{"taskId":"t1"}', id: '3' }),
    }));

    assert.deepEqual(receivedRuns, ['A:{"revision":7,"runs":[]}', 'B:{"revision":7,"runs":[]}']);
    assert.deepEqual(receivedTeam, ['{"taskId":"t1"}']);

    // 点击重启时立即释放物理 SSE 连接
    mod.suspendSharedEventSources(5000);
    assert.equal(created[0]!.closed, true, '重启挂起时立即关闭物理连接以释放浏览器连接槽位');
    assert.equal(created.length, 1);

    // 重启完成后立即恢复聚合连接
    mod.resumeSharedEventSources();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(created.length, 2, '恢复后自动重建唯一聚合连接');
    assert.equal(created[1]!.url, '/api/workspace/events?agentRuns=summaries');
    assert.equal(created[1]!.closed, false);

    runSubA.close();
    runSubB.close();
    teamSub.close();
    workflowSub.close();
    mod.suspendSharedEventSources(1000);
  } finally {
    (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  }
});
