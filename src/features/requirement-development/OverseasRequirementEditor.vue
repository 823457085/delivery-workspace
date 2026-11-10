<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import { overseasI18nLabels, overseasStageLabels, overseasSystemStatusLabels,
  overseasRequirementPayload, overseasRequirementSaveSchema, type OverseasRequirement } from '../../../shared/overseas-requirements';
import type { RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import type { JiraDevIssueView } from '../../../shared/jira-dev';
import type { GroupRoomSummary } from '../../../shared/agent-group-chat';
import { jiraDevRequest, parseJiraSource } from '../jira-dev/useJiraDevTask';

const props = defineProps<{ item: OverseasRequirement; records: RequirementDevelopmentRecord[]; groups: GroupRoomSummary[]; systemOptions: string[] }>();
const emit = defineEmits<{ close: []; saved: [item: OverseasRequirement] }>();
const draft = ref<OverseasRequirement>(JSON.parse(JSON.stringify(props.item)));
draft.value.groupRoomIds ||= [];
const source = shallowRef(draft.value.issueUrl || draft.value.issueKey);
const saving = shallowRef(false), reading = shallowRef(false);
const selectedSystems = computed({ get: () => draft.value.systems.map(item => item.name), set: (names: string[]) => {
  draft.value.systems = names.map(name => draft.value.systems.find(item => item.name === name)
    || { name, status: 'pending', evidence: '', previewUrl: '' });
} });
const systems = computed(() => [...new Set([...props.systemOptions, ...selectedSystems.value])]);
const executions = computed(() => [
  ...props.records.map(record => ({ id: record.id, title: record.input.title })),
  ...draft.value.executionIds.filter(id => !props.records.some(record => record.id === id)).map(id => ({ id, title: `任务预览 · ${id}` })),
]);
function applySource() {
  const value = source.value.trim();
  if (value === (draft.value.issueUrl || draft.value.issueKey)) return;
  const parsed = parseJiraSource(value);
  draft.value.issueKey = parsed?.key || '';
  draft.value.issueUrl = parsed && /^https?:\/\//i.test(value) ? value : '';
  draft.value.jiraStatus = '';
}
async function readIssue() {
  if (reading.value || saving.value) return;
  if (!parseJiraSource(source.value)) { ElMessage.warning('请填写有效的 Jira Key 或事项链接'); return; }
  reading.value = true;
  try {
    const { issue } = await jiraDevRequest<{ issue: JiraDevIssueView }>('issue', { source: source.value.trim() });
    Object.assign(draft.value, { title: issue.summary, issueKey: issue.key, issueUrl: issue.url, jiraStatus: issue.status || '',
      description: typeof issue.description === 'string' ? issue.description : issue.description ? JSON.stringify(issue.description, null, 2) : '',
      version: (issue.fixVersions || []).map(version => version.name).join('、'), startDate: issue.startDate || '', endDate: issue.endDate || '' });
    source.value = issue.url || issue.key;
    ElMessage.success('已读取 Jira，请核对需求信息后保存');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Jira 读取失败'); }
  finally { reading.value = false; }
}
async function save() {
  if (saving.value || reading.value) return;
  applySource();
  if (source.value.trim() && !parseJiraSource(source.value)) { ElMessage.warning('请填写有效的 Jira Key 或事项链接'); return; }
  // 日期选择器清空时返回 null，持久化契约统一为空字符串。
  draft.value.startDate ||= ''; draft.value.endDate ||= '';
  const parsed = overseasRequirementSaveSchema.safeParse(overseasRequirementPayload(draft.value));
  if (!parsed.success) { ElMessage.warning(parsed.error.issues[0]?.message || '请核对需求信息'); return; }
  saving.value = true;
  try {
    const response = await fetch('/api/overseas-requirements', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(parsed.data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '需求保存失败');
    emit('saved', result); ElMessage.success('需求已保存');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '需求保存失败，草稿已保留'); }
  finally { saving.value = false; }
}
</script>

<template>
  <el-drawer :model-value="true" :title="item.revision || item.executionIds.length ? '编辑需求' : '新建海外需求'" size="min(760px, 100vw)"
    :close-on-click-modal="false" :close-on-press-escape="!saving && !reading" :show-close="!saving && !reading" @close="emit('close')">
    <el-form label-position="top" class="requirement-editor" :disabled="saving || reading" @submit.prevent="save">
      <div class="source-row"><el-form-item label="Jira Key / 链接（可选）"><el-input v-model="source" placeholder="Jira Key 或完整事项链接" maxlength="2000" @change="applySource" /></el-form-item><el-button :loading="reading" :disabled="!source.trim()" @click="readIssue">读取 Jira</el-button></div>
      <el-form-item label="需求名称" required><el-input v-model="draft.title" maxlength="300" /></el-form-item>
      <el-form-item label="涉及系统"><el-select v-model="selectedSystems" multiple filterable allow-create default-first-option placeholder="选择或输入系统名称，支持多个系统"><el-option v-for="name in systems" :key="name" :value="name" :label="name" /></el-select></el-form-item>
      <div class="two-fields"><el-form-item label="需求阶段"><el-select v-model="draft.stage"><el-option v-for="(label, value) in overseasStageLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item><el-form-item label="负责人"><el-input v-model="draft.owner" maxlength="120" /></el-form-item></div>
      <div class="two-fields"><el-form-item label="版本"><el-input v-model="draft.version" maxlength="200" /></el-form-item><el-form-item label="计划开始日期"><el-date-picker v-model="draft.startDate" type="date" value-format="YYYY-MM-DD" clearable /></el-form-item></div>
      <div class="two-fields"><el-form-item label="计划结束日期"><el-date-picker v-model="draft.endDate" type="date" value-format="YYYY-MM-DD" clearable /></el-form-item><el-form-item label="关联开发记录"><el-select v-model="draft.executionIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择已有开发记录"><el-option v-for="record in executions" :key="record.id" :value="record.id" :label="record.title" /></el-select></el-form-item></div>
      <div class="two-fields"><el-form-item label="PRD 链接"><el-input v-model="draft.prdUrl" maxlength="2000" /></el-form-item><el-form-item label="原型链接"><el-input v-model="draft.prototypeUrl" maxlength="2000" /></el-form-item></div>
      <el-form-item label="关联团队群聊"><el-select v-model="draft.groupRoomIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="关联已有群聊，继续跟进原任务"><el-option v-for="group in groups" :key="group.id" :value="group.id" :label="group.title" /><el-option v-for="id in draft.groupRoomIds.filter(id => !groups.some(group => group.id === id))" :key="id" :value="id" :label="`群聊暂不可读取 · ${id}`" /></el-select></el-form-item>
      <el-form-item label="需求正文 / 验收标准"><el-input v-model="draft.description" type="textarea" :rows="5" maxlength="20000" /></el-form-item>
      <el-form-item label="当前阻塞"><el-input v-model="draft.blocker" type="textarea" :rows="2" maxlength="4000" placeholder="填写阻塞原因、依赖及下一步；无阻塞时留空" /></el-form-item>
      <h3>系统交付</h3>
      <section v-for="system in draft.systems" :key="system.name" class="system-editor">
        <div class="system-heading"><strong>{{ system.name }}</strong><el-select v-model="system.status" :aria-label="`${system.name} 交付状态`"><el-option v-for="(label, value) in overseasSystemStatusLabels" :key="value" :value="value" :label="label" /></el-select></div>
        <el-form-item :label="`${system.name} 验证证据`"><el-input v-model="system.evidence" type="textarea" :rows="2" maxlength="4000" placeholder="实际验证场景、结果和证据位置" /></el-form-item>
        <el-form-item :label="`${system.name} 预览地址`"><el-input v-model="system.previewUrl" maxlength="2000" placeholder="实际可访问的业务页面链接" /></el-form-item>
      </section>
      <h3>多语言交付</h3>
      <el-form-item label="多语言状态"><el-select v-model="draft.i18n.status"><el-option v-for="(label, value) in overseasI18nLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
      <el-form-item label="多语言产物与验证证据"><el-input v-model="draft.i18n.evidence" type="textarea" :rows="2" maxlength="4000" placeholder="词条、导入表位置、导入与页面验证结果" /></el-form-item>
      <el-form-item label="人工验收结论与证据"><el-input v-model="draft.acceptanceEvidence" type="textarea" :rows="2" maxlength="4000" /></el-form-item>
    </el-form>
    <template #footer><el-button :disabled="saving || reading" @click="emit('close')">取消</el-button><el-button type="primary" :loading="saving" :disabled="reading" @click="save">保存需求</el-button></template>
  </el-drawer>
</template>

<style scoped>
.requirement-editor{color:var(--ui-text)}.requirement-editor :deep(.el-select),.requirement-editor :deep(.el-date-editor){width:100%}.source-row{display:flex;align-items:flex-end;gap:10px}.source-row .el-form-item{flex:1;min-width:0}.source-row>.el-button{margin-bottom:18px}.two-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.requirement-editor h3{margin:24px 0 16px;padding-top:18px;border-top:1px solid var(--ui-divider);font-size:15px}.system-editor{padding:0 0 12px;margin-bottom:16px;border-bottom:1px solid var(--ui-divider)}.system-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.system-heading :deep(.el-select){width:150px}@media(max-width:550px){.two-fields{grid-template-columns:1fr}}
</style>
