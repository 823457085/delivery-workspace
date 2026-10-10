<script setup lang="ts">
/** Jira 搜索在此收口，行分配和菜单分配共用；只发出人员选择，不保存台账或使用 mock 人员替代真实搜索。 */
import { computed, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { ApexBffAssignee } from '../../../shared/apex-bff-review';

const props = defineProps<{ modelValue?: ApexBffAssignee; disabled?: boolean; loading?: boolean; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: ApexBffAssignee | undefined] }>();
const term = shallowRef('');
const query = useQuery({
  queryKey: computed(() => ['jira-review-assignees', term.value.trim()]),
  enabled: computed(() => !!term.value.trim() && !props.disabled), retry: false, staleTime: 60_000,
  queryFn: async ({ signal }): Promise<ApexBffAssignee[]> => {
    const response = await fetch(`/api/source/users?query=${encodeURIComponent(term.value.trim())}`, { signal });
    const data = await response.json();
    if (!response.ok || data.source !== 'jira') throw new Error(data.message || data.warning || 'Jira 人员搜索失败');
    return data.users.filter((user: ApexBffAssignee) => user.name && user.displayName && user.name !== 'currentUser()')
      .map((user: ApexBffAssignee) => ({ name: user.name, displayName: user.displayName }));
  },
});
const options = computed(() => [...new Map([...(props.modelValue ? [props.modelValue] : []), ...(query.data.value ?? [])].map(user => [user.name, user])).values()]);
watch(query.error, error => { if (error) ElMessage.error(error.message); });
function select(name: string) { emit('update:modelValue', options.value.find(user => user.name === name)); }
function search(value: string) { term.value = value; }
</script>

<template>
  <el-select :model-value="modelValue?.name || ''" filterable remote clearable :remote-method="search"
    :loading="loading || query.isFetching.value" :disabled="disabled" placeholder="搜索 Jira 姓名或账号"
    :aria-label="label || '搜索 Jira 人员'" no-data-text="请输入 Jira 姓名或账号" @change="select">
    <el-option v-for="user in options" :key="user.name" :value="user.name" :label="user.displayName">
      <span>{{ user.displayName }}</span><small class="account">{{ user.name }}</small>
    </el-option>
  </el-select>
</template>

<style scoped>
.account{margin-left:10px;color:var(--ui-muted)}
</style>
