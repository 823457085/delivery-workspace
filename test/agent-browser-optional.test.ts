import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

test('缺少浏览器工具或初始化失败时，普通 Codex 轮次仍可完成且不注入失效通道', { timeout: 12000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-optional-'));
  const keys = ['DELIVERY_AGENT_BROWSER_BIN','DELIVERY_AGENT_BROWSER_CHROME_BIN','DELIVERY_AGENT_BROWSER_REUSE_CHROME'];
  const previous = keys.map(k => process.env[k]);
  t.after(async () => { keys.forEach((k,i) => { if(previous[i] === undefined)delete process.env[k];else process.env[k]=previous[i]; });await fs.rm(root,{recursive:true,force:true}); });
  const fixture = path.resolve('test/fixtures/codex-live-server.mjs');
  const sample: AgentRun = { id:'optional-browser', provider:'codex', mode:'ask', accessMode:'workspace',model:'',reasoningEffort:'',objective:'普通代码任务',workspacePath:root,branch:'',headSha:'',status:'running',sessionId:'',pid:null,result:'',error:'',events:[],createdAt:'',updatedAt:'' };
  for (const scenario of ['no-provider','missing-tool','invalid-root','endpoint-error']) {
    process.env.DELIVERY_AGENT_BROWSER_BIN = scenario === 'missing-tool' ? path.join(root,'missing-tool') : process.execPath;
    process.env.DELIVERY_AGENT_BROWSER_CHROME_BIN = process.execPath;
    process.env.DELIVERY_AGENT_BROWSER_REUSE_CHROME = scenario === 'endpoint-error' ? '1' : '0';
    const adapter = createCodexAdapter(fixture, scenario === 'invalid-root' ? path.join(root,'missing-root') : root, async () => { if(scenario === 'endpoint-error')throw new Error('private endpoint failure'); return scenario === 'no-provider' ? undefined : 'ws://127.0.0.1:43897/test-ticket'; });
    const events: string[] = [];
    const result = await adapter.execute({ run:sample, resumeSessionId:'11111111-1111-1111-1111-111111111111', imagePaths:[],fileAttachments:[],signal:new AbortController().signal,onPid(){},onSession(){},onEvent(_type,message){events.push(message);} });
    assert.ok(JSON.parse(result).requests.includes('turn/start'),scenario);
    assert.equal(events.some(message => message.includes('已配置任务浏览器通道')),false);
    assert.equal(events.some(message => message.includes('private endpoint failure')),false);
    if(scenario === 'endpoint-error' || scenario === 'invalid-root')assert.ok(events.some(message => message.includes('继续完成普通代码')),scenario);
  }
});
