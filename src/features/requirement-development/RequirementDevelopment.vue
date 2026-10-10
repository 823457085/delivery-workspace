<script setup lang="ts">
/** 需求入口只收集授权与显示真实会话状态；开发复用 Agent，不挂载旧版方案流程或复制旧领取链。 */
import { computed, reactive, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { requirementDevelopmentInputSchema, type RequirementDevelopmentInput, type RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import type { AgentRunStatus } from '../../../shared/agent-runtime';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import { createRequestId } from './request-id';
import { dateTime } from '../../shared/format';

const emit = defineEmits<{ openRun: [id: string] }>();
const storageKey = 'qiyuan:requirement-development:v1';
const form = reactive<RequirementDevelopmentInput>({ title: '', issueKey: '', prdUrl: '', requirement: '', project: '', fixVersion: '', assignee: '',
  startDate: '', endDate: '', repository: '', parentDirectory: '', branch: 'feature/', confluenceParentUrl: '' });
const requestId = shallowRef<string>(createRequestId());
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (saved?.input) for (const key of Object.keys(form) as (keyof RequirementDevelopmentInput)[]) {
    if (typeof saved.input[key] === 'string') form[key] = saved.input[key];
  }
  if (/^[0-9a-f-]{36}$/.test(saved?.requestId || '')) requestId.value = saved.requestId;
} catch { /* 不因本机草稿不可读而阻止填写。 */ }
watch(form, () => {
  requestId.value = createRequestId();
  try { localStorage.setItem(storageKey, JSON.stringify({ input: form, requestId: requestId.value })); } catch { /* 当前表单仍可提交。 */ }
}, { flush: 'sync' });
const pending = shallowRef(false);
const picker = useWorkspacePicker();
type RecordView = RequirementDevelopmentRecord & { runStatus?: AgentRunStatus; runError: string };
const query = useQuery({ queryKey: ['requirement-development'], retry: false,
  queryFn: async (): Promise<RecordView[]> => {
    const response = await fetch('/api/agent-runtimes/requirement-development');
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载需求开发功能，需要在当前任务结束后重启本地服务。' : result.message || '需求开发记录读取失败');
    return result.records;
  }, refetchInterval: q => q.state.data?.some(item => ['preparing', 'starting'].includes(item.status) || ['queued', 'running'].includes(item.runStatus || '')) ? 2000 : 15000,
});
const records = computed(() => query.data.value || []);
const statusLabels: Record<AgentRunStatus, string> = { queued: '会话排队中', running: '开发会话执行中', completed: '本轮已结束 · 查看结果', failed: '本轮失败', interrupted: '已中断', cancelled: '已取消' };
function status(record: RecordView) {
  if (record.runStatus) return statusLabels[record.runStatus];
  return { preparing: '正在拉取代码', starting: '正在创建会话', started: '已创建开发会话', failed: '启动失败', uncertain: '需核对启动结果' }[record.status];
}
async function chooseDirectory() {
  const selection = await picker.choose(form.parentDirectory);
  if (selection) form.parentDirectory = selection.workspacePath;
  else if (picker.error.value) ElMessage.error(picker.error.value);
}
async function start() {
  if (pending.value) return;
  const parsed = requirementDevelopmentInputSchema.safeParse(form);
  if (!parsed.success) { ElMessage.warning(parsed.error.issues[0]?.message || '请补齐需求资料'); return; }
  const input = parsed.data;
  const id = requestId.value;
  pending.value = true;
  try {
    try {
      await ElMessageBox.confirm(`将从 ${input.repository} 的 master 拉取代码到 ${input.parentDirectory} 下的新目录，创建 ${input.branch} 分支并启动 GPT-6 Astra / 超高开发会话。默认完全访问权限，可访问工作区外的本机文件和网络。授权该会话读取需求、创建或复用关联 Jira 任务、编写方案、将开发任务流转为开发中并实现验证，验证通过后转待测试/待评审。${input.confluenceParentUrl ? '同时授权在指定 Confluence 目录发布本需求方案。' : '方案仅保存到本地。'}任务范围仍限于本次需求，不修改原有检出，不提交、推送、合并、部署或关闭原需求。`, '确认启动需求开发',
        { type: 'warning', confirmButtonText: '确认并开始开发', cancelButtonText: '取消', closeOnClickModal: false });
    } catch { return; }
    const response = await fetch('/api/agent-runtimes/requirement-development', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ requestId: id, input, authorization: 'create-jira-design-transition-and-develop' }) });
    const result = await response.json() as RequirementDevelopmentRecord & { message?: string };
    if (!response.ok) throw new Error(result.message || '启动请求失败');
    if (result.runId) emit('openRun', result.runId);
    else ElMessage.warning(result.error || '正在准备，请查看启动记录');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '请求中断，请先核对启动记录；再次点击会复用原请求');
  } finally { pending.value = false; void query.refetch(); }
}
</script>

<template>
  <section class="requirement-development">
    <header class="development-heading"><div><h2>需求开发</h2><p>从需求到代码，在启元会话中连续推进。</p></div><span>Codex CLI · GPT-6 Astra · 超高 · 完全访问</span></header>
    <ol class="development-flow" aria-label="需求开发流程"><li>读取 PRD / Jira</li><li>创建关联任务</li><li>编写技术方案</li><li>流转开发状态</li><li>功能开发</li><li>验证与回读</li></ol>
    <el-form label-position="top" class="development-form" :disabled="pending" @submit.prevent="start">
      <div class="form-grid">
        <el-form-item label="需求名称" required><el-input v-model="form.title" placeholder="要实现什么功能" maxlength="300" /></el-form-item>
        <el-form-item label="需求 Jira Key / 链接"><el-input v-model="form.issueKey" placeholder="例如 APEX-123；也可只提供 PRD 或需求正文" /></el-form-item>
        <el-form-item label="PRD 链接" class="wide"><el-input v-model="form.prdUrl" placeholder="https://…" maxlength="2000" /></el-form-item>
        <el-form-item label="需求正文 / 补充范围" class="wide"><el-input v-model="form.requirement" type="textarea" :rows="3" placeholder="需求 Jira、PRD、需求正文至少填写一项。请勿填写密码或令牌。" maxlength="20000" /></el-form-item>
        <el-form-item label="Git 仓库地址" required><el-input v-model="form.repository" placeholder="git@host:group/repo.git 或 https://host/group/repo.git" /></el-form-item>
        <el-form-item label="本地保存目录" required><el-input v-model="form.parentDirectory" placeholder="选择现有父目录，将在其中新建独立文件夹"><template #append><el-button :loading="picker.selecting.value" @click="chooseDirectory">选择目录</el-button></template></el-input></el-form-item>
        <el-form-item label="开发分支（基于远端 master）" required><el-input v-model="form.branch" placeholder="feature/APEX-123" /></el-form-item>
        <el-form-item label="Jira 项目 Key" :required="!form.issueKey"><el-input v-model="form.project" placeholder="例如 APEX；有需求 Jira 时可从原事项读取" /></el-form-item>
        <el-form-item label="计划开始日期" required><el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" /></el-form-item>
        <el-form-item label="计划结束日期" required><el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" /></el-form-item>
      </div>
      <details><summary>版本、负责人和方案发布目录（可选）</summary><div class="form-grid optional-fields">
        <el-form-item label="Fix Version"><el-input v-model="form.fixVersion" placeholder="留空时从需求核验，不猜测版本" /></el-form-item>
        <el-form-item label="负责人"><el-input v-model="form.assignee" placeholder="留空时读取当前 Jira 用户" /></el-form-item>
        <el-form-item label="Confluence 目标父页面" class="wide"><el-input v-model="form.confluenceParentUrl" placeholder="留空仅在本地 docs/requirements/ 编写技术方案" /></el-form-item>
      </div></details>
      <footer><p>先准备独立代码目录，再在开发会话中处理 Jira、方案与实现；原工作区及未提交改动保持不变。</p><el-button native-type="submit" type="primary" :loading="pending" :disabled="query.isPending.value || !!query.error.value">{{ pending ? '正在准备开发会话' : '创建会话并开始开发' }}</el-button></footer>
    </el-form>
    <section class="development-records"><header><h3>开发启动记录</h3><el-button :loading="query.isFetching.value" @click="query.refetch()">刷新</el-button></header>
      <p v-if="query.error.value">{{ query.error.value.message }}</p>
      <el-empty v-else-if="!records.length && !query.isPending.value" description="尚未启动需求开发" :image-size="48" />
      <article v-for="record in records" :key="record.id"><div><strong>{{ record.input.title }}</strong><span>{{ status(record) }}</span><small>{{ dateTime(record.createdAt) }} · {{ record.input.branch }}</small><small>{{ record.workspacePath || record.input.parentDirectory }}</small><p v-if="record.error || record.runError">{{ record.error || record.runError }}</p></div><el-button v-if="record.runId" @click="emit('openRun', record.runId)">打开开发会话</el-button></article>
    </section>
  </section>
  <WorkspaceBrowserDialog :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
</template>

<style scoped>
.requirement-development{max-width:1200px;margin:0 auto;color:var(--ui-text)}
.development-heading,.development-records header{display:flex;align-items:center;justify-content:space-between;gap:16px}.development-heading h2{margin:0;font-size:22px}.development-heading p,.development-heading span{font-size:13px;color:var(--ui-secondary)}
.development-flow{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;list-style-position:inside;padding:18px 0;margin:10px 0;color:var(--ui-secondary);font-size:13px;border-block:1px solid var(--ui-border)}
.development-form{padding:20px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-surface)}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}.wide{grid-column:1/-1}.optional-fields{margin-top:18px}summary{cursor:pointer;font-size:13px;color:var(--ui-secondary)}footer{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:20px}footer p{font-size:12px;color:var(--ui-secondary);line-height:1.8;margin:0}
.development-records{margin-top:24px}.development-records h3{font-size:15px}.development-records article{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 0;border-bottom:1px solid var(--ui-border)}article strong{font-size:14px}article span{font-size:12px;margin-left:16px;color:var(--ui-accent)}article small{display:block;color:var(--ui-secondary);margin-top:6px;overflow-wrap:anywhere}article p{font-size:12px;line-height:1.7}
@media(max-width:800px){.form-grid{grid-template-columns:1fr}.development-flow{grid-template-columns:repeat(3,1fr)}.development-heading,footer{align-items:flex-start;flex-direction:column}}
</style>
