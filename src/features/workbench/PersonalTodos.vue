<script setup lang="ts">
import { computed, reactive, shallowRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { Plus, Pencil, Trash2 } from '@lucide/vue';
import { workspaceTodoInputSchema, workspaceTodoStatusLabels, type TodoItem, type WorkspaceTodoInput } from '../../../shared/workspace-todos';

const endpoint = '/api/workspace-todos', key = ['workspace-todos'];
async function request<T>(path = '', input?: unknown): Promise<T> {
  const response = await fetch(endpoint + path, input === undefined ? undefined : { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || '个人待办读取失败');
  return value;
}
const client = useQueryClient();
const query = useQuery({ queryKey: key, queryFn: () => request<{ items: TodoItem[] }>(), retry: false, refetchInterval: 15_000 });
watch(() => query.error.value, error => { if (error) ElMessage.error(error.message); });
const busy = shallowRef(false), editorOpen = shallowRef(false), filter = shallowRef<'open' | 'all' | 'done'>('open');
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
    client.setQueryData<{ items: TodoItem[] }>(key, old => ({ items: [...(old?.items || []).filter(item => item.id !== saved.id), saved] }));
    void client.invalidateQueries({ queryKey: key });
    return true;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '个人待办保存失败'); return false; }
  finally { busy.value = false; }
}
async function saveDraft() { if (await save({ ...draft })) editorOpen.value = false; }
async function remove(item: TodoItem) {
  if (busy.value) return;
  busy.value = true;
  try {
    await request('/delete', { id: item.id });
    client.setQueryData<{ items: TodoItem[] }>(key, old => ({ items: (old?.items || []).filter(value => value.id !== item.id) }));
    void client.invalidateQueries({ queryKey: key });
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '个人待办删除失败'); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="personal-todos wb-card" aria-label="个人待办事项">
    <header class="todo-heading"><div><h2>个人待办 <small>{{ openCount }} 项未完成</small></h2><p>记录需要自己处理的事项，纳入每日工作汇报。</p></div><el-button :disabled="busy" @click="edit()"><Plus :size="14" />添加待办</el-button></header>
    <div class="todo-filters" role="group" aria-label="个人待办筛选"><el-radio-group v-model="filter" size="small"><el-radio-button value="open">未完成</el-radio-button><el-radio-button value="all">全部</el-radio-button><el-radio-button value="done">已完成</el-radio-button></el-radio-group></div>
    <div v-loading="query.isPending.value" class="todo-list">
      <article v-for="item in items" :key="item.id" class="todo-item">
        <div class="todo-content"><strong :class="{ done: item.status === 'done' }">{{ item.title }}</strong><p v-if="item.details">{{ item.details }}</p><div class="todo-meta"><el-tag v-if="item.priority === 'high'" size="small" type="warning">高优先级</el-tag><span v-if="item.dueDate">截止 {{ item.dueDate }}</span></div></div>
        <div class="todo-actions"><el-select :model-value="item.status" size="small" :aria-label="`${item.title}状态`" :disabled="busy" @update:model-value="(value: TodoItem['status']) => save({ ...inputFor(item), status: value })"><el-option v-for="(label, value) in workspaceTodoStatusLabels" :key="value" :label="label" :value="value" /></el-select><el-button link :aria-label="`编辑${item.title}`" :disabled="busy" @click="edit(item)"><Pencil :size="15" /></el-button><el-button link :aria-label="`删除${item.title}`" :disabled="busy" @click="remove(item)"><Trash2 :size="15" /></el-button></div>
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
.personal-todos{margin:20px 0}.todo-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px 12px}.todo-heading h2{margin:0;font-size:16px}.todo-heading h2 small{margin-left:8px;color:var(--ui-muted);font-size:12px;font-weight:400}.todo-heading p{margin:7px 0 0;color:var(--ui-muted);font-size:12px}.todo-filters{padding:0 20px 12px}.todo-list{min-height:60px;padding:0 20px}.todo-item{display:flex;align-items:flex-start;gap:16px;padding:14px 0;border-top:1px solid var(--ui-divider)}.todo-content{flex:1;min-width:0;overflow-wrap:anywhere}.todo-content strong{font-size:14px;color:var(--ui-text)}.todo-content strong.done{color:var(--ui-muted);text-decoration:line-through}.todo-content p{margin:6px 0;color:var(--ui-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap}.todo-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:7px;color:var(--ui-muted);font-size:12px}.todo-actions{display:flex;align-items:center;gap:8px}.todo-actions .el-select{width:104px}.todo-actions .el-button+.el-button{margin-left:0}.todo-form-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:12px}
@media(max-width:600px){.todo-heading{align-items:flex-start;padding:16px 14px 12px;gap:10px}.todo-heading h2 small{display:block;margin:5px 0 0}.todo-heading .el-button{flex-shrink:0}.todo-filters,.todo-list{padding-left:14px;padding-right:14px}.todo-item{flex-direction:column;gap:10px}.todo-actions{align-self:flex-end}.todo-form-grid{grid-template-columns:1fr}}
</style>
