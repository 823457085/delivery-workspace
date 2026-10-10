<script setup lang="ts">
/** 例会快照与浏览器草稿分离；原文不会因编辑自动同步，Confluence 写回另行确认。 */
import { computed, ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { MeetingData, MeetingTask } from '../../../shared/hub';
import { useSource, useSourceActions } from '../../shared/api';
import { safeUrl, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
import FullRecord from '../../shared/ui/FullRecord.vue';
const query = useSource<MeetingData>('meeting');
const { data, isPending, isFetching, error } = query;
const actions = useSourceActions();
interface Draft { text: string; updatedAt: string; verified: boolean; syncedAt?: string }
const storageKey = 'delivery-workspace:meeting-drafts:v1';
function readDrafts(): Record<string, Draft> { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } }
const drafts = ref(readDrafts());
const selected = shallowRef<MeetingTask>(), visible = shallowRef(false), editor = shallowRef(''), syncing = shallowRef(false);
const selectedDraftKey = shallowRef('');
const draftKey = (task: MeetingTask) => `${data.value?.localDate}:${task.id}`;
const draftFor = (task: MeetingTask) => drafts.value[draftKey(task)];
const textFor = (task: MeetingTask) => draftFor(task)?.text ?? task.sourceText;
const lanes = computed(() => [{ title: '今日待验证', tasks: data.value?.todayTasks || [], note: '核对来源后填写本地草稿' }, { title: '明日待完成', tasks: data.value?.tomorrowTasks || [], note: '保留来源日期，不自动顺延或判定完成' }]);
const metrics = computed(() => [
  { label: '今日来源任务', value: data.value?.todayTasks.length, note: data.value?.sectionTitle || '等待读取' },
  { label: '明日来源任务', value: data.value?.tomorrowTasks.length, note: '直接使用例会扫描结果' },
  { label: '来源页面版本', value: data.value?.source.version, note: `快照日期 ${data.value?.localDate || '—'}` },
  { label: '来源告警', value: data.value?.warnings.length, note: '缺少日报内容时不生成假任务', tone: 'warning' },
]);
function inspect(task: MeetingTask) { if (syncing.value) return; selected.value = task; selectedDraftKey.value = draftKey(task); editor.value = textFor(task); visible.value = true; }
function saveDraft(verified = false, syncedAt?: string) {
  if (!selected.value) return;
  drafts.value[selectedDraftKey.value] = { text: editor.value, verified, updatedAt: new Date().toISOString(), ...(syncedAt ? { syncedAt } : {}) };
  try { localStorage.setItem(storageKey, JSON.stringify(drafts.value)); ElMessage.success(syncedAt ? '已记录来源同步结果' : '草稿保存在当前浏览器，未写回 Confluence'); } catch { ElMessage.error('浏览器存储不可用，草稿尚未持久保存'); }
}
async function copyToday() { try { await navigator.clipboard.writeText((data.value?.todayTasks || []).map((task, index) => `${index + 1}. ${textFor(task)}`).join('\n')); ElMessage.success('已复制今日任务'); } catch { ElMessage.error('剪贴板不可用，请从任务详情复制'); } }
async function sync() {
  if (!selected.value || !data.value || syncing.value || !editor.value.trim()) return;
  syncing.value = true;
  try { const ok = await actions.execute('meeting-sync', { pageId: data.value.source.pageId, taskId: selected.value.id, text: editor.value }, '确认写回 Confluence 例会', `这会修改真实页面“${data.value.source.title}”中的该条任务原文；本地草稿保存不需要此操作。`); if (ok) saveDraft(true, new Date().toISOString()); } finally { syncing.value = false; }
}
</script>
<template>
  <PageHeading title="例会任务" description="Confluence 来源快照、本地校对草稿和显式同步；不将空快照误显示成已完成。" :loading="isFetching" @refresh="query.refetch()"><el-button :disabled="!data?.todayTasks.length" @click="copyToday">复制今日任务</el-button><a v-if="safeUrl(data?.source.url)" class="hub-link" :href="safeUrl(data?.source.url)" target="_blank">打开 Confluence ↗</a></PageHeading>
  <MetricStrip :items="metrics" />
  <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()"><template v-if="data"><el-alert v-for="warning in data.warnings" :key="warning" class="section-alert" :title="warning" :description="`当前展示 ${data.localDate} 的原快照，扫描于 ${dateTime(data.scannedAt)}。刷新这里只重新读取快照，不会触发 Confluence 抓取或同步。`" type="warning" :closable="false" show-icon /><div class="meeting-source surface"><div><h2>{{ data.source.title }}</h2><p>{{ data.sectionTitle }} · {{ data.assignee.name }} · {{ data.schedule }}</p></div><span>v{{ data.source.version }} / {{ data.localDate }}</span></div><div class="meeting-lanes"><section v-for="lane in lanes" :key="lane.title" class="surface"><div class="surface-header"><div><h2>{{ lane.title }}</h2><p>{{ lane.note }}</p></div><span class="row-secondary">{{ lane.tasks.length }} 项</span></div><div class="surface-body"><article v-for="task in lane.tasks" :key="task.id" class="meeting-task"><pre>{{ textFor(task) }}</pre><p>{{ task.dueText || '来源未标注日期' }} <span v-if="draftFor(task)">· {{ draftFor(task)?.verified ? '人工已核对' : '有本地草稿' }}</span></p><el-button type="primary" link @click="inspect(task)">查看 / 校对完整内容</el-button></article><el-empty v-if="!lane.tasks.length" :description="data.warnings.length ? '来源快照缺少对应日报内容' : '来源没有该阶段任务'" /></div></section></div><el-collapse class="surface meeting-raw"><el-collapse-item title="查看完整来源快照（只读）"><FullRecord :value="data" /></el-collapse-item></el-collapse></template></QueryState>
  <RecordDrawer v-model="visible" title="例会任务校对" :subtitle="selected?.id" :record="selected"><template v-if="selected"><section class="detail-section"><h3>来源原文</h3><pre class="detail-text">{{ selected.sourceText }}</pre></section><section class="detail-section"><h3>本地校对草稿</h3><el-input v-model="editor" :disabled="syncing" type="textarea" :rows="12" aria-label="完整例会任务草稿" /><p>保存草稿只影响此浏览器；同步成功才表示 Confluence 接口已接受修改。</p><p v-if="drafts[selectedDraftKey]?.syncedAt">上次同步 {{ dateTime(drafts[selectedDraftKey]?.syncedAt) }}</p></section></template><template #footer><el-button v-if="selected" :disabled="syncing" @click="editor = selected.sourceText">恢复来源文字</el-button><el-button :disabled="syncing" @click="saveDraft()">保存草稿</el-button><el-button :disabled="syncing" @click="saveDraft(true)">已核对并保存草稿</el-button><el-button type="primary" :loading="syncing" :disabled="!editor.trim()" @click="sync">同步这条到 Confluence</el-button></template></RecordDrawer>
</template>
<style scoped>.meeting-source{padding:22px;display:flex;justify-content:space-between;align-items:center;gap:15px}.meeting-source h2{font-size:16px;font-weight:550;margin:0 0 10px}.meeting-source p,.meeting-source>span{font-size:12px;color:var(--ui-muted);margin:0;line-height:1.8}.meeting-lanes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.meeting-task{padding:16px;border:1px solid var(--ui-border);border-radius:6px;margin-bottom:12px}.meeting-task pre{font:13px/1.9 var(--sans);white-space:pre-wrap;overflow-wrap:anywhere}.meeting-task p{font-size:11px;color:var(--ui-muted)}.meeting-raw{padding:0 20px}@media(max-width:900px){.meeting-lanes{grid-template-columns:1fr}.meeting-source{align-items:flex-start;flex-direction:column}}</style>
