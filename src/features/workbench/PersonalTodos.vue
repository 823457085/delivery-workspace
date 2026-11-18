<script setup lang="ts">
import { computed, inject, reactive, shallowRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { Bot, Check, CornerDownLeft, Pencil, Plus, Trash2 } from '@lucide/vue';
import { workspaceTodoInputSchema, workspaceTodoStatusLabels, type TodoItem, type WorkspaceTodoInput } from '../../../shared/workspace-todos';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { buildTodoAgentPrompt, parseQuickTodoInput } from './todo-quick-parse';

const workspace = inject(agentWorkspaceContext, undefined);
const endpoint = '/api/workspace-todos', key = ['workspace-todos'];
async function request<T>(path = '', input?: unknown): Promise<T> {
  const response = await fetch(endpoint + path, input === undefined ? undefined : { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || '个人待办读取失败');
  return value;
}
type TodoList = { items: TodoItem[]; source?: { mode: 'local' } | { mode: 'taskflow'; url: string; ready: boolean }; warning?: string };
const client = useQueryClient();
const query = useQuery({ queryKey: key, queryFn: () => request<TodoList>(), retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false });
watch(() => query.error.value, error => { if (error) ElMessage.error(error.message); });
const busy = shallowRef(false), editorOpen = shallowRef(false), filter = shallowRef<'open' | 'all' | 'done'>('open');
const quickText = shallowRef('');
const quickPreview = computed(() => quickText.value.trim() ? parseQuickTodoInput(quickText.value) : null);

const empty = (): WorkspaceTodoInput => ({ title: '', details: '', dueDate: '', priority: 'normal', status: 'todo' });
const draft = reactive<WorkspaceTodoInput>(empty());
const items = computed(() => (query.data.value?.items || []).filter(item => filter.value === 'all' || (filter.value === 'done' ? item.status === 'done' : item.status !== 'done'))
  .sort((left, right) => Number(right.priority === 'high') - Number(left.priority === 'high') || (left.dueDate || '9999').localeCompare(right.dueDate || '9999') || right.updatedAt.localeCompare(left.updatedAt)));
const openCount = computed(() => query.data.value?.items.filter(item => item.status !== 'done').length || 0);
function edit(item?: TodoItem) {
  Object.assign(draft, item ? inputFor(item) : empty());
  if (!item) delete draft.id;
  editorOpen.value = true;
}
function inputFor(item: TodoItem): WorkspaceTodoInput {
  return { id: item.id, title: item.title, details: item.details, dueDate: item.dueDate, priority: item.priority, status: item.status };
}
async function save(input: WorkspaceTodoInput) {
  if (busy.value) return false;
  const parsed = workspaceTodoInputSchema.safeParse(input);
  if (!parsed.success) { ElMessage.error(parsed.error.issues[0]?.message || '请检查待办内容'); return false; }
  busy.value = true;
  try {
    const saved = await request<TodoItem>('', parsed.data);
    client.setQueryData<TodoList>(key, old => ({ ...old, items: [...(old?.items || []).filter(item => item.id !== saved.id), saved] }));
    void client.invalidateQueries({ queryKey: key });
    return true;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '个人待办保存失败'); return false; }
  finally { busy.value = false; }
}
async function submitQuickTodo() {
  const parsed = quickPreview.value;
  if (!parsed || !parsed.title.trim() || busy.value) return;
  const ok = await save({
    title: parsed.title,
    details: parsed.details,
    dueDate: parsed.dueDate,
    priority: parsed.priority,
    status: 'todo',
  });
  if (ok) {
    quickText.value = '';
    ElMessage.success('已快速添加待办');
  }
}
async function toggleTodoDone(item: TodoItem) {
  const nextStatus: TodoItem['status'] = item.status === 'done' ? 'todo' : 'done';
  await save({ ...inputFor(item), status: nextStatus });
}
function delegateTodoToAgent(item: TodoItem) {
  if (!workspace) return;
  workspace.compose(buildTodoAgentPrompt(item));
}
async function saveDraft() { if (await save({ ...draft })) editorOpen.value = false; }
async function remove(item: TodoItem) {
  if (busy.value) return;
  busy.value = true;
  try {
    await request('/delete', { id: item.id });
    client.setQueryData<TodoList>(key, old => ({ ...old, items: (old?.items || []).filter(value => value.id !== item.id) }));
    void client.invalidateQueries({ queryKey: key });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '个人待办删除失败'); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="personal-todos wb-card" aria-label="个人待办事项">
    <header class="todo-heading"><div><h2>个人待办 <small>{{ openCount }} 项未完成</small></h2><p>记录需要自己处理的事项，纳入每日工作汇报。<span v-if="query.data.value?.source?.mode === 'taskflow'" class="todo-source" :class="{ warn: query.data.value.warning }" :title="query.data.value.warning || query.data.value.source.url">{{ query.data.value.warning ? '任务中心暂不可用，显示上次同步结果' : '已同步任务中心' }}</span></p></div><el-button :disabled="busy" @click="edit()"><Plus :size="14" />添加待办</el-button></header>

    <form class="todo-quick-bar" aria-label="极速添加待办" @submit.prevent="submitQuickTodo">
      <div class="todo-quick-row">
        <Plus :size="14" class="todo-quick-icon" />
        <input
          v-model="quickText"
          type="text"
          class="todo-quick-input"
          aria-label="极速添加个人待办"
          maxlength="240"
          :disabled="busy"
          placeholder="快速添加待办，支持 @明天 @周五 !高 // 补充说明，回车即存…"
        />
        <button
          v-if="quickText.trim()"
          type="submit"
          class="todo-quick-submit"
          :disabled="busy || !quickPreview?.title"
        >
          <CornerDownLeft :size="12" />
          <span>回车保存</span>
        </button>
      </div>
      <div v-if="quickPreview && (quickPreview.priority === 'high' || quickPreview.dueDate || quickPreview.details)" class="todo-quick-tokens" aria-live="polite">
        <span class="token-chip title-chip">标题：{{ quickPreview.title }}</span>
        <span v-if="quickPreview.priority === 'high'" class="token-chip high">高优先级</span>
        <span v-if="quickPreview.dueDate" class="token-chip date">截止 {{ quickPreview.dueDate }}</span>
        <span v-if="quickPreview.details" class="token-chip note">备注：{{ quickPreview.details }}</span>
      </div>
    </form>

    <div class="todo-filters" role="group" aria-label="个人待办筛选"><el-radio-group v-model="filter" size="small"><el-radio-button value="open">未完成</el-radio-button><el-radio-button value="all">全部</el-radio-button><el-radio-button value="done">已完成</el-radio-button></el-radio-group></div>
    <div v-loading="query.isPending.value" class="todo-list">
      <article v-for="item in items" :key="item.id" class="todo-item">
        <button
          type="button"
          class="todo-check-btn"
          :class="{ checked: item.status === 'done' }"
          :disabled="busy"
          :aria-label="item.status === 'done' ? `标记${item.title}未完成` : `完成${item.title}`"
          :title="item.status === 'done' ? '标记为未完成' : '一键标记完成'"
          @click="toggleTodoDone(item)"
        >
          <Check v-if="item.status === 'done'" :size="12" />
        </button>
        <div class="todo-content"><strong :class="{ done: item.status === 'done' }">{{ item.title }}</strong><p v-if="item.details">{{ item.details }}</p><div class="todo-meta"><el-tag v-if="item.priority === 'high'" size="small" type="warning">高优先级</el-tag><span v-if="item.dueDate">截止 {{ item.dueDate }}</span></div></div>
        <div class="todo-actions">
          <el-button
            v-if="workspace && item.status !== 'done'"
            link
            type="primary"
            :aria-label="`将${item.title}交给AI协办`"
            title="带上下文一键发起 AI 对话协办"
            :disabled="busy"
            @click="delegateTodoToAgent(item)"
          >
            <Bot :size="14" /><span>AI 协办</span>
          </el-button>
          <el-select :model-value="item.status" size="small" :aria-label="`${item.title}状态`" :disabled="busy" @update:model-value="(value: TodoItem['status']) => save({ ...inputFor(item), status: value })"><el-option v-for="(label, value) in workspaceTodoStatusLabels" :key="value" :label="label" :value="value" /></el-select>
          <el-button link :aria-label="`编辑${item.title}`" :disabled="busy" @click="edit(item)"><Pencil :size="15" /></el-button>
          <el-button link :aria-label="`删除${item.title}`" :disabled="busy" @click="remove(item)"><Trash2 :size="15" /></el-button>
        </div>
      </article>
      <el-empty v-if="!items.length && !query.isPending.value" :description="query.error.value ? '个人待办暂未读取成功' : filter === 'done' ? '暂无已完成的个人待办' : '暂无个人待办'" :image-size="36" />
    </div>
    <el-dialog v-model="editorOpen" :title="draft.id ? '编辑个人待办' : '添加个人待办'" width="min(560px, 94vw)" append-to-body :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
      <el-form label-position="top" :disabled="busy" @submit.prevent="saveDraft"><el-form-item label="待办事项" required><el-input v-model="draft.title" maxlength="200" placeholder="填写需要处理的事项" /></el-form-item><el-form-item label="补充说明"><el-input v-model="draft.details" type="textarea" :rows="3" maxlength="2000" /></el-form-item><div class="todo-form-grid"><el-form-item label="截止日期"><el-date-picker :model-value="draft.dueDate" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" aria-label="待办截止日期" style="width:100%" @update:model-value="draft.dueDate = $event || ''" /></el-form-item><el-form-item label="优先级"><el-select v-model="draft.priority"><el-option value="normal" label="普通" /><el-option value="high" label="高" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="draft.status"><el-option v-for="(label, value) in workspaceTodoStatusLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item></div></el-form>
      <template #footer><el-button :disabled="busy" @click="editorOpen = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!draft.title.trim()" @click="saveDraft">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.personal-todos{margin:20px 0}.todo-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px 10px}.todo-heading h2{margin:0;font-size:16px}.todo-heading h2 small{margin-left:8px;color:var(--ui-muted);font-size:12px;font-weight:400}.todo-heading p{margin:7px 0 0;color:var(--ui-muted);font-size:12px}.todo-source{margin-left:8px;padding:1px 6px;border-radius:4px;background:color-mix(in srgb,var(--el-color-success) 12%,transparent);color:var(--el-color-success)}.todo-source.warn{background:color-mix(in srgb,var(--el-color-warning) 14%,transparent);color:var(--el-color-warning)}
.todo-quick-bar{margin:0 20px 12px;padding:7px 10px;border:1px solid var(--ui-border);border-radius:var(--ds-radius,8px);background:var(--ui-raised);transition:border-color 160ms ease,background-color 160ms ease}.todo-quick-bar:focus-within{border-color:var(--ui-accent);background:var(--ui-surface)}.todo-quick-row{display:flex;align-items:center;gap:8px}.todo-quick-icon{flex-shrink:0;color:var(--ui-muted)}.todo-quick-input{flex:1;min-width:0;height:26px;border:0;outline:0;background:transparent;color:var(--ui-text);font:400 13px/20px var(--sans)}.todo-quick-input::placeholder{color:var(--ui-muted)}.todo-quick-submit{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border:1px solid color-mix(in srgb,var(--ui-accent) 40%,var(--ui-border));border-radius:6px;background:var(--ui-accent-soft);color:var(--ui-accent);font:600 11.5px/1 var(--sans);cursor:pointer;flex-shrink:0}.todo-quick-submit:disabled{opacity:.5;cursor:not-allowed}.todo-quick-tokens{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--ui-divider)}.token-chip{display:inline-flex;align-items:center;padding:2px 7px;border-radius:5px;border:1px solid var(--ui-border);background:var(--ui-surface);color:var(--ui-secondary);font:500 11px/15px var(--sans);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.token-chip.high{border-color:color-mix(in srgb,var(--ui-warning) 45%,var(--ui-border));background:var(--ui-warning-bg);color:var(--ui-warning)}.token-chip.date{border-color:color-mix(in srgb,var(--ui-accent) 38%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent)}
.todo-filters{padding:0 20px 12px}.todo-list{min-height:60px;padding:0 20px}.todo-item{display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-top:1px solid var(--ui-divider)}.todo-check-btn{display:inline-grid;place-items:center;width:18px;height:18px;margin-top:2px;padding:0;flex-shrink:0;border:1.5px solid var(--ui-muted);border-radius:5px;background:transparent;color:#fff;cursor:pointer;transition:background-color 140ms ease,border-color 140ms ease}.todo-check-btn:hover{border-color:var(--ui-accent)}.todo-check-btn.checked{border-color:var(--ui-success);background:var(--ui-success);color:var(--ui-on-primary,#0b0e17)}
.todo-content{flex:1;min-width:0;overflow-wrap:anywhere}.todo-content strong{font-size:14px;color:var(--ui-text)}.todo-content strong.done{color:var(--ui-muted);text-decoration:line-through}.todo-content p{margin:6px 0;color:var(--ui-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap}.todo-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:7px;color:var(--ui-muted);font-size:12px}.todo-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.todo-actions .el-select{width:104px}.todo-actions .el-button+.el-button{margin-left:0}.todo-form-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:12px}
@media(max-width:600px){.todo-heading{align-items:flex-start;padding:16px 14px 10px;gap:10px}.todo-heading h2 small{display:block;margin:5px 0 0}.todo-heading .el-button{flex-shrink:0}.todo-quick-bar{margin-inline:14px}.todo-filters,.todo-list{padding-left:14px;padding-right:14px}.todo-item{flex-wrap:wrap;gap:10px}.todo-actions{width:100%;justify-content:flex-end}.todo-form-grid{grid-template-columns:1fr}}
</style>
