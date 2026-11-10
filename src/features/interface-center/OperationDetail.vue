<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Copy } from '@lucide/vue';
import type { ApiOperationDetail, ApiProject } from '../../../shared/interface-center';
import RequestDebugger from './RequestDebugger.vue';

const props = defineProps<{ detail?: ApiOperationDetail; project?: ApiProject; loading: boolean }>();
const tab = ref('overview');
const detailView = ref<HTMLElement>();
watch(() => props.detail?.key, () => { tab.value = 'overview'; });
watch(tab, () => {
  const content = detailView.value?.querySelector('.detail-tabs > .el-tabs__content');
  if (content) content.scrollTop = 0;
}, { flush: 'post' });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);
const parameters = computed(() => (props.detail?.parameters || []).map(value => {
  const item = record(value), schema = record(item.schema);
  return { name: String(item.name || item.$ref || ''), location: String(item.in || ''), required: !!item.required,
    type: Array.isArray(schema.type) ? schema.type.join(' | ') : String(schema.type || item.type || schema.$ref || '—'),
    description: String(item.description || ''), schema: Object.keys(schema).length ? pretty(schema) : '',
    example: item.example === undefined ? '' : pretty(item.example) };
}));
const servers = computed(() => (props.detail?.servers || []).map(server => record(server)));
async function copyPath() {
  if (!props.detail) return;
  try { await navigator.clipboard.writeText(props.detail.path); ElMessage.success('接口路径已复制'); }
  catch { ElMessage.error('浏览器未允许复制'); }
}
</script>

<template>
  <div ref="detailView" class="operation-detail" v-loading="loading">
    <template v-if="detail">
      <header class="detail-heading">
        <div class="detail-breadcrumb">{{ project?.name }}<template v-if="detail.tags.length"> / {{ detail.tags.join(' / ') }}</template></div>
        <h2>{{ detail.summary || detail.path }}</h2>
        <div class="detail-path"><span :class="['http-method', detail.method.toLowerCase()]">{{ detail.method }}</span><code>{{ detail.path }}</code><el-button text aria-label="复制接口路径" @click="copyPath"><Copy :size="15" /></el-button></div>
        <el-tag v-if="detail.deprecated" type="info" size="small">已废弃</el-tag>
      </header>
      <el-tabs v-model="tab" class="detail-tabs">
        <el-tab-pane v-if="project" label="调试" name="debug" lazy><RequestDebugger :detail="detail" :project="project" /></el-tab-pane>
        <el-tab-pane label="概览" name="overview">
          <section class="detail-section"><h3>接口说明</h3><p v-if="detail.description" class="raw-description">{{ detail.description }}</p><p v-else class="detail-muted">暂无接口说明</p></section>
          <section class="detail-section"><h3>文档来源</h3><dl class="detail-facts"><dt>项目</dt><dd>{{ project?.name }}</dd><dt>版本</dt><dd>{{ project?.version || '—' }}<span v-if="project?.openapi"> · OpenAPI {{ project.openapi }}</span></dd><dt>来源</dt><dd>{{ project?.source.label || '手动添加' }}</dd><template v-if="project?.source.file"><dt>文件</dt><dd><code>{{ project.source.file }}</code></dd></template><template v-if="project?.source.commit"><dt>提交</dt><dd><code>{{ project.source.commit }}</code></dd></template></dl></section>
          <section class="detail-section"><h3>服务地址</h3><el-empty v-if="!servers.length" description="文档未定义服务地址" :image-size="55" /><div v-for="(server, index) in servers" :key="index" class="server-entry"><code>{{ server.url }}</code><p v-if="server.description" class="raw-description">{{ server.description }}</p><pre v-if="server.variables" class="contract-code">{{ pretty(server.variables) }}</pre></div></section>
          <section v-if="detail.security" class="detail-section"><h3>认证定义</h3><pre class="contract-code">{{ pretty(detail.security) }}</pre></section>
        </el-tab-pane>
        <el-tab-pane :label="`请求参数${parameters.length ? ` (${parameters.length})` : ''}`" name="parameters">
          <el-empty v-if="!parameters.length" description="文档未定义请求参数" :image-size="70" />
          <div v-else class="parameter-list"><article v-for="(parameter, index) in parameters" :key="index" class="parameter-entry"><header><code>{{ parameter.name }}</code><el-tag size="small" type="info">{{ parameter.location || '参数' }}</el-tag><span>{{ parameter.type }}</span><strong v-if="parameter.required" class="required-label">必填</strong></header><p v-if="parameter.description" class="raw-description">{{ parameter.description }}</p><details v-if="parameter.schema"><summary>参数结构</summary><pre class="contract-code">{{ parameter.schema }}</pre></details><details v-if="parameter.example"><summary>示例</summary><pre class="contract-code">{{ parameter.example }}</pre></details></article></div>
        </el-tab-pane>
        <el-tab-pane label="请求体" name="body"><el-empty v-if="!detail.requestBody" description="文档未定义请求体" :image-size="70" /><pre v-else class="contract-code">{{ pretty(detail.requestBody) }}</pre></el-tab-pane>
        <el-tab-pane label="响应" name="responses"><el-empty v-if="!Object.keys(detail.responses).length" description="文档未定义响应" :image-size="70" /><el-collapse v-else :model-value="Object.keys(detail.responses).slice(0, 1)"><el-collapse-item v-for="(response, status) in detail.responses" :key="status" :name="status"><template #title><span class="response-title"><code>{{ status }}</code><span>{{ record(response).description }}</span></span></template><pre class="contract-code">{{ pretty(response) }}</pre></el-collapse-item></el-collapse></el-tab-pane>
        <el-tab-pane label="接口契约" name="raw"><pre class="contract-code">{{ pretty(detail.raw) }}</pre></el-tab-pane>
      </el-tabs>
    </template>
    <el-skeleton v-else-if="loading" :rows="9" animated />
    <el-empty v-else description="请选择一个接口查看文档" :image-size="80" />
  </div>
</template>

<style scoped>
.operation-detail{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ui-text);font-size:13px;min-width:0}.detail-heading{flex-shrink:0}.detail-breadcrumb{font-size:11px;color:var(--ui-muted);overflow-wrap:anywhere}.detail-heading h2{font-size:19px;line-height:1.5;margin:8px 0;overflow-wrap:anywhere}.detail-path{display:flex;gap:10px;align-items:flex-start;min-width:0;margin-bottom:8px}.detail-path>code{flex:1;min-width:0;overflow-wrap:anywhere;padding-top:3px;line-height:1.7}.detail-path>.el-button{flex-shrink:0;padding:5px;height:27px;margin:0}.http-method{display:inline-flex;font:600 10px/1.5 var(--ds-code,monospace);color:var(--el-color-primary);padding:4px 7px;border-radius:5px;background:var(--el-color-primary-light-9);flex-shrink:0}.http-method.get{color:var(--el-color-success);background:var(--el-color-success-light-9)}.http-method.post{color:var(--el-color-warning);background:var(--el-color-warning-light-9)}.http-method.delete{color:var(--el-color-danger);background:var(--el-color-danger-light-9)}.detail-tabs{display:flex;flex-direction:column;flex:1;min-height:0;margin-top:8px}.detail-tabs > :deep(.el-tabs__header){flex-shrink:0;margin-bottom:12px}.detail-tabs > :deep(.el-tabs__content){flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.detail-tabs > :deep(.el-tabs__content > .el-tab-pane){min-width:0;padding-right:3px}.detail-tabs :deep(.el-tabs__item){font-size:12px;padding:0 13px}.detail-section{margin:12px 0 28px}.detail-section h3{font-size:13px;font-weight:600;margin:0 0 12px}.raw-description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;margin:8px 0}.detail-muted{color:var(--ui-muted);font-size:12px}.detail-facts{display:grid;grid-template-columns:55px minmax(0,1fr);gap:11px 15px;line-height:1.7}.detail-facts dt{color:var(--ui-muted)}.detail-facts dd{margin:0;overflow-wrap:anywhere}.detail-facts code{font-size:11px}.contract-code{margin:10px 0;padding:16px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-bg);color:var(--ui-text);font:11px/1.8 var(--ds-code,monospace);max-width:100%;overflow:auto;tab-size:2;max-height:60vh}.server-entry{padding:10px 0;border-bottom:1px solid var(--ui-divider)}.server-entry>code{overflow-wrap:anywhere;font-size:12px}.parameter-entry{padding:15px 0;border-bottom:1px solid var(--ui-divider)}.parameter-entry header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.parameter-entry header>code{font-weight:600;overflow-wrap:anywhere}.parameter-entry header>span{color:var(--ui-muted);font-size:11px}.required-label{font-size:10px;color:var(--el-color-danger)}.parameter-entry details{margin-top:10px}.parameter-entry summary{cursor:pointer;color:var(--ui-muted);font-size:11px}.response-title{display:flex;gap:12px;align-items:center;min-width:0;text-align:left;line-height:1.6}.response-title>code{font-weight:600;color:var(--el-color-primary);flex-shrink:0}.response-title>span{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 0}.detail-tabs :deep(.el-collapse-item__header){height:auto;min-height:48px}
</style>
