<script setup lang="ts">
/** 只收集本机需求资料，选择器回填目录与分支后向容器提交值；不创建 Jira 或执行任务。 */
import { reactive, shallowRef, watch } from 'vue';
import { createRequestInput, normalizeIssueKey, validateInput, type DesignInput } from './domain';
import { useWorkspacePicker } from './useWorkspacePicker';
import WorkspaceBrowserDialog from '../../shared/ui/WorkspaceBrowserDialog.vue';
import { ElMessage } from 'element-plus';
const props = defineProps<{ initial?: DesignInput; editing: boolean; error: string }>();
const emit = defineEmits<{ save: [input: DesignInput, start: boolean] }>();
const visible = defineModel<boolean>({ default: false });
const form = reactive(createRequestInput());
const errors = shallowRef<string[]>([]);
const { selecting, error: workspaceError, choose, browserOpen, browserPath, completeBrowser } = useWorkspacePicker();
watch(visible, (open) => { if (open) { Object.assign(form, createRequestInput(props.initial)); errors.value = []; workspaceError.value = ''; } });
async function selectWorkspace() {
  const result = await choose(form.workspacePath);
  if (!result || !visible.value) return;
  form.workspacePath = result.workspacePath;
  form.branch = result.branch;
  if (result.branch) ElMessage.success(result.message);
  else ElMessage.warning(result.message);
}
function submit(start = false) {
  if (selecting.value) return;
  const input = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])) as DesignInput;
  errors.value = validateInput(input);
  if (start && (!input.jiraStartDate || !input.jiraEndDate)) errors.value.push('全自动执行前必须填写 Jira 开始日期和结束日期');
  if (start && (!input.workspacePath.trim() || !input.confluenceParentUrl.trim())) errors.value.push('全自动执行前必须填写本地工作区和 Confluence 目标目录');
  if (!errors.value.length) emit('save', { ...input, issueKey: normalizeIssueKey(input.issueKey) }, start);
}
</script>

<template>
  <el-dialog v-model="visible" :title="editing ? '编辑任务输入' : '新建执行任务'" width="min(840px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!selecting" :close-on-press-escape="!selecting" class="design-form-dialog">
    <p class="form-notice">填写 Jira 事项、计划日期、工作区和准确的 Confluence 目录即可启动。版本与 PRD 可从 Jira 自动读取；无法核实时暂停。计划日期为启动必填，草稿可暂不填写。仅保存草稿不会执行，启动前会确认文档发布与 Jira 建单授权。</p>
    <el-alert v-if="errors.length || error || workspaceError" type="error" :title="[...errors, error, workspaceError].filter(Boolean).join('；')" :closable="false" show-icon />
    <el-form label-position="top" @submit.prevent="submit(false)">
      <div class="form-grid">
        <el-form-item label="Jira 事项 Key / 链接" required><el-input v-model="form.issueKey" :disabled="editing" placeholder="需求或现有方案任务，例如 APEX-123" maxlength="500" /></el-form-item>
        <el-form-item label="Jira 项目 Key"><el-input v-model="form.project" placeholder="例如 APEX；留空则从原需求读取" maxlength="120" /><p class="directory-hint">决定 DEV 父任务和两个子任务创建在哪个 Jira 项目中；不是项目名称或仓库名称。</p></el-form-item>
        <el-form-item label="任务名称" required class="form-wide"><el-input v-model="form.title" placeholder="例如：生成商家账户同步前端技术方案" maxlength="300" /></el-form-item>
        <el-form-item label="Fix Version"><el-input v-model="form.fixVersion" placeholder="与原需求完全一致，不自动新建版本" maxlength="200" /></el-form-item>
        <el-form-item label="负责人"><el-input v-model="form.assignee" placeholder="待 Jira 当前用户回读核实" maxlength="120" /></el-form-item>
        <el-form-item label="Jira 开始日期" required><el-date-picker v-model="form.jiraStartDate" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" placeholder="选择目标开始日期" style="width:100%" /></el-form-item>
        <el-form-item label="Jira 结束日期" required><el-date-picker v-model="form.jiraEndDate" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" placeholder="选择目标结束日期" style="width:100%" /></el-form-item>
        <el-form-item label="PRD 链接"><el-input v-model="form.prdUrl" placeholder="https://…；或在资料说明中记录附件" maxlength="2000" /></el-form-item>
        <el-form-item label="原型 / 截图来源链接"><el-input v-model="form.prototypeUrl" placeholder="可选；截图路径可记在资料说明中" maxlength="2000" /></el-form-item>
        <el-form-item label="本地工作区"><el-input :model-value="form.workspacePath" readonly placeholder="请选择电脑上的仓库文件夹"><template #append><el-button :loading="selecting" @click="selectWorkspace">{{ form.workspacePath ? '重新选择' : '选择文件夹' }}</el-button></template></el-input><p class="directory-hint">{{ selecting ? '请在目录选择窗口选择或取消，选择完成后会自动回填。' : '仅记录本机路径，不上传文件；选择后自动读取当前分支。' }}</p></el-form-item>
        <el-form-item label="目标分支"><el-input v-model="form.branch" placeholder="填写已确认的实际分支" maxlength="300" /></el-form-item>
        <el-form-item label="Confluence 目标目录" class="form-wide"><el-input v-model="form.confluenceParentUrl" placeholder="准确的父页面链接，不能凭示例标题猜目录" maxlength="2000" /><p class="directory-hint">填写你有权限发布的准确父页面链接；执行前会核验目标目录。</p></el-form-item>
        <el-form-item label="资料说明 / 范围 / 待决问题" class="form-wide"><el-input v-model="form.notes" type="textarea" :rows="3" placeholder="补充方案范围、附件路径和需要澄清的问题。这里不执行产品开发，请勿填写密钥或密码。" maxlength="12000" show-word-limit /></el-form-item>
      </div>
    </el-form>
    <template #footer><el-button :disabled="selecting" @click="visible = false">取消</el-button><el-button :disabled="selecting" @click="submit(false)">保存草稿</el-button><el-button type="primary" :disabled="selecting" @click="submit(true)">确认并启动执行</el-button></template>
  </el-dialog>
  <WorkspaceBrowserDialog :open="browserOpen" :initial-path="browserPath" @select="completeBrowser" @cancel="completeBrowser(null)" />
</template>

<style scoped>
.directory-hint{margin:6px 0 0;font-size:12px;line-height:1.7;color:var(--ui-secondary)}.directory-hint a{color:var(--ui-accent)}
.form-notice{font-size:12px;color:var(--ui-secondary);line-height:1.9;margin:0 0 18px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px;margin-top:16px}.form-wide{grid-column:1/-1}@media(max-width:600px){.form-grid{grid-template-columns:minmax(0,1fr)}}
</style>
