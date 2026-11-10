<script setup lang="ts">
/** 关联当前群聊的真实产物；只在用户核对具体预览并确认后执行远端写入。 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ExternalLink, RefreshCw } from '@lucide/vue';
import type { GroupRoom } from '../../../shared/agent-group-chat';
import type { RemoteDeliveryKind, RemoteDeliveryPreview, RemoteDeliverySubmit } from '../../../shared/agent-remote-delivery';
import { dateTime, safeUrl, shortPath } from '../../shared/format';
import { createRequestId } from '../requirement-development/request-id';
import { readRemoteDelivery, submitRemoteDelivery } from './group-chat-api';
import AgentCodeArtifact from './AgentCodeArtifact.vue';

const props = defineProps<{ room?: Pick<GroupRoom, 'id'>; targetId?: string; active?: boolean }>();
const deliveryId = computed(() => props.targetId || props.room?.id || '');
const preview = shallowRef<RemoteDeliveryPreview>();
const loading = shallowRef(false), submitting = shallowRef(false), opened = shallowRef(false);
type ArtifactDeliveryKind = Exclude<RemoteDeliveryKind, 'jira'>;
const selected = shallowRef<{ kind: ArtifactDeliveryKind; projectId?: string }>();
const selectedFiles = ref<string[]>([]), message = shallowRef('');
const names = { design: '技术方案', jira: '历史 Jira 评论', git: '代码' };
const tasksOpen = shallowRef(false);
const lastChecked = shallowRef('');
const jiraTasks = computed(() => preview.value?.jiraTasks || (preview.value ? [{ ...preview.value.issue, summary: preview.value.issue.title }] : []));
const jiraRoles: Record<string, string> = { parent: '开发主任务', design: '技术方案', implementation: '实现任务' };
const statusLabels = { submitting: '执行中', completed: '已完成并回读', failed: '未完成', uncertain: '结果待核对' };
const project = computed(() => preview.value?.projects.find(item => item.id === selected.value?.projectId));
const target = computed(() => selected.value?.kind === 'design' ? preview.value?.design : project.value);
const canSubmit = computed(() => !!preview.value && !!selected.value && target.value?.available && !loading.value && !submitting.value
  && (selected.value.kind !== 'git' || !!message.value.trim()));
const requestIds = new Map<string, string>();
function beforeClose(done: () => void) { if (!submitting.value) done(); }
let generation = 0;
let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<boolean> | undefined, controller: AbortController | undefined;
onBeforeUnmount(() => { disposed = true; generation++; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', autoRefresh); });
async function refresh(silent = false): Promise<boolean> {
  if (pending) return pending;
  const roomId = deliveryId.value;
  if (!roomId) return false;
  const current = ++generation;
  controller = new AbortController();
  loading.value = true;
  pending = (async () => {
    try {
      const value = await readRemoteDelivery(roomId, controller!.signal);
      if (current !== generation || roomId !== deliveryId.value || value.roomId !== roomId || disposed) return false;
      preview.value = value; lastChecked.value = new Date().toISOString();
      return true;
    } catch (error) {
      if (!silent && current === generation && !disposed) ElMessage.error(error instanceof Error ? error.message : '读取远端交付预览失败');
      return false;
    } finally { if (current === generation) loading.value = false; }
  })();
  try { return await pending; } finally { pending = undefined; }
}
function canCheck() { return !disposed && !!deliveryId.value && props.active !== false && document.visibilityState === 'visible' && !opened.value && !tasksOpen.value && !submitting.value; }
function autoRefresh() {
  clearTimeout(timer);
  if (!canCheck()) return;
  void refresh(true).finally(() => { clearTimeout(timer); if (canCheck()) timer = setTimeout(autoRefresh, 10000); });
}
onMounted(() => { document.addEventListener('visibilitychange', autoRefresh); autoRefresh(); });
watch([() => props.active, deliveryId, opened, tasksOpen, submitting], autoRefresh);
async function open(kind: ArtifactDeliveryKind, projectId?: string) {
  if (loading.value || submitting.value) return;
  if (!await refresh() || !preview.value) return;
  selected.value = { kind, projectId };
  const current = preview.value.projects.find(item => item.id === projectId);
  selectedFiles.value = current?.files.filter(file => file.recommended).map(file => file.path) || [];
  message.value = current?.message || '';
  opened.value = true;
}
async function submit() {
  if (!canSubmit.value || !preview.value || !selected.value || !deliveryId.value) return;
  const input = { ...selected.value, fingerprint: preview.value.fingerprint,
    ...(selected.value.kind === 'git' ? { files: [...selectedFiles.value], message: message.value.trim() } : {}) };
  const key = JSON.stringify(input), requestId = requestIds.get(key) || createRequestId();
  requestIds.set(key, requestId);
  submitting.value = true;
  try {
    const result = await submitRemoteDelivery(deliveryId.value, { ...input, requestId } satisfies RemoteDeliverySubmit);
    if (result.status === 'completed') ElMessage.success(result.detail || '远端操作已完成并回读');
    else if (result.status === 'uncertain') ElMessage.warning(result.detail || '远端结果待核对，请先查看记录');
    else if (result.status === 'failed') ElMessage.error(result.detail || '远端操作未完成');
    else ElMessage.info('远端操作正在执行，请刷新查看结果');
    opened.value = false;
    await refresh();
  } catch (error) { opened.value = false; ElMessage.error(error instanceof Error ? error.message : '远端交付失败，请刷新核对'); await refresh(); }
  finally { submitting.value = false; }
}
</script>

<template>
  <section class="remote-delivery" aria-label="本轮交付产物">
    <header><strong>交付产物</strong><small>{{ loading ? '检测中…' : lastChecked ? `上次检测 ${new Date(lastChecked).toLocaleTimeString('zh-CN', { hour12: false })}` : '自动检测' }}</small><el-button link :loading="loading" :disabled="submitting || opened || tasksOpen" aria-label="刷新交付产物" @click="refresh()"><RefreshCw :size="13" /></el-button></header>
    <el-skeleton v-if="loading && !preview" :rows="3" animated />
    <template v-if="preview">
      <p class="delivery-issue"><a v-if="safeUrl(preview.issue.url)" :href="safeUrl(preview.issue.url)" target="_blank" rel="noopener noreferrer">{{ preview.issue.key }} <ExternalLink :size="12" /></a><span>{{ preview.issue.title }}</span></p>
      <div class="delivery-artifacts">
        <article class="delivery-artifact" aria-label="Jira 任务产物"><header><strong>Jira 任务</strong><el-button size="small" :disabled="loading || submitting" @click="tasksOpen = true">查看任务 · {{ jiraTasks.length }}</el-button></header><p>{{ jiraTasks.map(item => item.key).join(' · ') }}</p></article>
        <article class="delivery-artifact" aria-label="技术方案产物">
          <header><strong>技术方案</strong><el-button v-if="preview.design.path || !preview.design.url" size="small" :disabled="loading || submitting" @click="open('design')">{{ preview.design.url ? '更新原方案' : '发布技术方案' }}</el-button></header>
          <a v-if="safeUrl(preview.design.url)" :href="safeUrl(preview.design.url)" target="_blank" rel="noopener noreferrer">查看已有方案 <template v-if="preview.design.version">· v{{ preview.design.version }}</template> <ExternalLink :size="12" /></a>
          <p v-if="preview.design.path" :title="preview.design.path">{{ shortPath(preview.design.path) }}</p>
          <p v-else-if="!preview.design.url">暂无本地方案</p>
          <p v-if="preview.design.destination">目标：{{ preview.design.destination.spaceKey }} / {{ preview.design.destination.title || preview.design.destination.parentId }}</p>
          <p v-if="!preview.design.available && (!preview.design.url || preview.design.path)">{{ preview.design.reason }}</p>
        </article>
        <AgentCodeArtifact v-for="item in preview.projects" :key="item.id" :path="item.path" :file-count="item.files.length"
          :branch="item.branch" :remote="item.remote" :url="item.url" push-target>
          <el-button size="small" :disabled="loading || submitting" @click="open('git', item.id)">提交并推送</el-button>
        </AgentCodeArtifact>
        <article v-if="preview.reviewArtifact" class="delivery-artifact" aria-label="需求评审文档">
          <header><strong>需求评审</strong></header>
          <p>{{ preview.reviewArtifact.name }}</p>
          <a :href="preview.reviewArtifact.downloadUrl" :download="preview.reviewArtifact.name" class="artifact-download">下载评审文档</a>
        </article>
        <article v-if="preview.previewLinks?.length" class="delivery-artifact" aria-label="业务页面地址">
          <header><strong>业务页面地址</strong></header>
          <div v-for="link in preview.previewLinks" :key="link.url" class="i18n-artifact">
            <a :href="safeUrl(link.url)" target="_blank" rel="noopener noreferrer" class="artifact-download">{{ link.label }}</a>
            <p>{{ link.evidence }}</p>
          </div>
        </article>
        <article class="delivery-artifact" aria-label="多语言 XLSX 产物"><header><strong>多语言 XLSX</strong></header><template v-if="preview.i18nArtifacts?.length"><div v-for="file in preview.i18nArtifacts" :key="file.id" class="i18n-artifact"><p :title="file.path">{{ shortPath(file.path) }}</p><a :href="file.downloadUrl" :download="file.name" class="artifact-download">下载 XLSX</a></div></template><p v-else>暂无可下载的多语言 XLSX</p></article>
      </div>
      <details v-if="preview.attempts.length" class="delivery-history"><summary>远端操作记录 · {{ preview.attempts.length }}</summary><ul><li v-for="attempt in [...preview.attempts].reverse()" :key="attempt.id"><strong>{{ names[attempt.kind] }} · {{ statusLabels[attempt.status] }}</strong><time>{{ dateTime(attempt.updatedAt) }}</time><p>{{ attempt.detail }}</p><p v-if="attempt.revision">{{ attempt.kind === 'git' ? '提交' : '版本' }}：<code>{{ attempt.revision }}</code></p><a v-if="safeUrl(attempt.url)" :href="safeUrl(attempt.url)" target="_blank" rel="noopener noreferrer">查看远端结果 <ExternalLink :size="12" /></a></li></ul></details>
    </template>
    <el-button v-else-if="!loading" size="small" @click="refresh()">检测交付产物</el-button>
  </section>

  <el-dialog v-model="tasksOpen" title="本轮 Jira 任务" width="min(720px, 94vw)" append-to-body>
    <ul class="delivery-jira-tasks"><li v-for="item in jiraTasks" :key="item.key"><a v-if="safeUrl(item.url)" :href="safeUrl(item.url)" target="_blank" rel="noopener noreferrer">{{ item.key }} <ExternalLink :size="12" /></a><strong v-else>{{ item.key }}</strong><p>{{ item.role && jiraRoles[item.role] ? `${jiraRoles[item.role]} · ` : '' }}{{ item.summary }}</p></li></ul>
    <template #footer><el-button @click="tasksOpen = false">关闭</el-button></template>
  </el-dialog>

  <el-dialog v-model="opened" :title="`确认${selected ? names[selected.kind] : ''}远端交付`" width="min(760px, 94vw)" top="5vh" append-to-body :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" :before-close="beforeClose" class="remote-delivery-dialog">
    <template v-if="preview && selected">
      <p>{{ preview.issue.key }} · {{ preview.issue.title }}</p>
      <template v-if="selected.kind === 'design'">
        <p v-if="safeUrl(preview.design.url)">更新原页面：<a :href="safeUrl(preview.design.url)" target="_blank" rel="noopener noreferrer">{{ preview.design.title }}</a><template v-if="preview.design.version"> · 当前版本 v{{ preview.design.version }}</template></p>
        <p v-if="preview.design.destination">发布到：<a v-if="safeUrl(preview.design.destination.url)" :href="safeUrl(preview.design.destination.url)" target="_blank" rel="noopener noreferrer">{{ preview.design.destination.title || preview.design.destination.parentId }}</a><span v-else>{{ preview.design.destination.title || preview.design.destination.parentId }}</span> · {{ preview.design.destination.spaceKey }}</p>
        <p v-if="preview.design.path">本地文件：{{ preview.design.path }}</p>
        <p>页面标题：{{ preview.design.title }}</p>
        <el-input :model-value="preview.design.body" type="textarea" :rows="14" readonly aria-label="技术方案发布正文" />
      </template>
      <template v-else-if="project">
        <p>工作区：{{ project.path }}</p><p>推送目标：{{ project.remote }} / {{ project.branch }}</p><p>推送地址：{{ project.pushUrl }}</p>
        <p v-if="project.url"><a v-if="safeUrl(project.url)" :href="safeUrl(project.url)" target="_blank" rel="noopener noreferrer">{{ project.url }}</a><span v-else>{{ project.url }}</span></p>
        <p>选择本次提交的文件（{{ selectedFiles.length }}/{{ project.files.length }}）</p>
        <el-checkbox-group v-model="selectedFiles" :disabled="submitting" class="remote-files" aria-label="本次提交文件"><el-checkbox v-for="file in project.files" :key="file.path" :value="file.path"><code>{{ file.status }}</code> {{ file.path }}</el-checkbox></el-checkbox-group>
        <p v-if="!project.files.length">工作区没有待提交文件，将核对并推送当前任务分支。</p>
        <label class="remote-commit-label" for="remote-commit-message">提交说明</label><el-input id="remote-commit-message" v-model="message" :disabled="submitting" maxlength="2000" type="textarea" :rows="2" aria-label="Git 中文提交说明" />
      </template>
      <p v-if="target && !target.available" class="remote-reason">{{ target.reason }}</p>
    </template>
    <template #footer><el-button :disabled="submitting" @click="opened = false">取消</el-button><el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">{{ selected?.kind === 'design' ? preview?.design.url ? '确认更新原方案' : '确认发布技术方案' : '确认提交并推送' }}</el-button></template>
  </el-dialog>
</template>

<style scoped>
.remote-delivery{margin:0;padding:14px 0;color:var(--agent-secondary);font-size:12px;line-height:1.7;min-width:0}.remote-delivery>header{display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:6px}.remote-delivery>header small{margin-left:auto;color:var(--agent-muted);font-size:10px}.remote-delivery>header strong{font-size:13px;color:var(--agent-text)}.delivery-issue{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px}.remote-delivery a{display:inline-flex;align-items:center;gap:4px;color:var(--agent-accent);text-decoration:none}.delivery-links{margin:10px 0}.delivery-links>div{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px;margin:12px 0}.delivery-links dt{color:var(--agent-muted)}.delivery-links dd{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0;overflow-wrap:anywhere}.delivery-links dd>span{min-width:0;overflow-wrap:anywhere}.delivery-history>summary{cursor:pointer;color:var(--agent-muted)}.delivery-history ul{list-style:none;padding:0}.delivery-history li{padding:8px 0}.delivery-history time{margin-left:12px;color:var(--agent-muted);font-size:11px}.delivery-history p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.remote-files{display:flex;flex-direction:column;max-height:240px;overflow:auto;margin:8px 0 14px}.remote-files :deep(.el-checkbox){height:auto;min-height:28px;align-items:baseline;white-space:normal;margin-right:0}.remote-files :deep(.el-checkbox__label){white-space:normal;overflow-wrap:anywhere}.remote-files code{margin-right:6px}.remote-commit-label{display:block;margin:14px 0 6px}.remote-reason{margin-top:12px}.remote-delivery-dialog p{overflow-wrap:anywhere}.remote-delivery-dialog a{color:var(--ui-accent)}
.delivery-artifacts{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin:12px 0}.delivery-artifact{min-width:0;padding:12px;border:1px solid var(--agent-border);border-radius:8px}.delivery-artifact>header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.delivery-artifact>header strong{color:var(--agent-text);font-size:12px}.delivery-artifact p{margin:8px 0;overflow-wrap:anywhere}.i18n-artifact+.i18n-artifact{margin-top:12px}.artifact-download{font-size:12px}.delivery-jira-tasks{list-style:none;margin:0;padding:0}.delivery-jira-tasks li{padding:12px 0;border-bottom:1px solid var(--ui-border)}.delivery-jira-tasks p{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.delivery-jira-tasks a{display:inline-flex;align-items:center;gap:5px;color:var(--ui-accent);text-decoration:none}
:global(.remote-delivery-dialog .el-dialog__body){max-height:calc(90vh - 120px);overflow:auto}
@media(max-width:700px){.remote-delivery{margin-left:0}.delivery-artifacts{grid-template-columns:1fr}.delivery-links>div{grid-template-columns:1fr;gap:3px}}
</style>
