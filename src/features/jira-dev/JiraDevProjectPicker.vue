<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';

const props = defineProps<{ open: boolean; selected: string[]; candidates: { name: string; path: string }[] }>();
const emit = defineEmits<{ close: []; select: [paths: string[]] }>();
const draft = ref<string[]>([]);
const search = ref('');
const picker = useWorkspacePicker();
watch(() => props.open, open => {
  if (open) { draft.value = [...props.selected]; search.value = ''; }
}, { immediate: true });
const options = computed(() => {
  const items = new Map(props.candidates.map(item => [item.path, item]));
  for (const path of draft.value) if (!items.has(path)) items.set(path, { path, name: path.split('/').filter(Boolean).at(-1) || path });
  const query = search.value.trim().toLowerCase();
  return [...items.values()].filter(item => `${item.name} ${item.path}`.toLowerCase().includes(query));
});
async function browse() {
  const selection = await picker.choose(draft.value.at(-1) || '');
  if (!props.open) return;
  if (selection && !draft.value.includes(selection.workspacePath)) {
    if (draft.value.length >= 10) { ElMessage.warning('一次需求最多选择 10 个项目。'); return; }
    draft.value.push(selection.workspacePath);
    search.value = '';
  } else if (picker.error.value) ElMessage.error(picker.error.value);
}
function confirm() { emit('select', [...draft.value]); emit('close'); }
</script>

<template>
  <el-dialog :model-value="open" title="选择项目" width="min(760px, 94vw)" class="jira-project-picker" append-to-body destroy-on-close
    :close-on-click-modal="false" :show-close="!picker.selecting.value" :close-on-press-escape="!picker.selecting.value" @close="emit('close')">
    <el-input v-model="search" aria-label="搜索项目名称或路径" placeholder="搜索项目名称或路径" clearable />
    <el-checkbox-group v-model="draft" :max="10" class="project-options" aria-label="可选项目" :disabled="picker.selecting.value">
      <el-checkbox v-for="item in options" :key="item.path" :value="item.path" class="project-option">
        <strong>{{ item.name }}</strong><span>{{ item.path }}</span>
      </el-checkbox>
      <el-empty v-if="!options.length" description="暂无匹配项目" :image-size="56" />
    </el-checkbox-group>
    <template #footer>
      <div class="project-picker-footer">
        <span>已选 {{ draft.length }} / 10 个项目</span>
        <el-button :loading="picker.selecting.value" :disabled="draft.length >= 10" @click="browse">添加其他文件夹</el-button>
        <el-button :disabled="picker.selecting.value" @click="emit('close')">取消</el-button>
        <el-button type="primary" :disabled="picker.selecting.value" @click="confirm">确认选择</el-button>
      </div>
    </template>
  </el-dialog>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
</template>

<style scoped>
.project-options{display:flex;flex-direction:column;gap:4px;max-height:50vh;overflow:auto;margin-top:12px}
.project-option{height:auto;min-height:54px;margin-right:0;padding:10px 8px;box-sizing:border-box;align-items:flex-start;border-radius:var(--ds-radius-sm,8px)}
.project-option:hover{background:var(--el-fill-color-light)}
.project-option :deep(.el-checkbox__input){margin-top:3px}.project-option :deep(.el-checkbox__label){min-width:0;white-space:normal;line-height:1.5}
.project-option strong,.project-option span{display:block}.project-option span{color:var(--ui-secondary);font-size:12px;overflow-wrap:anywhere}
.project-picker-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}.project-picker-footer>span{margin-right:auto;color:var(--ui-secondary);font-size:12px}.project-picker-footer .el-button+.el-button{margin-left:0}
</style>
