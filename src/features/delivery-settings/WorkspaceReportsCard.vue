<script setup lang="ts">
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue';
import { reportSourceLabels, reportSectionLabels } from '../../../shared/workspace-reports';
import { dateTime } from '../../shared/format';
import QueryState from '../../shared/ui/QueryState.vue';
import { useWorkspaceReports } from './useWorkspaceReports';

const manager = useWorkspaceReports();
const { query, settings, selectedId, selected, bot, confirmed, valid, policyValid, dirty, pending, busy, preview, canSend, botForm, botOpen } = manager;
const previewOpen = shallowRef(false);
const previewTab = shallowRef('full');
const partPage = shallowRef(1);
const previewHeading = useTemplateRef<HTMLElement>('previewHeading');
const settingsHeading = useTemplateRef<HTMLElement>('settingsHeading');
const partReader = useTemplateRef<HTMLElement>('partReader');
const showingPreview = computed(() => previewOpen.value && !!preview.value);
const previewParts = computed(() => preview.value?.parts || []);
const selectedPart = computed(() => previewParts.value[partPage.value - 1]);
watch(partPage, () => { if (partReader.value) partReader.value.scrollTop = 0; }, { flush: 'post' });

async function openPreview() {
  previewOpen.value = true;
  await nextTick();
  previewHeading.value?.focus();
}
async function prepare() {
  await manager.prepare();
  if (!preview.value) return;
  previewTab.value = 'full';
  partPage.value = 1;
  await openPreview();
}
async function closePreview() {
  previewOpen.value = false;
  await nextTick();
  settingsHeading.value?.focus();
}

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const placeholders = '{date}、{doing}、{todo}、{blocked}、{review}、{completed}、{next}、{coverage}';
const botValid = computed(() => !!botForm.value.groupName.trim() && (!!query.data.value?.bots.dedicated.hasWebhook || !!botForm.value.webhook.trim()));
const receiptLabels = { sending: '发送中', sent: '机器人已接收', failed: '发送失败', unknown: '送达待核实' };
const latestReceipt = computed(() => query.data.value?.history[0]);
</script>

<template>
  <QueryState :loading="query.isPending.value" :error="query.error.value" :has-data="!!settings && !!query.data.value" @retry="query.refetch()">
    <div v-if="settings && query.data.value" class="reports-workspace" :class="{ 'is-preview': showingPreview }">
      <section v-show="!showingPreview" class="surface reports-settings">
        <div class="surface-header">
          <div><h2 ref="settingsHeading" tabindex="-1">自动汇报</h2><p>完整 Markdown · 全部任务明细 · Jira 可点击跳转</p></div>
          <el-button :disabled="busy" @click="query.refetch()">刷新状态</el-button>
        </div>
        <div class="surface-body">
          <div class="reports-destination">
            <div class="reports-bot-state"><span>接收群</span><strong>{{ bot?.groupName || '尚未设置' }}</strong><el-tag size="small" :type="confirmed ? 'success' : 'info'">{{ confirmed ? '已确认' : '待配置确认' }}</el-tag></div>
            <details class="reports-options reports-bot-options">
              <summary>接收群设置</summary>
              <el-form label-position="top" :disabled="busy" @submit.prevent>
                <el-form-item label="接收群来源"><el-radio-group v-model="settings.botTarget" aria-label="汇报机器人"><el-radio-button value="dedicated">单独设置汇报群</el-radio-button><el-radio-button value="integration">共用手动消息群</el-radio-button></el-radio-group></el-form-item>
                <el-button v-if="settings.botTarget === 'dedicated'" :disabled="busy" @click="botOpen = true">更换汇报接收群</el-button><router-link v-else to="/messages">查看手动消息群</router-link>
              </el-form>
            </details>
          </div>
          <el-checkbox v-if="!confirmed" v-model="confirmed" :disabled="!bot?.hasWebhook || busy">确认“{{ bot?.groupName || '当前群' }}”为任务汇报接收群</el-checkbox>
          <el-form v-if="selected" label-position="top" :disabled="busy" @submit.prevent>
            <el-form-item v-if="settings.policies.length > 1" label="汇报计划"><el-select v-model="selectedId" aria-label="选择汇报计划"><el-option v-for="policy in settings.policies" :key="policy.id" :value="policy.id" :label="`${policy.name || '未命名计划'} · ${policy.enabled ? '已启用' : '已暂停'}`" /></el-select></el-form-item>
            <div class="reports-schedule-heading"><h3>{{ selected.name || '汇报计划' }}</h3><div><span>定时提醒</span><el-switch v-model="selected.enabled" :disabled="busy || !confirmed" aria-label="启用此汇报策略" /></div></div>
            <el-form-item label="发送时间">
              <div class="reports-times">
                <div v-for="(_, index) in selected.times" :key="index" class="reports-time"><el-time-picker v-model="selected.times[index]" format="HH:mm" value-format="HH:mm" :clearable="false" :aria-label="`汇报时间 ${index + 1}`" /><el-button v-if="selected.times.length > 1" :disabled="busy" :aria-label="`移除汇报时间 ${index + 1}`" @click="selected.times.splice(index, 1)">移除</el-button></div>
                <el-button :disabled="busy || selected.times.length >= 12" @click="manager.addTime">添加时间</el-button><span class="reports-note">{{ selected.timeZone === 'Asia/Singapore' ? '新加坡 / 北京时间（UTC+8）' : selected.timeZone }}</span>
              </div>
            </el-form-item>
            <el-form-item label="发送日期"><el-checkbox-group v-model="selected.weekdays" aria-label="推送星期"><el-checkbox v-for="(day, index) in weekdays" :key="day" :value="index + 1">{{ day }}</el-checkbox></el-checkbox-group></el-form-item>
            <details class="reports-options reports-advanced">
              <summary>更多设置</summary>
              <div class="reports-fields">
                <el-form-item label="计划名称"><el-input v-model="selected.name" maxlength="100" aria-label="策略名称" /></el-form-item>
                <el-form-item label="汇报类型"><el-select v-model="selected.kind" aria-label="汇报类型"><el-option label="综合进度汇报" value="summary" /><el-option label="逾期待办提醒" value="overdue" /></el-select></el-form-item>
                <el-form-item label="时区"><el-select v-model="selected.timeZone" filterable allow-create default-first-option aria-label="汇报时区"><el-option label="新加坡 / 北京（UTC+8）" value="Asia/Singapore" /><el-option label="UTC" value="UTC" /></el-select></el-form-item>
              </div>
              <el-form-item label="任务来源"><el-checkbox-group v-model="selected.sources" aria-label="汇报任务来源"><el-checkbox v-for="(label, source) in reportSourceLabels" :key="source" :value="source">{{ label }}</el-checkbox></el-checkbox-group></el-form-item>
              <el-form-item label="汇报栏目"><el-checkbox-group v-model="selected.sections" aria-label="汇报栏目"><el-checkbox v-for="(label, section) in reportSectionLabels" :key="section" :value="section">{{ label }}</el-checkbox></el-checkbox-group></el-form-item>
              <el-form-item label="项目筛选"><el-input v-model="selected.projectFilter" maxlength="200" clearable placeholder="留空汇总所有项目；填写项目关键字" aria-label="汇报项目筛选" /></el-form-item>
              <el-form-item label="自定义汇报模板"><el-input v-model="selected.template" type="textarea" :rows="4" maxlength="12000" placeholder="留空使用标准汇报格式；可自行填写标题、说明与栏目占位符" aria-label="自定义汇报模板" /><p class="reports-note">可用占位符：{{ placeholders }}</p></el-form-item>
              <div class="reports-policy-actions"><el-button :disabled="busy || settings.policies.length >= 30" @click="manager.addPolicy('summary')">添加汇报计划</el-button><el-button :disabled="busy || settings.policies.length >= 30" @click="manager.addPolicy('overdue')">添加逾期提醒</el-button><el-button link type="danger" :disabled="busy" @click="manager.removePolicy">移除此计划</el-button></div>
            </details>
            <div class="reports-actions"><el-button type="primary" :disabled="!policyValid || busy" :loading="pending === 'preview'" @click="prepare">预览完整汇报</el-button><el-button v-if="preview" :disabled="busy" @click="openPreview">查看已有预览</el-button><el-button :disabled="!valid || !dirty || busy" :loading="pending === 'save'" @click="manager.save">保存设置</el-button><el-button v-if="dirty" :disabled="busy" @click="manager.reset">取消修改</el-button><span v-if="dirty" class="reports-note">有未保存修改</span></div>
          </el-form>
          <div v-else class="reports-actions"><el-button :disabled="busy" @click="manager.addPolicy('summary')">添加汇报计划</el-button><el-button :disabled="!valid || !dirty || busy" :loading="pending === 'save'" @click="manager.save">保存设置</el-button><el-button v-if="dirty" :disabled="busy" @click="manager.reset">取消修改</el-button></div>
          <p class="reports-note">电脑和工作台服务保持运行时，按设定时间自动发送。长消息自动分段。</p>
          <p v-if="latestReceipt" class="reports-note">最近发送：{{ dateTime(latestReceipt.attemptedAt) }} · {{ latestReceipt.groupName }} · {{ receiptLabels[latestReceipt.status] }}<template v-if="latestReceipt.partCount"> · {{ latestReceipt.sentParts || 0 }}/{{ latestReceipt.partCount }} 条</template><template v-if="latestReceipt.status !== 'sent'"> · {{ latestReceipt.message }}</template></p>
        </div>
      </section>
      <section v-if="preview && showingPreview" class="surface reports-preview" aria-labelledby="reports-preview-heading">
        <div class="surface-header reports-preview-header">
          <div>
            <h2 id="reports-preview-heading" ref="previewHeading" tabindex="-1">完整汇报预览</h2>
            <p>{{ preview.policyName }} · {{ dateTime(preview.generatedAt) }} · {{ preview.groupName || '尚未配置接收群' }}</p>
          </div>
          <div class="reports-actions">
            <el-button :disabled="busy" @click="closePreview">返回汇报设置</el-button>
            <el-button type="primary" :disabled="!canSend" :loading="pending === 'send'" @click="manager.send">发送完整汇报</el-button>
          </div>
        </div>
        <el-tabs v-model="previewTab" class="reports-preview-tabs" aria-label="汇报阅读方式">
          <el-tab-pane label="完整正文" name="full" lazy>
            <div class="reports-reader" role="region" aria-label="完整正文阅读区" tabindex="0">
              <AgentMarkdown class="reports-content" :source="preview.fullContent || preview.content" />
            </div>
          </el-tab-pane>
          <el-tab-pane :label="`分段预览（${previewParts.length}）`" name="parts" lazy>
            <template v-if="selectedPart">
              <div class="reports-part-nav">
                <span class="reports-note" role="status">第 {{ partPage }} / {{ previewParts.length }} 条</span>
                <el-pagination v-model:current-page="partPage" :total="previewParts.length" :page-size="1" :pager-count="5" layout="prev, pager, next" aria-label="汇报分段" small />
              </div>
              <div ref="partReader" class="reports-reader" role="region" aria-label="分段正文阅读区" tabindex="0">
                <AgentMarkdown class="reports-content" :source="selectedPart.content" />
              </div>
            </template>
            <p v-else class="reports-note reports-part-nav">请重新生成完整 Markdown 预览。</p>
          </el-tab-pane>
        </el-tabs>
      </section>
      <details v-show="!showingPreview" class="surface reports-history">
        <summary class="surface-header"><h2>发送记录</h2><span class="reports-note">{{ query.data.value.history.length }} 次</span></summary>
        <el-table :data="query.data.value.history" empty-text="暂无发送记录">
          <el-table-column label="汇报" min-width="170"><template #default="{ row }">{{ row.policyName }}<span class="reports-history-trigger">{{ row.trigger === 'schedule' ? '定时发送' : '手动发送' }}</span></template></el-table-column><el-table-column prop="groupName" label="接收群" min-width="130" /><el-table-column label="发送时间" min-width="150"><template #default="{ row }">{{ dateTime(row.attemptedAt) }}</template></el-table-column><el-table-column label="状态" min-width="160"><template #default="{ row }">{{ receiptLabels[row.status as keyof typeof receiptLabels] }}<template v-if="row.partCount"> · {{ row.sentParts || 0 }}/{{ row.partCount }} 条</template></template></el-table-column><el-table-column prop="message" label="回执" min-width="230" />
        </el-table>
      </details>
      <el-dialog v-model="botOpen" title="设置自动汇报接收群" width="min(600px, 95vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close>
        <el-form label-position="top" :disabled="busy" @submit.prevent="manager.saveBot"><el-form-item label="汇报接收群" required><el-input v-model="botForm.groupName" maxlength="80" aria-label="汇报接收群名称" /></el-form-item><el-form-item label="群机器人 Webhook" :required="!query.data.value.bots.dedicated.hasWebhook"><el-input v-model="botForm.webhook" type="password" autocomplete="off" :placeholder="query.data.value.bots.dedicated.hasWebhook ? '已保存；留空保留原 Webhook' : '粘贴汇报群机器人的 Webhook'" aria-label="汇报机器人 Webhook" /></el-form-item><p class="reports-note">Webhook 仅保存在当前工作台服务端，页面不回显。保存后仍需确认目标群和推送计划。</p></el-form>
        <template #footer><el-button :disabled="busy" @click="botOpen = false">取消</el-button><el-button type="primary" :disabled="busy || !botValid" :loading="pending === 'bot'" @click="manager.saveBot">保存机器人</el-button></template>
      </el-dialog>
    </div>
  </QueryState>
</template>

<style scoped>
.reports-workspace{display:flex;flex-direction:column;gap:20px;min-width:0}
.reports-workspace .surface{margin-bottom:0;min-width:0}
.reports-destination{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px}
.reports-bot-state{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:var(--ui-muted)}
.reports-bot-state strong{color:var(--ui-text);font-weight:600;overflow-wrap:anywhere}
.reports-options summary{cursor:pointer;color:var(--ui-secondary);font-size:13px;line-height:1.8}
.reports-options[open]>summary{margin-bottom:16px}
.reports-bot-options>summary{text-align:right;white-space:nowrap}
.reports-bot-options :deep(.el-form){margin:0}
.reports-bot-options a{color:var(--ui-accent)}
.reports-schedule-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 18px}
.reports-schedule-heading h3{margin:0;font-size:14px;font-weight:600;color:var(--ui-text)}
.reports-schedule-heading>div{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--ui-secondary)}
.reports-times,.reports-time,.reports-actions,.reports-policy-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.reports-time{flex-wrap:nowrap;min-width:0;max-width:100%}
.reports-time :deep(.el-date-editor){width:130px;min-width:0}
.reports-settings :deep(.el-checkbox-group){display:flex;flex-wrap:wrap;column-gap:18px;row-gap:2px}
.reports-settings :deep(.el-checkbox){margin-right:0}
.reports-advanced{margin:0 0 22px}
.reports-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}
.reports-fields :deep(.el-form-item),.reports-settings :deep(.el-form-item__content){min-width:0}
.reports-settings :deep(.el-select){width:100%}
.reports-actions .el-button+.el-button,.reports-policy-actions .el-button+.el-button{margin-left:0}
.reports-note{font-size:12px;line-height:1.8;color:var(--ui-muted);margin:10px 0 0;overflow-wrap:anywhere}
.reports-times .reports-note,.reports-actions .reports-note,.reports-history summary .reports-note{margin:0}
.reports-settings>.surface-body> :deep(.el-checkbox){white-space:normal;height:auto;line-height:1.7;margin-bottom:16px}
.reports-workspace.is-preview { height: 100%; }
.reports-preview, .reports-preview-tabs { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.reports-preview-header { flex-shrink: 0; }
.reports-preview-header > div { min-width: 0; }
.reports-preview-header p { overflow-wrap: anywhere; }
.reports-preview-tabs > :deep(.el-tabs__header) { flex-shrink: 0; margin: 0; padding-inline: 18px; }
.reports-preview-tabs > :deep(.el-tabs__content) { flex: 1; min-height: 0; }
.reports-preview-tabs > :deep(.el-tabs__content > .el-tab-pane) { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; scrollbar-gutter: auto; }
.reports-part-nav { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; padding: 6px 18px; border-bottom: 1px solid var(--ui-divider); }
.reports-part-nav .reports-note { margin: 0; }
.reports-reader { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 18px clamp(14px, 3vw, 32px) 28px; }
.reports-reader:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.reports-content { max-width: 880px; margin-inline: auto; color: var(--ui-text); font-size: 13px; line-height: 1.85; }
.reports-content :deep(.markdown-heading:not(:first-child)) { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--ui-divider); }
.reports-history>summary{cursor:pointer;list-style:none}
.reports-history>summary::-webkit-details-marker{display:none}
.reports-history>summary h2::before{content:'▸';display:inline-block;margin-right:9px}
.reports-history[open]>summary h2::before{content:'▾'}
.reports-history-trigger{display:block;font-size:12px;color:var(--ui-muted)}
@media(max-width:600px){.reports-destination{flex-direction:column;gap:10px}.reports-bot-options>summary{text-align:left}.reports-fields{grid-template-columns:minmax(0,1fr)}.reports-workspace :deep(.surface-header){align-items:flex-start;flex-wrap:wrap}.reports-schedule-heading{align-items:flex-start;flex-wrap:wrap}.reports-workspace :deep(.el-radio-group){display:flex;flex-wrap:wrap;gap:4px}.reports-workspace :deep(.el-radio-button__inner){border-radius:4px;border:1px solid var(--ui-border)}}
</style>
