<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { systemProjectColumns, systemProjectRegions, systemProjectWorkbookLimit, type SystemProjectPreview, type SystemProjectRow, type SystemProjectSave } from '../../../shared/system-catalog';

const props = defineProps<{ mode: 'manual' | 'excel' | null }>();
const emit = defineEmits<{ close: []; saved: [result: SystemProjectSave] }>();
const emptyRow = (): SystemProjectRow => ({ name: '', region: '海外', environment: '', branch: '', url: '', repository: '', notes: '' });
const draft = ref(emptyRow());
const preview = shallowRef<SystemProjectPreview>();
const reading = shallowRef(false), saving = shallowRef(false);
const busy = computed(() => reading.value || saving.value);
const excel = computed(() => props.mode === 'excel');
const title = computed(() => excel.value ? 'Excel 导入项目' : '添加项目');
const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
watch(() => props.mode, mode => { if (mode) { draft.value = emptyRow(); preview.value = undefined; } });

async function request<T>(action: string, body: BodyInit, contentType: string): Promise<T> {
  const response = await fetch(`/api/systems/projects/${action}`, {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': contentType, 'X-Delivery-Confirmed': 'yes' }, body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message);
  return result;
}
function close() { if (!busy.value) emit('close'); }

async function choose(event: Event) {
  if (busy.value) return;
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  preview.value = undefined;
  if (!/\.xlsx$/i.test(file.name) || file.size > systemProjectWorkbookLimit) {
    ElMessage.error('请选择不超过 1 MiB 的 XLSX 文件');
    return;
  }
  reading.value = true;
  try { preview.value = await request<SystemProjectPreview>('preview', file, xlsx); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法读取 Excel'); }
  finally { reading.value = false; }
}

async function save() {
  if (busy.value || !props.mode) return;
  const rows = excel.value ? preview.value?.rows : [draft.value];
  if (!rows?.length) return;
  saving.value = true;
  try { emit('saved', await request<SystemProjectSave>('save', JSON.stringify({ rows }), 'application/json')); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '保存项目失败'); }
  finally { saving.value = false; }
}
</script>

<template>
  <el-dialog :model-value="!!mode" :title="title" :width="excel ? 'min(840px, 94vw)' : 'min(600px, 94vw)'"
    append-to-body destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy"
    @update:model-value="close">
    <template v-if="excel">
      <div class="project-upload">
        <a href="/system-project-import.xlsx" download="项目导入模板.xlsx">下载 Excel 模板</a>
        <label for="system-project-workbook">选择 XLSX 文件</label>
        <input id="system-project-workbook" type="file" :accept="`.xlsx,${xlsx}`" :disabled="busy" @change="choose" />
      </div>
      <p class="project-note">一行填写一个环境，最多 200 行。同名同区域的项目会合并，完全相同的环境会跳过。</p>
      <el-skeleton v-if="reading" :rows="3" animated />
      <template v-else-if="preview">
        <p role="status">共 {{ preview.rows.length }} 行 · 新增 {{ preview.added }} 个环境 · 跳过 {{ preview.skipped }} 个重复环境</p>
        <el-table :data="preview.rows" max-height="330">
          <el-table-column prop="name" :label="systemProjectColumns.name" min-width="135" />
          <el-table-column prop="region" :label="systemProjectColumns.region" width="66" />
          <el-table-column prop="environment" :label="systemProjectColumns.environment" min-width="85" />
          <el-table-column prop="branch" :label="systemProjectColumns.branch" min-width="90" />
          <el-table-column prop="url" :label="systemProjectColumns.url" min-width="200" show-overflow-tooltip />
          <el-table-column prop="repository" :label="systemProjectColumns.repository" min-width="190" show-overflow-tooltip />
          <el-table-column prop="notes" :label="systemProjectColumns.notes" min-width="140" show-overflow-tooltip />
        </el-table>
      </template>
    </template>
    <el-form v-else label-position="top" class="project-form" :disabled="busy" @submit.prevent="save">
      <el-form-item :label="systemProjectColumns.name" required><el-input v-model="draft.name" maxlength="100" /></el-form-item>
      <el-form-item :label="systemProjectColumns.region"><el-select v-model="draft.region"><el-option v-for="region in systemProjectRegions" :key="region" :label="region" :value="region" /></el-select></el-form-item>
      <el-form-item :label="systemProjectColumns.environment" required><el-input v-model="draft.environment" maxlength="80" placeholder="例如 开发、测试" /></el-form-item>
      <el-form-item :label="systemProjectColumns.branch"><el-input v-model="draft.branch" maxlength="120" placeholder="例如 develop" /></el-form-item>
      <el-form-item :label="systemProjectColumns.url" class="project-form-wide"><el-input v-model="draft.url" maxlength="500" placeholder="https://" /></el-form-item>
      <el-form-item :label="systemProjectColumns.repository" class="project-form-wide"><el-input v-model="draft.repository" maxlength="500" placeholder="https://" /></el-form-item>
      <el-form-item :label="systemProjectColumns.notes" class="project-form-wide"><el-input v-model="draft.notes" type="textarea" :rows="2" maxlength="500" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="busy" @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="reading || (excel ? !preview?.added : !draft.name.trim() || !draft.environment.trim())" @click="save">
        {{ excel ? '确认导入' : '保存项目' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.project-form { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 0 14px; }
.project-form-wide { grid-column: 1 / -1; }
.project-upload { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.project-upload a { color: var(--el-color-primary); }
.project-upload input { min-width: 0; max-width: 100%; }
.project-note { color: var(--el-text-color-secondary); line-height: 1.7; }
</style>
