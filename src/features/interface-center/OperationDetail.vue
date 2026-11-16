<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Check, Copy, FileText, Lock, Sparkles, Terminal } from '@lucide/vue';
import type { ApiOperationDetail, ApiProject } from '../../../shared/interface-center';
import {
  buildOperationAgentPrompt,
  buildOperationCodegenSnippet,
  buildOperationCurlSnippet,
  buildOperationMarkdownDoc,
  httpStatusTone,
  type OpenApiCodegenTarget,
} from './curl-snippet';
import RequestDebugger from './RequestDebugger.vue';

const props = defineProps<{
  detail?: ApiOperationDetail;
  project?: ApiProject;
  loading: boolean;
  canAskAi?: boolean;
}>();

const emit = defineEmits<{
  askAi: [prompt: string];
}>();

const tab = ref('overview');
const detailView = ref<HTMLElement>();
const copiedKind = ref<'path' | 'curl' | 'markdown' | 'codegen' | ''>('');
const codegenTarget = ref<OpenApiCodegenTarget>('curl');
const codegenTabs: { id: OpenApiCodegenTarget; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'typescript', label: 'TypeScript SDK' },
  { id: 'go', label: 'Go net/http' },
  { id: 'contract-test', label: 'Node 契约测试' },
];
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.detail?.key, () => {
  tab.value = 'overview';
  copiedKind.value = '';
});
watch(tab, () => {
  const content = detailView.value?.querySelector('.detail-tabs > .el-tabs__content');
  if (content) content.scrollTop = 0;
}, { flush: 'post' });

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

const parameters = computed(() =>
  (props.detail?.parameters || []).map(value => {
    const item = record(value);
    const schema = record(item.schema);
    return {
      name: String(item.name || item.$ref || ''),
      location: String(item.in || ''),
      required: !!item.required,
      type: Array.isArray(schema.type) ? schema.type.join(' | ') : String(schema.type || item.type || schema.$ref || '—'),
      description: String(item.description || ''),
      schema: Object.keys(schema).length ? pretty(schema) : '',
      example: item.example === undefined ? '' : pretty(item.example),
    };
  }),
);

const servers = computed(() => (props.detail?.servers || []).map(server => record(server)));
const responseCodes = computed(() => Object.keys(props.detail?.responses || {}));
const hasAuth = computed(() => {
  const sec = props.detail?.security;
  if (Array.isArray(sec)) return sec.some(item => Object.keys(record(item)).length > 0);
  return Object.keys(record(sec)).length > 0;
});

const pathSegments = computed(() => {
  const raw = props.detail?.path || '';
  const parts: { text: string; isParam: boolean }[] = [];
  let lastIndex = 0;
  for (const match of raw.matchAll(/\{[^{}]+\}/g)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) parts.push({ text: raw.slice(lastIndex, idx), isParam: false });
    parts.push({ text: match[0], isParam: true });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < raw.length) parts.push({ text: raw.slice(lastIndex), isParam: false });
  return parts;
});

const quickCurlSnippet = computed(() =>
  props.detail ? buildOperationCurlSnippet(props.detail, props.project) : '',
);

const activeCodegenSnippet = computed(() =>
  props.detail ? buildOperationCodegenSnippet(codegenTarget.value, props.detail, props.project) : '',
);

function flashCopied(kind: 'path' | 'curl' | 'markdown' | 'codegen') {
  copiedKind.value = kind;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedKind.value = '';
  }, 1600);
}

async function copyPath() {
  if (!props.detail) return;
  try {
    await navigator.clipboard.writeText(props.detail.path);
    flashCopied('path');
    ElMessage.success('接口路径已复制');
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

async function copyQuickCurl() {
  if (!props.detail) return;
  try {
    await navigator.clipboard.writeText(quickCurlSnippet.value);
    flashCopied('curl');
    ElMessage.success('可执行 cURL 命令已复制');
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

async function copyMarkdownSpec() {
  if (!props.detail) return;
  try {
    await navigator.clipboard.writeText(buildOperationMarkdownDoc(props.detail, props.project));
    flashCopied('markdown');
    ElMessage.success('接口 Markdown 文档已复制');
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

function sendToAi() {
  if (!props.detail) return;
  emit('askAi', buildOperationAgentPrompt(props.detail, props.project, codegenTarget.value));
}

async function copyActiveCodegen() {
  if (!props.detail) return;
  const label = codegenTabs.find(item => item.id === codegenTarget.value)?.label || '代码';
  try {
    await navigator.clipboard.writeText(activeCodegenSnippet.value);
    flashCopied('codegen');
    ElMessage.success(`${label} 已复制`);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}
</script>

<template>
  <div ref="detailView" class="operation-detail" v-loading="loading">
    <template v-if="detail">
      <header class="detail-heading scalar-endpoint-card">
        <div class="scalar-meta-row">
          <span class="detail-breadcrumb">
            {{ project?.name }}<template v-if="detail.tags.length"> / {{ detail.tags.join(' / ') }}</template>
          </span>
          <div class="scalar-meta-pills">
            <span v-if="hasAuth" class="scalar-pill is-auth" title="该接口定义了安全鉴权要求">
              <Lock :size="11" /> 需鉴权
            </span>
            <span v-if="parameters.length" class="scalar-pill">参数 {{ parameters.length }}</span>
            <span
              v-for="code in responseCodes.slice(0, 4)"
              :key="code"
              class="scalar-pill is-status"
              :data-tone="httpStatusTone(code)"
            >
              {{ code }}
            </span>
            <el-tag v-if="detail.deprecated" type="info" size="small">已废弃</el-tag>
          </div>
        </div>

        <h2>{{ detail.summary || detail.path }}</h2>

        <div class="scalar-url-bar">
          <span :class="['http-method', detail.method.toLowerCase()]">{{ detail.method }}</span>
          <code class="scalar-path-code">
            <template v-for="(seg, idx) in pathSegments" :key="idx">
              <mark v-if="seg.isParam" class="scalar-path-param">{{ seg.text }}</mark>
              <span v-else>{{ seg.text }}</span>
            </template>
          </code>
          <div class="scalar-actions">
            <button type="button" class="scalar-action-btn" aria-label="复制接口路径" @click="copyPath">
              <Check v-if="copiedKind === 'path'" :size="13" />
              <Copy v-else :size="13" />
              <span>{{ copiedKind === 'path' ? '已复制' : '路径' }}</span>
            </button>
            <button type="button" class="scalar-action-btn" aria-label="一键复制 cURL 命令" @click="copyQuickCurl">
              <Check v-if="copiedKind === 'curl'" :size="13" />
              <Terminal v-else :size="13" />
              <span>{{ copiedKind === 'curl' ? '已复制 cURL' : '复制 cURL' }}</span>
            </button>
            <button type="button" class="scalar-action-btn" aria-label="复制接口 Markdown 文档" @click="copyMarkdownSpec">
              <Check v-if="copiedKind === 'markdown'" :size="13" />
              <FileText v-else :size="13" />
              <span>{{ copiedKind === 'markdown' ? '已复制文档' : '复制文档' }}</span>
            </button>
            <button
              v-if="canAskAi"
              type="button"
              class="scalar-action-btn is-ai"
              aria-label="带入 AI 对话联调"
              @click="sendToAi"
            >
              <Sparkles :size="13" />
              <span>AI 联调</span>
            </button>
          </div>
        </div>
      </header>

      <el-tabs v-model="tab" class="detail-tabs">
        <el-tab-pane v-if="project" label="调试" name="debug" lazy>
          <RequestDebugger :detail="detail" :project="project" :can-ask-ai="canAskAi" @ask-ai="emit('askAi', $event)" />
        </el-tab-pane>
        <el-tab-pane label="概览" name="overview">
          <section class="detail-section">
            <h3>接口说明</h3>
            <p v-if="detail.description" class="raw-description">{{ detail.description }}</p>
            <p v-else class="detail-muted">暂无接口说明</p>
          </section>

          <section class="detail-section scalar-curl-preview">
            <div class="scalar-section-head scalar-codegen-head">
              <div class="scalar-codegen-title-wrap">
                <h3>多语言客户端与契约测试生成</h3>
                <div class="scalar-codegen-tabs" role="tablist" aria-label="代码生成目标语言">
                  <button
                    v-for="item in codegenTabs"
                    :key="item.id"
                    type="button"
                    role="tab"
                    :aria-selected="codegenTarget === item.id"
                    class="scalar-codegen-tab"
                    :class="{ 'is-active': codegenTarget === item.id }"
                    @click="codegenTarget = item.id"
                  >
                    {{ item.label }}
                  </button>
                </div>
              </div>
              <div class="scalar-codegen-actions">
                <button type="button" class="scalar-mini-copy" @click="copyActiveCodegen">
                  <Check v-if="copiedKind === 'codegen'" :size="12" />
                  <Copy v-else :size="12" />
                  <span>{{ copiedKind === 'codegen' ? '已复制' : '复制代码' }}</span>
                </button>
                <button
                  v-if="canAskAi && codegenTarget !== 'curl'"
                  type="button"
                  class="scalar-mini-copy is-ai"
                  @click="sendToAi"
                >
                  <Sparkles :size="12" />
                  <span>让 AI 接入仓库</span>
                </button>
              </div>
            </div>
            <pre class="contract-code scalar-curl-code">{{ activeCodegenSnippet }}</pre>
          </section>

          <section class="detail-section">
            <h3>文档来源</h3>
            <dl class="detail-facts">
              <dt>项目</dt>
              <dd>{{ project?.name }}</dd>
              <dt>版本</dt>
              <dd>{{ project?.version || '—' }}<span v-if="project?.openapi"> · OpenAPI {{ project.openapi }}</span></dd>
              <dt>来源</dt>
              <dd>{{ project?.source.label || '手动添加' }}</dd>
              <template v-if="project?.source.file">
                <dt>文件</dt>
                <dd><code>{{ project.source.file }}</code></dd>
              </template>
              <template v-if="project?.source.commit">
                <dt>提交</dt>
                <dd><code>{{ project.source.commit }}</code></dd>
              </template>
            </dl>
          </section>

          <section class="detail-section">
            <h3>服务地址</h3>
            <el-empty v-if="!servers.length" description="文档未定义服务地址（cURL 默认使用本机占位地址）" :image-size="55" />
            <div v-for="(server, index) in servers" :key="index" class="server-entry">
              <code>{{ server.url }}</code>
              <p v-if="server.description" class="raw-description">{{ server.description }}</p>
              <pre v-if="server.variables" class="contract-code">{{ pretty(server.variables) }}</pre>
            </div>
          </section>

          <section v-if="detail.security" class="detail-section">
            <h3>认证定义</h3>
            <pre class="contract-code">{{ pretty(detail.security) }}</pre>
          </section>
        </el-tab-pane>

        <el-tab-pane :label="`请求参数${parameters.length ? ` (${parameters.length})` : ''}`" name="parameters">
          <el-empty v-if="!parameters.length" description="文档未定义请求参数" :image-size="70" />
          <div v-else class="parameter-list">
            <article v-for="(parameter, index) in parameters" :key="index" class="parameter-entry">
              <header>
                <code>{{ parameter.name }}</code>
                <span class="param-loc-pill">{{ parameter.location || '参数' }}</span>
                <span class="param-type-label">{{ parameter.type }}</span>
                <strong v-if="parameter.required" class="required-label">必填</strong>
              </header>
              <p v-if="parameter.description" class="raw-description">{{ parameter.description }}</p>
              <details v-if="parameter.schema">
                <summary>参数结构</summary>
                <pre class="contract-code">{{ parameter.schema }}</pre>
              </details>
              <details v-if="parameter.example">
                <summary>示例</summary>
                <pre class="contract-code">{{ parameter.example }}</pre>
              </details>
            </article>
          </div>
        </el-tab-pane>

        <el-tab-pane label="请求体" name="body">
          <el-empty v-if="!detail.requestBody" description="文档未定义请求体" :image-size="70" />
          <pre v-else class="contract-code">{{ pretty(detail.requestBody) }}</pre>
        </el-tab-pane>

        <el-tab-pane :label="`响应${responseCodes.length ? ` (${responseCodes.length})` : ''}`" name="responses">
          <el-empty v-if="!Object.keys(detail.responses).length" description="文档未定义响应" :image-size="70" />
          <el-collapse v-else :model-value="Object.keys(detail.responses).slice(0, 1)">
            <el-collapse-item v-for="(response, status) in detail.responses" :key="status" :name="status">
              <template #title>
                <span class="response-title">
                  <code class="response-code-pill" :data-tone="httpStatusTone(String(status))">{{ status }}</code>
                  <span>{{ record(response).description || '响应契约' }}</span>
                </span>
              </template>
              <pre class="contract-code">{{ pretty(response) }}</pre>
            </el-collapse-item>
          </el-collapse>
        </el-tab-pane>

        <el-tab-pane label="接口契约" name="raw">
          <pre class="contract-code">{{ pretty(detail.raw) }}</pre>
        </el-tab-pane>
      </el-tabs>
    </template>
    <el-skeleton v-else-if="loading" :rows="9" animated />
    <el-empty v-else description="请选择一个接口查看文档" :image-size="80" />
  </div>
</template>

<style scoped>
.operation-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--ui-text);
  font-size: 13px;
  min-width: 0;
}

.scalar-endpoint-card {
  flex-shrink: 0;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-md, 10px);
  background: color-mix(in srgb, var(--ui-raised) 55%, var(--ui-surface));
}

:global(:root[data-theme='acid']) .scalar-endpoint-card {
  border-radius: 0;
}

.scalar-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  flex-wrap: wrap;
}

.detail-breadcrumb {
  font-size: 11.5px;
  color: var(--ui-muted);
  overflow-wrap: anywhere;
}

.scalar-meta-pills {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.scalar-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 500 10.5px/1 var(--mono);
  font-variant-numeric: tabular-nums;
}

.scalar-pill.is-auth {
  border-color: color-mix(in srgb, var(--ui-warning) 35%, var(--ui-border));
  color: var(--ui-warning);
}

.scalar-pill.is-status[data-tone='success'],
.response-code-pill[data-tone='success'] {
  border-color: color-mix(in srgb, var(--ui-success) 35%, var(--ui-border));
  background: var(--ui-success-bg);
  color: var(--ui-success);
}

.scalar-pill.is-status[data-tone='warning'],
.response-code-pill[data-tone='warning'] {
  border-color: color-mix(in srgb, var(--ui-warning) 35%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning) 12%, var(--ui-surface));
  color: var(--ui-warning);
}

.scalar-pill.is-status[data-tone='danger'],
.response-code-pill[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--ui-danger) 35%, var(--ui-border));
  background: var(--ui-danger-bg);
  color: var(--ui-danger);
}

.detail-heading h2 {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.4;
  margin: 8px 0 10px;
  overflow-wrap: anywhere;
}

.scalar-url-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface);
}

:global(:root[data-theme='acid']) .scalar-url-bar {
  border-radius: 0;
}

.http-method {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 46px;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 32%, var(--ui-border));
  border-radius: 5px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font: 700 10.5px/1.35 var(--ds-code, var(--mono));
  letter-spacing: 0.03em;
  flex-shrink: 0;
}

.http-method.get {
  color: var(--ui-success);
  border-color: color-mix(in srgb, var(--ui-success) 34%, var(--ui-border));
  background: var(--ui-success-bg);
}

.http-method.post {
  color: var(--ui-accent);
  border-color: color-mix(in srgb, var(--ui-accent) 36%, var(--ui-border));
  background: var(--ui-accent-soft);
}

.http-method.put,
.http-method.patch {
  color: var(--ui-warning);
  border-color: color-mix(in srgb, var(--ui-warning) 36%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning) 12%, var(--ui-surface));
}

.http-method.delete {
  color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 36%, var(--ui-border));
  background: var(--ui-danger-bg);
}

.scalar-path-code {
  flex: 1 1 220px;
  min-width: 0;
  overflow-wrap: anywhere;
  font: 500 12.5px/1.6 var(--ds-code, var(--mono));
  color: var(--ui-text);
}

.scalar-path-param {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

.scalar-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-left: auto;
}

.scalar-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 11.5px/1 var(--sans);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}

.scalar-action-btn:hover {
  border-color: color-mix(in srgb, var(--ui-text) 24%, var(--ui-border));
  background: var(--ui-surface);
  color: var(--ui-text);
}

.scalar-action-btn.is-ai {
  border-color: color-mix(in srgb, var(--ui-accent) 38%, var(--ui-border));
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

.scalar-action-btn.is-ai:hover {
  border-color: var(--ui-accent);
  background: color-mix(in srgb, var(--ui-accent) 18%, var(--ui-surface));
}

.scalar-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.scalar-section-head h3 {
  margin: 0 !important;
}

.scalar-codegen-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.scalar-codegen-tabs {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised);
}

.scalar-codegen-tab {
  height: 22px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-muted);
  font: 500 11px/1 var(--sans);
  cursor: pointer;
  white-space: nowrap;
  transition: color 130ms ease, background-color 130ms ease, border-color 130ms ease;
}

.scalar-codegen-tab:hover {
  color: var(--ui-text);
}

.scalar-codegen-tab.is-active {
  border-color: color-mix(in srgb, var(--ui-accent) 36%, var(--ui-border));
  background: var(--ui-surface);
  color: var(--ui-accent);
  font-weight: 600;
}

.scalar-codegen-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.scalar-mini-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 11px/1 var(--sans);
  cursor: pointer;
}

.scalar-mini-copy:hover {
  color: var(--ui-text);
  border-color: color-mix(in srgb, var(--ui-text) 24%, var(--ui-border));
}

.scalar-mini-copy.is-ai {
  border-color: color-mix(in srgb, var(--ui-accent) 36%, var(--ui-border));
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

.scalar-curl-code {
  margin-top: 0 !important;
}

.detail-tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin-top: 10px;
}

.detail-tabs > :deep(.el-tabs__header) {
  flex-shrink: 0;
  margin-bottom: 12px;
}

.detail-tabs > :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.detail-tabs > :deep(.el-tabs__content > .el-tab-pane) {
  min-width: 0;
  padding-right: 3px;
}

.detail-tabs :deep(.el-tabs__item) {
  font-size: 12px;
  padding: 0 13px;
}

.detail-section {
  margin: 12px 0 24px;
}

.detail-section h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 10px;
}

.raw-description {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.75;
  margin: 8px 0;
}

.detail-muted {
  color: var(--ui-muted);
  font-size: 12px;
}

.detail-facts {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 10px 15px;
  line-height: 1.7;
}

.detail-facts dt {
  color: var(--ui-muted);
}

.detail-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.detail-facts code {
  font-size: 11px;
}

.contract-code {
  margin: 10px 0;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg);
  color: var(--ui-text);
  font: 11.5px/1.75 var(--ds-code, var(--mono));
  max-width: 100%;
  overflow: auto;
  tab-size: 2;
  max-height: 60vh;
}

.server-entry {
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-divider);
}

.server-entry > code {
  overflow-wrap: anywhere;
  font-size: 12px;
}

.parameter-entry {
  padding: 14px 0;
  border-bottom: 1px solid var(--ui-divider);
}

.parameter-entry header {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.parameter-entry header > code {
  font: 600 12.5px/1.4 var(--ds-code, var(--mono));
  color: var(--ui-text);
  overflow-wrap: anywhere;
}

.param-loc-pill {
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 10.5px/1.4 var(--mono);
}

.param-type-label {
  color: var(--ui-muted);
  font: 500 11px/1.4 var(--mono);
}

.required-label {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ui-danger-bg);
  font-size: 10.5px;
  color: var(--ui-danger);
}

.parameter-entry details {
  margin-top: 10px;
}

.parameter-entry summary {
  cursor: pointer;
  color: var(--ui-muted);
  font-size: 11px;
}

.response-title {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
  text-align: left;
  line-height: 1.6;
}

.response-code-pill {
  padding: 2px 7px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  font: 600 11px/1.4 var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-accent);
  flex-shrink: 0;
}

.response-title > span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 12px 0;
}

.detail-tabs :deep(.el-collapse-item__header) {
  height: auto;
  min-height: 48px;
}
</style>
