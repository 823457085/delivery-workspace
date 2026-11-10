<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { matchBrowserAccounts, mergeImportedAccounts, parseBrowserAccountCsv, type BrowserAccountGroup } from '../../../shared/system-account-import';
import type { CatalogSystem, SystemAccountsRead, SystemCatalog } from '../../../shared/system-catalog';

const props = defineProps<{ modelValue: boolean; systems: CatalogSystem[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; imported: [catalog: SystemCatalog] }>();
type ImportRow = BrowserAccountGroup & { count: number; selected: boolean; status: 'pending' | 'saving' | 'done' | 'failed'; failure: string };
const fileInput = ref<HTMLInputElement>();
const rows = ref<ImportRow[]>([]);
const parsing = shallowRef(false), saving = shallowRef(false), parsed = shallowRef(false);
const unmatchedCount = shallowRef(0), duplicateCount = shallowRef(0);
const totals = ref({ environments: 0, added: 0, updated: 0, skipped: 0, conflicts: 0 });
const busy = computed(() => parsing.value || saving.value);
const selectedCount = computed(() => rows.value.filter(row => row.selected && row.status !== 'done').length);
const failedCount = computed(() => rows.value.filter(row => row.status === 'failed').length);
const visible = computed({
  get: () => props.modelValue,
  set: value => { if (!busy.value) emit('update:modelValue', value); },
});
let generation = 0, disposed = false;
let controller: AbortController | undefined;

function clearPlan() {
  generation++;
  controller?.abort(); controller = undefined;
  if (fileInput.value) fileInput.value.value = '';
  for (const row of rows.value) row.accounts = [];
  rows.value = []; parsed.value = false; unmatchedCount.value = 0; duplicateCount.value = 0;
  totals.value = { environments: 0, added: 0, updated: 0, skipped: 0, conflicts: 0 };
  parsing.value = false; saving.value = false;
}
watch(() => props.modelValue, open => { if (!open) clearPlan(); });
onBeforeUnmount(() => { disposed = true; clearPlan(); });
function beforeClose(done: () => void) { if (!busy.value) done(); }
function isCurrent(request: number) { return !disposed && props.modelValue && request === generation; }
const origin = (url: string) => { try { return new URL(url).origin; } catch { return ''; } };

async function selectFile(event: Event) {
  if (busy.value) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  clearPlan();
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) { ElMessage.error('请选择 Chrome 密码管理器导出的 CSV 文件'); return; }
  if (file.size > 2 * 1024 * 1024) { ElMessage.error('CSV 文件不能超过 2 MiB'); return; }
  const request = generation;
  parsing.value = true;
  try {
    const content = await file.text();
    if (!isCurrent(request)) return;
    const result = matchBrowserAccounts(parseBrowserAccountCsv(content), props.systems);
    rows.value = result.groups.map(group => ({ ...group, count: group.accounts.length, selected: true, status: 'pending', failure: '' }));
    unmatchedCount.value = result.unmatchedCount; duplicateCount.value = result.duplicateCount; parsed.value = true;
  } catch {
    if (isCurrent(request)) ElMessage.error('无法读取 CSV，请使用 Chrome 密码管理器导出的文件（最多 10000 行）');
  } finally {
    if (isCurrent(request)) parsing.value = false;
  }
}

async function requestAccounts<T>(path: string, input: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/systems/accounts/${path}`, {
    method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : '账号操作失败');
  return result as T;
}
async function save() {
  if (busy.value || !selectedCount.value) return;
  const request = generation;
  const selectedRows = rows.value.filter(row => row.selected && row.status !== 'done');
  controller = new AbortController();
  const signal = controller.signal;
  saving.value = true;
  let failures = 0;
  try {
    for (const row of selectedRows) {
      if (!isCurrent(request)) return;
      row.status = 'saving'; row.failure = '';
      try {
        const current = await requestAccounts<SystemAccountsRead>('read', { environmentId: row.environmentId }, signal);
        if (!isCurrent(request)) return;
        if (!current.revision) throw new Error('账号读取结果已失效');
        const merged = mergeImportedAccounts(current.accounts, row.accounts);
        if (merged.added || merged.updated) {
          const catalog = await requestAccounts<SystemCatalog>('save', { environmentId: row.environmentId, accounts: merged.accounts,
            expectedRevision: current.revision }, signal);
          if (!isCurrent(request)) return;
          emit('imported', catalog);
        }
        totals.value.environments++;
        totals.value.added += merged.added; totals.value.updated += merged.updated;
        totals.value.skipped += merged.skipped; totals.value.conflicts += merged.conflicts;
        row.status = 'done'; row.selected = false; row.accounts = [];
      } catch (error) {
        if (!isCurrent(request)) return;
        row.status = 'failed'; failures++;
        row.failure = error instanceof Error ? error.message : '保存失败，可重试';
      }
    }
    if (isCurrent(request)) {
      if (failures) ElMessage.warning(`${failures} 个环境未保存，请查看结果后重试`);
      else ElMessage.success('所选环境已处理，请查看导入结果');
    }
  } finally {
    if (isCurrent(request)) { saving.value = false; controller = undefined; }
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="导入浏览器账号" width="min(900px, 95vw)" destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" :before-close="beforeClose">
    <div class="browser-account-import">
      <p>仅导入与系统入口完全匹配的账号</p>
      <label for="browser-account-csv">选择 Chrome 密码管理器导出的 CSV（最大 2 MiB）</label>
      <input id="browser-account-csv" ref="fileInput" type="file" accept=".csv,text/csv" :disabled="busy" @change="selectFile" />
      <p class="import-note">文件仅在浏览器内解析，点击保存后将所选账号收录到本机。同名账号密码不同会跳过；每个环境最多 20 个账号。</p>
      <el-skeleton v-if="parsing" :rows="3" animated />
      <template v-else-if="parsed">
        <p>匹配 {{ rows.length }} 个环境 · 未匹配 {{ unmatchedCount }} 个账号 · 文件内重复 {{ duplicateCount }} 个账号</p>
        <el-table v-if="rows.length" :data="rows" row-key="environmentId" max-height="360">
          <el-table-column width="44"><template #default="{ row }"><el-checkbox v-model="row.selected" :disabled="busy || row.status === 'done'" :aria-label="`导入 ${row.systemName} ${row.environmentName} 的账号`" /></template></el-table-column>
          <el-table-column prop="systemName" label="系统" min-width="140" />
          <el-table-column prop="environmentName" label="环境" min-width="80" />
          <el-table-column label="域名" min-width="180"><template #default="{ row }">{{ origin(row.url) }}</template></el-table-column>
          <el-table-column prop="count" label="账号数" width="80" />
          <el-table-column label="结果" min-width="130"><template #default="{ row }">{{ row.status === 'done' ? '已处理' : row.status === 'saving' ? '保存中' : row.status === 'failed' ? row.failure : '待导入' }}</template></el-table-column>
        </el-table>
        <el-empty v-else description="没有匹配的账号" :image-size="70" />
      </template>
      <p v-if="totals.environments" class="import-result" role="status">已处理 {{ totals.environments }} 个环境：新增 {{ totals.added }} 个账号，补齐 {{ totals.updated }} 个密码，跳过 {{ totals.skipped }} 个已有账号、{{ totals.conflicts }} 个密码不同的账号。</p>
      <p v-if="failedCount" class="import-note">{{ failedCount }} 个环境未保存，保留勾选后可重试。</p>
    </div>
    <template #footer><el-button :disabled="busy" @click="visible = false">关闭</el-button><el-button type="primary" :loading="saving" :disabled="parsing || !selectedCount" @click="save">保存所选 {{ selectedCount }} 个环境</el-button></template>
  </el-dialog>
</template>

<style scoped>
.browser-account-import{font-size:13px;color:var(--ui-text)}
.browser-account-import p{margin:0 0 14px;line-height:1.7}
.browser-account-import label{display:block;margin-bottom:8px}
.browser-account-import input[type=file]{display:block;max-width:100%;margin-bottom:14px;font:inherit}
.browser-account-import .import-note{font-size:12px;color:var(--ui-muted)}
.browser-account-import .import-result{margin-top:16px}
</style>
