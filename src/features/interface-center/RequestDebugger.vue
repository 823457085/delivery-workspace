<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Copy, Plus, Send, Square, X } from '@lucide/vue';
import type { ApiOperationDetail, ApiProject } from '../../../shared/interface-center';
import { apiDebugCurl, prepareApiDebugRequest, type ApiDebugAuth, type ApiDebugBody, type ApiDebugRequest, type ApiDebugResult } from '../../../shared/interface-center-debug';
import { errorMessage, interfaceApi, projectPath } from './api';
import { debugBodyDraft, debugFieldSensitive, debugParameterFields, debugRequestFields, debugServerOptions, emptyDebugField, type DebugFieldDraft } from './debugger-state';

const props = defineProps<{ detail: ApiOperationDetail; project: ApiProject }>();
const baseUrl = ref(''), paths = ref<DebugFieldDraft[]>([]), queries = ref<DebugFieldDraft[]>([]), headers = ref<DebugFieldDraft[]>([]);
const authKind = ref<ApiDebugAuth['kind']>('none'), bearerToken = ref(''), basicUsername = ref(''), basicPassword = ref('');
const bodyKind = ref<ApiDebugBody['kind']>('none'), bodyText = ref(''), contentType = ref('text/plain'), formFields = ref<DebugFieldDraft[]>([]);
const timeoutSeconds = ref(30), requestTab = ref('parameters'), responseTab = ref('body');
const sending = ref(false), response = shallowRef<ApiDebugResult>();
const responseMessage = ref(''), responseSection = ref<HTMLElement>();
let controller: AbortController | undefined, requestVersion = 0;
const servers = computed(() => debugServerOptions(props.detail));
const bodyAllowed = computed(() => !['GET', 'HEAD', 'TRACE'].includes(props.detail.method));
function suggestServers(query: string, done: (items: { value: string; description: string }[]) => void) {
  done(servers.value.filter(server => !query || server.url.toLowerCase().includes(query.toLowerCase())).map(server => ({ value: server.url, description: server.description })));
}
const parameterGroups = computed(() => [{ key: 'path', label: 'Path', fields: paths.value }, { key: 'query', label: 'Query', fields: queries.value },
  { key: 'header', label: 'Headers', fields: headers.value }]);
function reset() {
  requestVersion++; controller?.abort(); controller = undefined; sending.value = false;
  baseUrl.value = servers.value[0]?.url || '';
  paths.value = debugParameterFields(props.detail, 'path'); queries.value = debugParameterFields(props.detail, 'query'); headers.value = debugParameterFields(props.detail, 'header');
  authKind.value = 'none'; bearerToken.value = ''; basicUsername.value = ''; basicPassword.value = '';
  const body = debugBodyDraft(props.detail); bodyKind.value = body.kind; bodyText.value = body.text; contentType.value = body.contentType; formFields.value = body.fields;
  timeoutSeconds.value = 30; response.value = undefined; responseMessage.value = ''; requestTab.value = 'parameters'; responseTab.value = 'body';
}
watch(() => [props.project.id, props.project.updatedAt, props.detail.key], reset, { immediate: true });
onBeforeUnmount(() => { requestVersion++; controller?.abort(); });
function input(): ApiDebugRequest {
  const auth: ApiDebugAuth = authKind.value === 'bearer' ? { kind: 'bearer', token: bearerToken.value }
    : authKind.value === 'basic' ? { kind: 'basic', username: basicUsername.value, password: basicPassword.value } : { kind: 'none' };
  const body: ApiDebugBody = bodyKind.value === 'json' ? { kind: 'json', text: bodyText.value }
    : bodyKind.value === 'raw' ? { kind: 'raw', text: bodyText.value, contentType: contentType.value }
    : bodyKind.value === 'urlencoded' ? { kind: 'urlencoded', fields: debugRequestFields(formFields.value) } : { kind: 'none' };
  return { operationKey: props.detail.key, baseUrl: baseUrl.value, pathParameters: debugRequestFields(paths.value), queryParameters: debugRequestFields(queries.value),
    headers: debugRequestFields(headers.value), auth, body, timeoutMs: Math.round((timeoutSeconds.value || 30) * 1000) };
}
const previewUrl = computed(() => {
  const preview = input();
  const mask = (field: ApiDebugRequest['queryParameters'][number]) =>
    field.value.trim() && debugFieldSensitive(field) ? { ...field, value: 'REDACTED' } : field;
  preview.pathParameters = preview.pathParameters.map(mask);
  preview.queryParameters = preview.queryParameters.map(mask);
  try { return prepareApiDebugRequest(props.detail, preview).url; } catch { return ''; }
});
async function send() {
  if (sending.value) return;
  let payload: ApiDebugRequest;
  try { payload = input(); prepareApiDebugRequest(props.detail, payload); }
  catch (error) { ElMessage.error(errorMessage(error)); return; }
  const version = ++requestVersion, current = new AbortController(); controller = current;
  sending.value = true; response.value = undefined; responseMessage.value = '';
  try {
    const result = await interfaceApi<ApiDebugResult>(`${projectPath(props.project.id)}/debug`, payload, current.signal);
    if (version === requestVersion) { response.value = result; responseTab.value = 'body'; }
  } catch (error) {
    if (version === requestVersion) {
      responseMessage.value = current.signal.aborted ? '请求已取消' : errorMessage(error);
      if (current.signal.aborted) ElMessage.info(responseMessage.value); else ElMessage.error(responseMessage.value);
    }
  } finally {
    if (version === requestVersion) {
      sending.value = false; controller = undefined;
      await nextTick();
      if (version === requestVersion) responseSection.value?.scrollIntoView({ block: 'nearest' });
    }
  }
}
function cancel() { controller?.abort(); }
async function copyCurl() {
  try { await navigator.clipboard.writeText(apiDebugCurl(prepareApiDebugRequest(props.detail, input()))); ElMessage.success('cURL 已复制'); }
  catch (error) { ElMessage.error(errorMessage(error)); }
}
async function copyResponse() {
  if (!response.value) return;
  try { await navigator.clipboard.writeText(response.value.body); ElMessage.success('响应已复制'); }
  catch { ElMessage.error('浏览器未允许复制'); }
}
function addField(key: string) { (key === 'query' ? queries.value : headers.value).push(emptyDebugField()); }
function removeField(fields: DebugFieldDraft[], id: string) { const index = fields.findIndex(field => field.id === id); if (index >= 0) fields.splice(index, 1); }
const sizeLabel = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(2)} MB`;
</script>

<template>
  <section class="request-debugger" aria-label="HTTP 请求调试">
    <div class="debug-target">
      <label for="debug-service-url">服务地址</label>
      <el-autocomplete id="debug-service-url" v-model="baseUrl" :fetch-suggestions="suggestServers" :debounce="0" :disabled="sending" :placeholder="servers.length ? '选择或输入联调服务地址' : '输入实际环境的 HTTP 或 HTTPS 地址'" aria-label="服务地址" clearable><template #default="{ item }"><span>{{ item.value }}</span><small v-if="item.description"> · {{ item.description }}</small></template></el-autocomplete>
      <el-button v-if="!sending" type="primary" :disabled="!baseUrl" @click="send"><Send :size="14" />发送请求</el-button>
      <el-button v-else @click="cancel"><Square :size="14" />取消请求</el-button>
      <el-button :disabled="sending || !baseUrl" aria-label="复制 cURL" @click="copyCurl"><Copy :size="14" />复制 cURL</el-button>
    </div>
    <div class="debug-request-line"><strong>{{ detail.method }}</strong><code>{{ previewUrl || detail.path }}</code><span v-if="sending">请求中…</span></div>
    <el-tabs v-model="requestTab" class="debug-tabs">
      <el-tab-pane label="参数与请求头" name="parameters">
        <section v-for="group in parameterGroups" :key="group.key" class="debug-fields">
          <header><h3>{{ group.label }}</h3><el-button v-if="group.key !== 'path'" text size="small" :disabled="sending" @click="addField(group.key)"><Plus :size="13" />添加{{ group.key === 'query' ? '参数' : '请求头' }}</el-button></header>
          <p v-if="!group.fields.length" class="debug-muted">{{ group.key === 'path' ? '该路径没有占位参数' : '暂无参数' }}</p>
          <div v-for="(field, index) in group.fields" :key="field.id" class="debug-field-row">
            <el-checkbox v-model="field.enabled" :disabled="sending" :aria-label="`启用 ${group.label} ${field.name || index + 1}`" />
            <el-input v-model="field.name" :readonly="field.fixedName" :disabled="sending" placeholder="参数名" :aria-label="`${group.label} 参数名 ${index + 1}`" :title="field.description" />
            <el-input v-model="field.value" :type="debugFieldSensitive(field) ? 'password' : 'text'" :show-password="debugFieldSensitive(field)" :disabled="sending || !field.enabled" placeholder="参数值" :aria-label="`${group.label} ${field.name || index + 1} 参数值`" :aria-required="field.required && field.enabled" autocomplete="off" />
            <span class="debug-required">{{ field.required ? '必填' : '' }}</span>
            <el-button v-if="!field.fixedName" text :disabled="sending" :aria-label="`移除 ${group.label} ${field.name || index + 1}`" @click="removeField(group.fields, field.id)"><X :size="14" /></el-button>
            <span v-else class="debug-remove-space"></span>
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane label="鉴权" name="auth">
        <el-form label-position="top" class="debug-auth" @submit.prevent>
          <el-form-item label="鉴权方式"><el-select v-model="authKind" :disabled="sending" aria-label="鉴权方式"><el-option label="无 / 手动请求头" value="none" /><el-option label="Bearer Token" value="bearer" /><el-option label="Basic Auth" value="basic" /></el-select></el-form-item>
          <el-form-item v-if="authKind === 'bearer'" label="Token"><el-input v-model="bearerToken" type="password" show-password :disabled="sending" aria-label="Bearer Token" autocomplete="off" /></el-form-item>
          <template v-if="authKind === 'basic'"><el-form-item label="Username"><el-input v-model="basicUsername" :disabled="sending" aria-label="Basic Username" autocomplete="off" /></el-form-item><el-form-item label="Password"><el-input v-model="basicPassword" type="password" show-password :disabled="sending" aria-label="Basic Password" autocomplete="off" /></el-form-item></template>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="请求体" name="body">
        <el-radio-group v-model="bodyKind" :disabled="sending || !bodyAllowed" size="small" aria-label="请求体格式"><el-radio-button value="none">无</el-radio-button><el-radio-button value="json">JSON</el-radio-button><el-radio-button value="raw">Raw</el-radio-button><el-radio-button value="urlencoded">x-www-form-urlencoded</el-radio-button></el-radio-group>
        <p v-if="!bodyAllowed" class="debug-muted">{{ detail.method }} 不发送请求体</p>
        <div v-if="bodyKind === 'raw'" class="debug-content-type"><label>Content-Type</label><el-input v-model="contentType" :disabled="sending" placeholder="text/plain" aria-label="请求体 Content-Type" /></div>
        <el-input v-if="bodyKind === 'json' || bodyKind === 'raw'" v-model="bodyText" class="debug-body-input" type="textarea" :autosize="{ minRows: 8, maxRows: 20 }" :disabled="sending" :aria-label="bodyKind === 'json' ? 'JSON 请求体' : 'Raw 请求体'" spellcheck="false" />
        <section v-else-if="bodyKind === 'urlencoded'" class="debug-fields"><header><h3>表单字段</h3><el-button text size="small" :disabled="sending" @click="formFields.push(emptyDebugField())"><Plus :size="13" />添加字段</el-button></header>
          <div v-for="(field, index) in formFields" :key="field.id" class="debug-field-row"><el-checkbox v-model="field.enabled" :disabled="sending" :aria-label="`启用表单 ${field.name || index + 1}`" /><el-input v-model="field.name" :readonly="field.fixedName" :disabled="sending" placeholder="字段名" :aria-label="`表单字段名 ${index + 1}`" /><el-input v-model="field.value" :type="debugFieldSensitive(field) ? 'password' : 'text'" :show-password="debugFieldSensitive(field)" :disabled="sending || !field.enabled" placeholder="字段值" :aria-label="`表单 ${field.name || index + 1} 字段值`" autocomplete="off" /><span class="debug-required">{{ field.required ? '必填' : '' }}</span><el-button text :disabled="sending" :aria-label="`移除表单 ${field.name || index + 1}`" @click="removeField(formFields, field.id)"><X :size="14" /></el-button></div>
        </section>
      </el-tab-pane>
    </el-tabs>
    <div class="debug-options"><label>超时（秒）</label><el-input-number v-model="timeoutSeconds" :min="0.1" :max="60" :step="1" :disabled="sending" controls-position="right" size="small" aria-label="请求超时秒数" /></div>
    <section ref="responseSection" class="debug-response" aria-label="调试响应" aria-live="polite" v-loading="sending">
      <header><h3>响应</h3><template v-if="response"><el-tag :type="response.status >= 400 ? 'danger' : response.status >= 300 ? 'warning' : 'success'" size="small">{{ response.status }} {{ response.statusText }}</el-tag><span>{{ response.durationMs }} ms</span><span>{{ sizeLabel(response.sizeBytes) }}</span><el-tag v-if="response.truncated" size="small" type="info">仅显示前 2 MB</el-tag></template><el-button v-if="response" text size="small" aria-label="复制响应原文" @click="copyResponse"><Copy :size="13" />复制响应</el-button></header>
      <el-empty v-if="!response && !sending" :description="responseMessage || '发送请求后查看响应'" :image-size="58" />
      <el-tabs v-else-if="response" v-model="responseTab" class="debug-tabs"><el-tab-pane :label="response.bodyEncoding === 'base64' ? '响应原文（Base64）' : '响应原文'" name="body"><pre class="debug-response-body">{{ response.body }}</pre></el-tab-pane><el-tab-pane :label="`响应头 (${response.headers.length})`" name="headers"><dl class="debug-response-headers"><template v-for="(header, index) in response.headers" :key="index"><dt>{{ header.name }}</dt><dd>{{ header.value }}</dd></template></dl></el-tab-pane></el-tabs>
    </section>
  </section>
</template>

<style scoped>
.request-debugger{min-width:0;font-size:12px;color:var(--ui-text)}.debug-target{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.debug-target>label{font-size:12px;flex-shrink:0}.debug-target>.el-autocomplete{flex:1;min-width:230px}.debug-target>.el-button{margin:0;gap:5px}.debug-request-line{display:flex;gap:10px;align-items:flex-start;margin:14px 0;line-height:1.7}.debug-request-line>strong{color:var(--el-color-primary);font-size:11px;flex-shrink:0}.debug-request-line>code{overflow-wrap:anywhere;flex:1;min-width:0}.debug-request-line>span{color:var(--ui-muted);white-space:nowrap}.debug-tabs :deep(.el-tabs__item){font-size:12px;padding:0 12px}.debug-fields{margin-bottom:18px}.debug-fields>header,.debug-response>header{display:flex;align-items:center;gap:12px;min-height:32px;flex-wrap:wrap}.debug-fields h3,.debug-response h3{font-size:12px;font-weight:600;margin:0}.debug-fields>header>.el-button{margin-left:auto;gap:4px}.debug-field-row{display:flex;align-items:center;gap:8px;margin:8px 0;min-width:0}.debug-field-row>.el-checkbox{margin:0;flex-shrink:0}.debug-field-row>.el-input{flex:1;min-width:0}.debug-field-row>.el-input:nth-of-type(2){flex:1.5}.debug-required{width:25px;flex-shrink:0;font-size:10px;color:var(--ui-muted)}.debug-field-row>.el-button{margin:0;padding:5px;width:24px;flex-shrink:0}.debug-remove-space{width:24px;flex-shrink:0}.debug-muted{color:var(--ui-muted);font-size:12px;line-height:1.7}.debug-auth{max-width:520px;padding-top:6px}.debug-auth :deep(.el-form-item__label){font-size:12px}.debug-content-type{display:flex;gap:12px;align-items:center;margin:14px 0}.debug-content-type>label{flex-shrink:0}.debug-body-input{margin-top:14px}.debug-body-input :deep(textarea){font:12px/1.7 var(--ds-code,monospace)}.debug-options{display:flex;align-items:center;gap:12px;padding:10px 0 18px;color:var(--ui-muted)}.debug-options>.el-input-number{width:110px}.debug-response{border-top:1px solid var(--ui-border);padding-top:14px;min-height:160px}.debug-response>header>span{color:var(--ui-muted);font-size:11px}.debug-response>header>.el-button{margin-left:auto;gap:5px}.debug-response-body{font:12px/1.75 var(--ds-code,monospace);margin:0;max-height:480px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;min-height:24px}.debug-response-headers{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,3fr);gap:10px 16px;font:11px/1.7 var(--ds-code,monospace);max-height:480px;overflow:auto}.debug-response-headers>dt{color:var(--ui-muted);overflow-wrap:anywhere}.debug-response-headers>dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:650px){.debug-target>.el-autocomplete{flex-basis:calc(100% - 65px)}.debug-target>.el-button{font-size:11px;padding:8px 10px}.debug-field-row{gap:5px}.debug-field-row :deep(.el-input__inner){font-size:11px}.debug-required{width:22px;font-size:9px}.debug-response-headers{grid-template-columns:90px minmax(0,1fr)}}
.debug-target {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 2px 0 8px;
  background: var(--ui-surface);
}
.debug-response { scroll-margin-block-start: 76px; }
@media (max-width: 600px) {
  .debug-target > .el-autocomplete { flex-basis: 100%; min-width: 0; }
  .debug-response { scroll-margin-block-start: 112px; }
}
</style>
