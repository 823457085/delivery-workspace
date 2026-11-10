<script setup lang="ts">
import { computed, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { workspaceTeamTodos } from '../../../shared/workspace-team-todos';
import { readTeamTasks } from '../agent-workbench/team-api';
import { dateTime } from '../../shared/format';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
const runtime = useAgentRuntimeSnapshot();
const query = useQuery({ queryKey: ['agent-team-chat', 'tasks'], queryFn: ({ signal }) => readTeamTasks(signal), retry: false, refetchInterval: 15_000 });
const todos = computed(() => workspaceTeamTodos(query.data.value || [], runtime.data.value?.runs).filter(task => task.category !== 'doing'));
watch(query.error, error => { if (error) ElMessage.error(error.message); });
</script>
<template>
  <section v-if="query.isPending.value || query.error.value || todos.length" class="surface team-todos" aria-label="团队待办">
    <div class="surface-header"><div><h2>团队待办 · {{ todos.length }}</h2><p>等待你回复、确认计划、处理阻塞或验收的团队任务</p></div><el-button size="small" :loading="query.isFetching.value" @click="query.refetch()">刷新</el-button></div>
    <el-skeleton v-if="query.isPending.value" class="surface-body" :rows="2" animated />
    <el-empty v-else-if="query.error.value" description="团队待办暂未读取成功，请刷新重试" :image-size="36" />
    <div v-else class="team-todo-list"><article v-for="task in todos" :key="task.id"><div><RouterLink :to="task.url || '/agent'">{{ task.title }}</RouterLink><span>{{ task.status }}</span><p>{{ task.detail || task.nextAction }}</p><small>{{ dateTime(task.updatedAt) }}</small></div><RouterLink :to="task.url || '/agent'"><el-button size="small">继续处理</el-button></RouterLink></article></div>
  </section>
</template>
<style scoped>
.team-todos{margin-bottom:20px}.team-todo-list{padding:0 20px}.team-todo-list article{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;border-bottom:1px solid var(--ui-divider)}.team-todo-list article:last-child{border:0}.team-todo-list article>div{min-width:0}.team-todo-list a{color:var(--ui-accent);overflow-wrap:anywhere}.team-todo-list span{display:block;margin-top:6px;color:var(--ui-secondary);font-size:12px}.team-todo-list p{margin:6px 0;color:var(--ui-muted);font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.team-todo-list small{color:var(--ui-muted);font-size:11px}@media(max-width:600px){.team-todo-list article{align-items:flex-start;flex-direction:column}}
</style>
