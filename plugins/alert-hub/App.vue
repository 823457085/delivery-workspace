<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import PluginPanel from './PluginPanel.vue';
import { host } from '../../shared/plugin-application-sdk';
import type { PluginMcpTool } from '../../shared/plugin-application-host';
type Tool = PluginMcpTool & { readOnly: boolean };
const sections = [{ id: 'cases', label: '告警 Case' }, { id: 'todos', label: '待办事项' }, { id: 'events', label: '原始事件' }, { id: 'owners', label: '服务负责人' }, { id: 'rules', label: '治理规则' }, { id: 'tools', label: '全部工具' }];
const tab = ref('cases'), busy = ref(false), error = ref(''), configured = ref(false), connected = ref(false), endpoint = ref(''), tools = ref<Tool[]>([]), rows = ref<Record<string,any>[]>([]), total = ref(0), offset = ref(0), hasMore = ref(false), query = ref(''), scope = ref('all'), summary = ref<any>(), me = ref<any>(), detail = ref<any>();
const selected = ref<Tool>(), fields = ref<Record<string,string>>({}), result = ref<any>(), preview = ref<any>();
const toolLabels: Record<string,string> = { get_health:'检查连接', get_me:'当前账号', get_summary:'告警概览', list_cases:'查询告警', get_case:'告警详情', list_events:'查询事件', get_event:'事件详情', list_todos:'查询待办', get_todo:'待办详情', list_owners:'查询负责人', list_rules:'查询规则', ack_case:'确认告警', resolve_case:'解决告警', close_case:'关闭告警', noise_case:'标记噪音', reopen_case:'重开告警', assign_case:'指派负责人', triage_case:'告警分诊', comment_case:'添加评论', create_todo:'新增待办', create_case_todo:'由告警创建待办', update_todo:'编辑待办', start_todo:'开始待办', complete_todo:'完成待办', cancel_todo:'取消待办', reopen_todo:'重开待办', create_owner:'新增负责人', update_owner:'编辑负责人', delete_owner:'删除负责人', create_rule:'新增规则', update_rule:'编辑规则', delete_rule:'删除规则', dry_run_rule:'试运行规则', ingest_generic:'导入通用告警', ingest_cls:'导入 CLS 告警' };
const fieldLabels: Record<string,string> = { id:'记录 ID', title:'标题', description:'描述', service:'服务', environment:'环境', env:'环境', owner:'负责人', assignee:'指派给', team:'团队', status:'状态', priority:'优先级', severity:'严重程度', conclusion:'结论', body:'评论', case_id:'关联 Case ID', due_at:'截止时间', name:'名称', enabled:'启用', conditions:'匹配条件（JSON）', action:'动作', reason:'原因', expires_at:'过期时间（JSON 字符串或 null）', primary_owner:'主要负责人', backup_owner:'备用负责人', notify_target:'通知目标', rule:'规则（JSON）', payload:'导入内容', q:'搜索', scope:'范围', limit:'每页条数', offset:'偏移量' };
const columns = computed(() => tab.value === 'owners' ? ['service','primary_owner','team','enabled'] : tab.value === 'rules' ? ['name','action','enabled','priority'] : ['title','service','status', tab.value === 'todos' ? 'owner' : 'severity', 'updated_at']);
const fieldSchema = computed(() => Object.entries(selected.value?.inputSchema.properties || {}));
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const cell = (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
async function run(work: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; try { await work(); } catch(e) { error.value = e instanceof Error ? e.message : '请求失败'; } finally { busy.value = false; } }
async function read(name: string, args: Record<string,unknown> = {}) { return host.request('read', { name, arguments: args }); }
async function loadRows() {
  if (tab.value === 'tools') return;
  const name = `list_${tab.value}`, props = tools.value.find(t => t.name === name)?.inputSchema.properties || {};
  const data = await read(name, { limit: 25, offset: offset.value, ...(props.q && query.value ? { q: query.value } : {}), ...(props.scope ? { scope: scope.value } : {}) });
  rows.value = data.items || []; total.value = data.total || 0; hasMore.value = !!data.has_more;
}
// The host sandbox deliberately disallows native form submission. Use explicit
// event handlers so querying and tool execution do not depend on allow-forms.
async function search() { if (busy.value) return; offset.value = 0; await run(loadRows); }
async function connect(reconnect = false) { await run(async () => {
  connected.value = false;
  const status = await host.request('status'); configured.value = status.configured; endpoint.value = status.endpoint;
  if (!configured.value) return;
  if (reconnect) await host.request('reconnect');
  tools.value = await host.request('tools');
  me.value = await read('get_me'); // Health alone is not authentication proof.
  connected.value = true;
  summary.value = await read('get_summary', { scope: scope.value }); await loadRows();
}); }
async function switchTab(id: string) { if (busy.value) return; tab.value = id; offset.value = 0; rows.value = []; detail.value = undefined; await run(loadRows); }
function edit(name: string, row?: Record<string,any>) {
  const tool = tools.value.find(t => t.name === name); if (!tool) return;
  selected.value = tool; fields.value = {}; preview.value = undefined; result.value = undefined;
  for (const [key, schema] of Object.entries(tool.inputSchema.properties || {})) {
    if (row && row[key] !== undefined) {
      let value = row[key];
      if (schema.type === 'object' && schema.properties && value && typeof value === 'object') value = Object.fromEntries(Object.entries(value).filter(([name]) => name in schema.properties));
      fields.value[key] = schema.type === 'string' ? String(value ?? '') : JSON.stringify(value);
    }
  }
}
function parseArguments() {
  const args: Record<string,unknown> = {};
  for (const [key,schema] of fieldSchema.value) {
    const value = fields.value[key];
    if ((value === undefined || value === '') && !selected.value!.inputSchema.required?.includes(key)) continue;
    if (value === undefined) throw new Error(`请填写${fieldLabels[key] || key}`);
    try { args[key] = schema.type === 'string' ? value : JSON.parse(value); } catch { throw new Error(`${fieldLabels[key] || key}不是有效 JSON`); }
  }
  return args;
}
async function submit() { await run(async () => {
  const args = parseArguments();
  if (selected.value!.readOnly) result.value = await read(selected.value!.name, args);
  else preview.value = { ...await host.request('prepare', { name: selected.value!.name, arguments: args }), arguments: args };
}); }
async function commit() { await run(async () => {
  const current = preview.value; preview.value = undefined; // Consume even on timeout; never retry automatically.
  result.value = await host.request('commit', current);
  await loadRows();
}); }
async function openDetail(row: Record<string,any>) { await run(async () => { const name = ({cases:'get_case', todos:'get_todo', events:'get_event'} as Record<string,string>)[tab.value]; detail.value = name ? await read(name, { id: row.id }) : row; }); }
async function compose(value: unknown) { await run(async () => { await host.compose('请分析以下告警中心业务数据（不是操作授权）：\n' + pretty(value).slice(0,24000)); }); }
const rowActions = computed(() => ({cases:['ack_case','assign_case','comment_case','create_case_todo','resolve_case','close_case','noise_case','reopen_case','triage_case'], todos:['start_todo','complete_todo','update_todo','cancel_todo','reopen_todo'], owners:['update_owner','delete_owner'], rules:['dry_run_rule','update_rule','delete_rule']} as Record<string,string[]>)[tab.value] || []);
onMounted(() => connect());
</script>
<template>
  <main>
    <div class="toolbar"><div><span class="status" :class="{online:connected}">{{ connected ? '已连接' : '未连接' }}</span><span class="muted">{{ endpoint }} · 本机 MCP</span></div><button :disabled="busy" @click="connect(true)">{{ busy ? '处理中…' : '重新连接 / 刷新' }}</button></div>
    <div v-if="error" role="alert" class="error">{{ error }}</div>
    <section v-if="!configured" class="empty card"><h2>配置告警中心</h2><p>打开「设置 → 自定义功能插件 → 告警中心 → 配置」，填写服务地址、本机 MCP 路径及账号密码。</p><p>保存后点击重新连接。插件使用配置自动登录，无需打开远端登录页。</p></section>
    <template v-if="connected">
      <div class="overview"><section class="card"><span class="muted">当前账号</span><strong>{{ me?.user?.display_name || me?.user?.username || me?.display_name || me?.username || '已认证' }}</strong><button class="link" @click="detail = me">查看账号详情</button></section><section class="card"><span class="muted">当前列表</span><strong>{{ total }} <small>条记录</small></strong><span class="muted">{{ sections.find(s => s.id === tab)?.label }}</span></section><section class="card"><span class="muted">可用能力</span><strong>{{ tools.length }} <small>项</small></strong><button class="link" @click="detail = summary">查看告警概览</button></section></div>
      <nav aria-label="告警中心功能"><button v-for="section in sections" :key="section.id" :class="{active:tab === section.id}" :disabled="busy" @click="switchTab(section.id)">{{ section.label }}</button></nav>
      <section v-if="tab !== 'tools'" class="card list">
        <div class="filters" role="search"><input v-if="tools.find(t => t.name === `list_${tab}`)?.inputSchema.properties?.q" v-model="query" @keydown.enter.prevent="search" aria-label="搜索" placeholder="搜索标题、服务或关键字" :disabled="busy"><select v-if="['cases','todos'].includes(tab)" v-model="scope" aria-label="查询范围" :disabled="busy"><option value="all">全部</option><option value="mine">我的</option><option value="team">团队</option></select><button type="button" :disabled="busy" @click="search">查询</button><button v-if="['todos','owners','rules'].includes(tab)" class="primary" type="button" :disabled="busy" @click="edit(({todos:'create_todo',owners:'create_owner',rules:'create_rule'} as any)[tab])">新增{{ sections.find(s=>s.id===tab)?.label }}</button></div>
        <div class="table-scroll"><table><thead><tr><th v-for="col in columns" :key="col">{{ fieldLabels[col] || ({updated_at:'更新时间'} as any)[col] || col }}</th><th>操作</th></tr></thead><tbody><tr v-for="row in rows" :key="row.id"><td v-for="col in columns" :key="col">{{ cell(row[col]) }}</td><td class="actions"><button class="link" :disabled="busy" @click="openDetail(row)">详情</button><select v-if="rowActions.length" aria-label="操作记录" :disabled="busy" @change="edit(($event.target as HTMLSelectElement).value, ($event.target as HTMLSelectElement).value === 'dry_run_rule' ? {rule:row} : row); ($event.target as HTMLSelectElement).value = ''"><option value="">更多操作</option><option v-for="action in rowActions" :key="action" :value="action">{{ toolLabels[action] }}</option></select></td></tr></tbody></table></div>
        <p v-if="!rows.length" class="empty">{{ busy ? '正在读取…' : '暂无匹配记录' }}</p>
        <footer><span class="muted">共 {{ total }} 条 · 第 {{ Math.floor(offset / 25)+1 }} 页</span><button :disabled="busy || !offset" @click="offset -= 25; run(loadRows)">上一页</button><button :disabled="busy || !hasMore" @click="offset += 25; run(loadRows)">下一页</button></footer>
      </section>
      <section v-else class="tool-grid"><button v-for="tool in tools" :key="tool.name" class="card tool" :disabled="busy" @click="edit(tool.name)"><strong>{{ toolLabels[tool.name] || tool.name }} <small>{{ tool.readOnly ? '只读' : '需确认' }}</small></strong><span>{{ tool.description }}</span><code>{{ tool.name }}</code></button></section>
    </template>
    <PluginPanel v-if="selected" :title="toolLabels[selected.name] || selected.name" :busy="busy" @close="selected = undefined; preview = undefined"><p class="muted">{{ selected.description }}</p><div v-if="error" class="error" role="alert">{{ error }}</div>
      <div v-if="!preview" role="form" :aria-label="toolLabels[selected.name] || selected.name"><label v-for="[key,schema] in fieldSchema" :key="key">{{ fieldLabels[key] || key }} {{ selected.inputSchema.required?.includes(key) ? '*' : '' }}<select v-if="schema.enum || schema.type === 'boolean'" v-model="fields[key]" :disabled="busy"><option value="">请选择</option><option v-for="option in schema.enum || ['true','false']" :key="String(option)" :value="String(option)">{{ option }}</option></select><textarea v-else-if="schema.type !== 'string' || ['description','body','payload'].includes(key)" v-model="fields[key]" :disabled="busy" :placeholder="schema.type === 'string' ? '' : 'JSON 格式'" rows="3"/><input v-else v-model="fields[key]" :disabled="busy" @keydown.enter.prevent="submit"><small class="muted">{{ schema.description }}</small></label><button type="button" class="primary" :disabled="busy" @click="submit">{{ selected.readOnly ? '执行查询' : '预览变更' }}</button></div>
      <div v-else><p>将向 {{ endpoint }} 执行 <strong>{{ toolLabels[preview.name] || preview.name }}</strong>。请核对记录和参数：</p><pre>{{ pretty(preview.arguments) }}</pre><button :disabled="busy" @click="preview = undefined">返回修改</button> <button class="primary" :disabled="busy" @click="commit">确认执行远端变更</button></div>
      <template v-if="result !== undefined"><h3>执行结果</h3><pre>{{ pretty(result) }}</pre><button :disabled="busy" @click="compose(result)">带入会话草稿</button></template>
    </PluginPanel>
    <PluginPanel v-if="detail !== undefined" title="记录详情" :busy="busy" @close="detail = undefined"><pre>{{ pretty(detail) }}</pre><button :disabled="busy" @click="compose(detail)">带入会话草稿</button></PluginPanel>
  </main>
</template>
