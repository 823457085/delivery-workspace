<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { FileUp, FolderOpen } from '@lucide/vue';
import type { ApiCatalog, ApiProject, ApiProjectImportPreview, ApiRepositoryPreview } from '../../../shared/interface-center';
import type { ApifoxConnection, ApifoxProject } from '../../../shared/interface-center-apifox';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import { errorMessage, interfaceApi } from './api';

const open = defineModel<boolean>({ required: true });
type ImportMode = 'file' | 'repository' | 'apifox';
const props = defineProps<{ project?: ApiProject; projects: ApiProject[]; current?: boolean; refresh?: boolean; initialMode: ImportMode }>();
const emit = defineEmits<{ imported: [projectId?: string]; connect: [] }>();
const mode = ref<ImportMode>('apifox');
const destination = ref<'new' | 'existing' | 'batch'>('new');
const targetId = ref(''), name = ref('');
const busy = ref(false), fileReading = ref(false);
const picker = useWorkspacePicker();
const content = ref(''), filename = ref(''), fileInput = ref<HTMLInputElement>();
const repositoryPath = ref(''), repositoryRef = ref('origin/dev'), repositoryFile = ref('');
const repository = shallowRef<ApiRepositoryPreview>();
const repositoryAction = ref<'read' | 'fetch'>();
const canReadRepository = computed(() => !!(repositoryPath.value.trim() && repositoryRef.value.trim()));
const locked = computed(() => busy.value || !!repositoryAction.value || picker.selecting.value);
const connection = shallowRef<ApifoxConnection>();
const teamId = ref(''), remoteId = ref(''), remoteProjects = shallowRef<ApifoxProject[]>([]);
const prepared = shallowRef<ApiProjectImportPreview>();
let reading = 0;

const source = computed(() => {
  if (props.refresh) {
    const saved = props.project?.source;
    if (saved?.kind === 'apifox' && saved.apifoxTeamId && saved.apifoxProjectId) {
      return { kind: 'apifox', teamId: saved.apifoxTeamId, projectId: saved.apifoxProjectId };
    }
    if (saved?.kind === 'repository' && saved.repositoryPath && saved.ref && saved.file) {
      if (repository.value) {
        const { repositoryPath, ref, commit } = repository.value;
        return { kind: 'repository', repositoryPath, ref, commit, file: saved.file };
      }
      return { kind: 'repository', repositoryPath: saved.repositoryPath, ref: saved.ref, file: saved.file };
    }
    return;
  }
  if (mode.value === 'file' && content.value.trim()) {
    return { kind: 'file', content: content.value, filename: filename.value || 'openapi.yaml' };
  }
  if (mode.value === 'repository' && repository.value && repositoryFile.value) {
    const { repositoryPath, ref, commit } = repository.value;
    return { kind: 'repository', repositoryPath, ref, commit, file: repositoryFile.value };
  }
  if (mode.value === 'apifox' && teamId.value && remoteId.value) {
    return { kind: 'apifox', teamId: teamId.value, projectId: remoteId.value };
  }
});
const canPreview = computed(() => !!source.value && !fileReading.value && destination.value !== 'batch'
  && (mode.value !== 'file' || destination.value !== 'existing' || !!targetId.value));
const canSave = computed(() => destination.value === 'batch' ? !!repository.value
  : !!prepared.value && (!prepared.value.create || !!name.value.trim()));

watch(open, value => {
  if (!value) { reading++; fileReading.value = false; return; }
  mode.value = props.initialMode;
  destination.value = props.current && props.project ? 'existing' : 'new';
  targetId.value = props.current ? props.project?.id || '' : '';
  content.value = ''; filename.value = ''; prepared.value = undefined;
  repositoryPath.value = props.project?.source.repositoryPath || '';
  repositoryRef.value = props.project?.source.ref || 'origin/dev';
  repository.value = undefined; repositoryFile.value = '';
  connection.value = undefined; teamId.value = ''; remoteId.value = ''; remoteProjects.value = [];
  if (props.refresh) void preview();
  else if (mode.value === 'apifox') void loadConnection();
});
watch([source, destination, targetId], () => { prepared.value = undefined; }, { flush: 'sync' });
watch([repositoryPath, repositoryRef], () => { repository.value = undefined; repositoryFile.value = ''; }, { flush: 'sync' });
watch(mode, value => {
  destination.value = props.current && value === 'file' ? 'existing' : 'new';
  if (value === 'apifox' && !props.refresh && !connection.value && !busy.value) void loadConnection();
});

async function readFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (!file) return;
  const request = ++reading;
  fileReading.value = true; prepared.value = undefined;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的接口文件');
    const text = await file.text();
    if (request !== reading || !open.value) return;
    content.value = text; filename.value = file.name;
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { input.value = ''; if (request === reading) fileReading.value = false; }
}
async function chooseRepository() {
  if (locked.value) return;
  const selection = await picker.choose(repositoryPath.value.trim());
  if (!open.value || mode.value !== 'repository') return;
  if (selection) repositoryPath.value = selection.workspacePath;
  else if (picker.error.value) ElMessage.error(picker.error.value);
}
async function readRepository(action: 'read' | 'fetch') {
  if (locked.value || !canReadRepository.value) return;
  repositoryAction.value = action;
  const selectedFile = repositoryFile.value;
  repository.value = undefined;
  prepared.value = undefined;
  try {
    const result = await interfaceApi<ApiRepositoryPreview>(action === 'fetch' ? '/repository/fetch' : '/repository/preview',
      { repositoryPath: repositoryPath.value.trim(), ref: repositoryRef.value.trim() });
    repository.value = result;
    repositoryFile.value = selectedFile && result.projects.some(item => item.file === selectedFile)
      ? selectedFile : !selectedFile ? result.projects[0]?.file || '' : '';
    if (action === 'fetch') ElMessage.success('已拉取远端最新提交');
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { repositoryAction.value = undefined; }
  if (action === 'fetch' && repository.value) await preview();
}
async function readRemoteProjects() {
  remoteId.value = ''; remoteProjects.value = [];
  if (teamId.value) {
    remoteProjects.value = await interfaceApi<ApifoxProject[]>(`/apifox/projects?teamId=${encodeURIComponent(teamId.value)}`);
  }
}
async function loadConnection() {
  busy.value = true;
  try {
    const status = await interfaceApi<ApifoxConnection>('/apifox');
    if (!status.configured) { connection.value = status; return; }
    connection.value = await interfaceApi<ApifoxConnection>('/apifox/refresh', {});
    const { teams, preferredTeamId } = connection.value;
    teamId.value = teams.find(team => team.id === preferredTeamId)?.id || teams[0]?.id || '';
    await readRemoteProjects();
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { busy.value = false; }
}
async function changeTeam() {
  busy.value = true;
  try { await readRemoteProjects(); }
  catch (error) { ElMessage.error(errorMessage(error)); }
  finally { busy.value = false; }
}
async function preview() {
  if (locked.value || !canPreview.value) return;
  prepared.value = undefined; busy.value = true;
  try {
    const sync = mode.value !== 'file';
    const target = props.refresh ? props.project?.id : !sync && destination.value === 'existing' ? targetId.value : undefined;
    const result = await interfaceApi<ApiProjectImportPreview>('/import/preview', { source: source.value, targetId: target, sync });
    name.value = result.targetName;
    prepared.value = result;
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { busy.value = false; }
}
async function save() {
  if (locked.value || !canSave.value) return;
  busy.value = true;
  try {
    let selectedId: string | undefined;
    if (destination.value === 'batch' && repository.value) {
      const { repositoryPath, ref, commit } = repository.value;
      const result = await interfaceApi<ApiCatalog>('/repository/import', { repositoryPath, ref, commit });
      selectedId = result.projects.find(project => project.source.repositoryPath === repositoryPath && project.source.commit === commit)?.id;
      ElMessage.success('BFF 仓库接口已同步到 5288');
    } else if (prepared.value) {
      const { id, create, added } = prepared.value;
      const project = await interfaceApi<ApiProject>('/import/confirm', { previewId: id, ...(create ? { name: name.value.trim() } : {}) });
      selectedId = project.id;
      ElMessage.success(prepared.value.sync ? '来源已同步到 5288' : create ? '项目已创建，接口已导入' : added ? '新增接口已导入' : '接口已存在，已保留现有定义');
    }
    open.value = false;
    emit('imported', selectedId);
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { busy.value = false; }
}
</script>

<template>
  <el-dialog v-model="open" :title="refresh ? '更新来源' : '同步来源到 5288'" width="720px" class="interface-import-dialog"
    :close-on-click-modal="!locked" :close-on-press-escape="!locked" :show-close="!locked">
    <el-form label-position="top" :disabled="locked" class="import-content" @submit.prevent="preview">
      <el-form-item v-if="!refresh" label="来源">
        <el-radio-group v-model="mode" aria-label="接口来源">
          <el-radio-button value="apifox">Apifox 项目</el-radio-button>
          <el-radio-button value="repository">BFF 仓库</el-radio-button>
          <el-radio-button value="file">本地文件</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="refresh">
        <p class="import-note">{{ project?.source.label }}<template v-if="project?.source.ref"> · {{ project.source.ref }}</template></p>
        <div v-if="mode === 'repository'" class="repository-actions">
          <el-button native-type="button" :disabled="!canReadRepository" :loading="repositoryAction === 'fetch'" @click="readRepository('fetch')">拉取远端</el-button>
          <span v-if="repository" class="import-note">仓库提交 <code :title="repository.commit">{{ repository.commit.slice(0, 12) }}</code></span>
        </div>
      </template>
      <template v-else-if="mode === 'file'">
        <div class="file-selection">
          <input ref="fileInput" class="file-input" type="file" accept=".json,.yaml,.yml,application/json" aria-label="选择接口文档文件" :disabled="busy || fileReading" @change="readFile" />
          <el-button :loading="fileReading" @click="fileInput?.click()"><FileUp :size="15" />选择文件</el-button>
          <span>{{ filename || '支持 OpenAPI JSON / YAML，也可直接粘贴文档' }}</span>
        </div>
        <el-input v-model="content" aria-label="OpenAPI 文档内容" type="textarea" :rows="5" :disabled="fileReading" placeholder="粘贴 OpenAPI JSON 或 YAML" class="import-editor" />
      </template>

      <template v-else-if="mode === 'repository'">
        <div class="import-fields">
          <el-form-item label="本机 BFF 仓库路径" required>
            <div class="repository-location">
              <el-input v-model="repositoryPath" aria-label="本机 BFF 仓库路径" placeholder="例如 /path/to/titan-bff-openapi" />
              <el-button native-type="button" :loading="picker.selecting.value" @click="chooseRepository"><FolderOpen :size="15" />选择文件夹</el-button>
            </div>
          </el-form-item>
          <el-form-item label="分支 / 提交" required><el-input v-model="repositoryRef" aria-label="分支或提交" placeholder="origin/dev" /></el-form-item>
        </div>
        <div class="repository-actions">
          <el-button native-type="button" :disabled="!canReadRepository" :loading="repositoryAction === 'read'" @click="readRepository('read')">读取仓库</el-button>
          <el-button native-type="button" :disabled="!canReadRepository" :loading="repositoryAction === 'fetch'" @click="readRepository('fetch')">拉取远端</el-button>
          <span v-if="repository" class="import-note">仓库提交 <code :title="repository.commit">{{ repository.commit.slice(0, 12) }}</code></span>
        </div>
        <p class="import-note">读取本机 Git 中的提交。填写远端分支（例如 origin/dev）可拉取最新版本。</p>
        <el-form-item v-if="repository" label="同步范围" class="repository-file">
          <el-radio-group v-model="destination" aria-label="仓库同步范围">
            <el-radio value="new">选定契约</el-radio>
            <el-radio value="batch">仓库全部契约</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="repository && destination !== 'batch'" label="契约文件" class="repository-file">
          <el-select v-model="repositoryFile" filterable aria-label="BFF 契约文件">
            <el-option v-for="item in repository.projects" :key="item.file" :label="`${item.name} · ${item.file}`" :value="item.file" />
          </el-select>
        </el-form-item>
      </template>

      <template v-else>
        <div v-if="connection?.configured" class="import-fields">
          <el-form-item label="Apifox 团队">
            <el-select v-model="teamId" filterable aria-label="Apifox 来源团队" @change="changeTeam">
              <el-option v-for="team in connection.teams" :key="team.id" :label="team.name" :value="team.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="Apifox 来源项目">
            <el-select v-model="remoteId" filterable aria-label="Apifox 来源项目" placeholder="请选择要同步的项目">
              <el-option v-for="item in remoteProjects" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
        </div>
        <el-button v-else-if="!busy" @click="open = false; emit('connect')">连接 Apifox</el-button>
      </template>

      <el-form-item v-if="mode === 'file'" label="本地导入目标" class="import-target">
        <el-radio-group v-model="destination" aria-label="本地导入目标">
          <el-radio value="new">新建本地项目</el-radio>
          <el-radio value="existing" :disabled="!projects.length">导入到已有项目</el-radio>
        </el-radio-group>
      </el-form-item>
      <template v-if="mode === 'file' && destination === 'existing'">
        <el-select v-model="targetId" filterable aria-label="本地目标项目" placeholder="选择本地目标项目">
          <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
        </el-select>
        <p class="import-note">保留原有接口，跳过同方法、同路径的接口。</p>
      </template>
      <section v-if="destination === 'batch' && repository" class="import-preview" aria-label="仓库同步预览">
        <header><strong>{{ repository.projects.length }} 个项目</strong><code>{{ repository.commit.slice(0, 12) }}</code></header>
        <el-table :data="repository.projects" max-height="240">
          <el-table-column label="项目" prop="name" min-width="150" />
          <el-table-column label="文件" prop="file" min-width="155" />
          <el-table-column label="接口" prop="operationCount" width="64" />
        </el-table>
        <p class="import-note">已有相同仓库来源的项目会更新为此提交中的接口目录。</p>
      </section>
      <section v-if="prepared" class="import-preview" :aria-label="prepared.sync ? '接口同步预览' : '接口导入预览'">
        <header><strong>{{ prepared.source }}</strong><span aria-hidden="true">→</span><strong>{{ prepared.create ? name : prepared.targetName }}</strong></header>
        <el-form-item v-if="prepared.create" label="新项目名称" required>
          <el-input v-model="name" maxlength="120" aria-label="新项目名称" />
        </el-form-item>
        <dl class="import-counts">
          <div><dt>新增接口</dt><dd>{{ prepared.added }}</dd></div>
          <template v-if="prepared.sync && !prepared.create">
            <div><dt>更新接口</dt><dd>{{ prepared.sync.updated }}</dd></div>
            <div><dt>从 5288 移除</dt><dd>{{ prepared.sync.removed }}</dd></div>
          </template>
          <div v-else-if="!prepared.create"><dt>重复，保留已有</dt><dd>{{ prepared.skipped }}</dd></div>
          <div><dt>{{ prepared.sync ? '同步后接口数' : '导入后接口数' }}</dt><dd>{{ prepared.operationCount }}</dd></div>
        </dl>
        <p v-if="prepared.sync?.omittedRequestBodies" class="import-note">已略过 {{ prepared.sync.omittedRequestBodies }} 个未被接口使用的失效请求体定义。</p>
      </section>
    </el-form>
    <template #footer>
      <el-button :disabled="locked" @click="open = false">取消</el-button>
      <el-button v-if="destination !== 'batch'" :loading="busy" :disabled="locked || !canPreview" @click="preview">{{ mode === 'file' ? '预览导入' : '预览同步' }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="locked || !canSave || fileReading" @click="save">{{ mode !== 'file' ? '同步到 5288' : prepared?.create ? '创建并导入' : '确认导入' }}</el-button>
    </template>
  </el-dialog>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
</template>

<style scoped>
.import-content { color: var(--ui-text); min-width: 0; }
.import-content .el-select { width: 100%; }
.import-fields { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 12px; }
.repository-location { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.repository-location > .el-input { flex: 1; min-width: 0; }
.repository-location > .el-button { flex-shrink: 0; }
.repository-location > .el-button :deep(span) { display: inline-flex; align-items: center; gap: 6px; }
.repository-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.repository-actions > .el-button, .repository-actions > .import-note { margin: 0; }
.import-note + .repository-actions { margin-top: 8px; }
.import-target, .repository-file { margin-top: 16px; }
.import-target { margin-bottom: 8px; }
.import-target .el-radio-group { gap: 4px 16px; }
.import-target .el-radio { margin-right: 0; }
.import-note { margin: 8px 0 0; color: var(--ui-muted); font-size: 12px; line-height: 1.7; }
.file-selection { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.file-selection > span { font-size: 12px; color: var(--ui-muted); overflow-wrap: anywhere; }
.file-input { display: none; }
.import-editor :deep(textarea) { font: 12px/1.65 var(--ds-code, monospace); }
.import-preview { border-top: 1px solid var(--ui-border); margin-top: 16px; padding-top: 14px; }
.import-preview > header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; overflow-wrap: anywhere; }
.import-preview > header > span, .import-preview > header > code { color: var(--ui-muted); }
.import-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 10px; margin: 10px 0 0; }
.import-counts dt { color: var(--ui-muted); font-size: 12px; }
.import-counts dd { font-size: 20px; font-weight: 600; margin: 4px 0 0; }
@media (max-width: 600px) {
  .import-fields { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .import-fields .el-form-item { margin-bottom: 12px; }
  .import-content :deep(.el-radio-button__inner) { padding-inline: 8px; }
}
</style>

<style>
.interface-import-dialog.el-dialog { max-width: calc(100vw - 32px); --el-dialog-margin-top: min(8vh, 64px); }
.interface-import-dialog .el-dialog__body { max-height: min(68vh, 720px); overflow: auto; }
.interface-import-dialog .el-dialog__footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.interface-import-dialog .el-dialog__footer .el-button { margin: 0; }
@media (max-width: 600px) {
  .interface-import-dialog.el-dialog { --el-dialog-margin-top: 4vh; }
  .interface-import-dialog .el-dialog__body { max-height: min(calc(100dvh - 150px), 660px); }
}
</style>
