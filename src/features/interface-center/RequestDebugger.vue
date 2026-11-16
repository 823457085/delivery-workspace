<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Bookmark, Check, Copy, Layers, Plus, Send, ShieldAlert, Sparkles, Square, Terminal, X } from '@lucide/vue';
import type { ApiOperationDetail, ApiProject } from '../../../shared/interface-center';
import { apiDebugCurl, prepareApiDebugRequest, type ApiDebugAuth, type ApiDebugBody, type ApiDebugField, type ApiDebugRequest, type ApiDebugResult } from '../../../shared/interface-center-debug';
import {
  buildDebugDiscrepancyAgentPrompt,
  compareApiDebugResponses,
  parseCurlCommandToDebugDraft,
  validateResponseAgainstOpenApi,
} from '../../../shared/api-debug-intelligence';
import { errorMessage, interfaceApi, projectPath } from './api';
import { debugBodyDraft, debugFieldSensitive, debugParameterFields, debugRequestFields, debugServerOptions, emptyDebugField, type DebugFieldDraft } from './debugger-state';

const props = defineProps<{ detail: ApiOperationDetail; project: ApiProject; canAskAi?: boolean }>();
const emit = defineEmits<{ askAi: [prompt: string] }>();

const baseUrl = ref(''), paths = ref<DebugFieldDraft[]>([]), queries = ref<DebugFieldDraft[]>([]), headers = ref<DebugFieldDraft[]>([]);
const authKind = ref<ApiDebugAuth['kind']>('none'), bearerToken = ref(''), basicUsername = ref(''), basicPassword = ref('');
const bodyKind = ref<ApiDebugBody['kind']>('none'), bodyText = ref(''), contentType = ref('text/plain'), formFields = ref<DebugFieldDraft[]>([]);
const timeoutSeconds = ref(30), requestTab = ref('parameters'), responseTab = ref('body');
const sending = ref(false), response = shallowRef<ApiDebugResult>();
const baselineResponse = shallowRef<ApiDebugResult>();
const showCurlImport = ref(false), curlImportText = ref('');
const responseMessage = ref(''), responseSection = ref<HTMLElement>();
let controller: AbortController | undefined, requestVersion = 0;

const servers = computed(() => debugServerOptions(props.detail));
const bodyAllowed = computed(() => !['GET', 'HEAD', 'TRACE'].includes(props.detail.method));

const contractAssertion = computed(() =>
  response.value ? validateResponseAgainstOpenApi(props.detail, response.value) : undefined,
);

const responseDiff = computed(() =>
  baselineResponse.value && response.value ? compareApiDebugResponses(baselineResponse.value, response.value) : undefined,
);

const prettyResponseBody = computed(() => {
  const raw = response.value?.body || '';
  if (!response.value || response.value.bodyEncoding === 'base64' || !raw.trim()) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});

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
  timeoutSeconds.value = 30; response.value = undefined; baselineResponse.value = undefined;
  showCurlImport.value = false; curlImportText.value = '';
  responseMessage.value = ''; requestTab.value = 'parameters'; responseTab.value = 'body';
}
watch(() => [props.project.id, props.project.updatedAt, props.detail.key], reset, { immediate: true });
onBeforeUnmount(() => { requestVersion++; controller?.abort(); });

function mergeImportedFields(existing: DebugFieldDraft[], incoming: ApiDebugField[], keepFixed: boolean): DebugFieldDraft[] {
  const next = keepFixed ? existing.map(item => ({ ...item })) : [];
  for (const inc of incoming) {
    const idx = next.findIndex(item => item.name === inc.name);
    if (idx >= 0) {
      next[idx] = { ...next[idx]!, value: inc.value, enabled: inc.enabled };
    } else {
      next.push({ ...emptyDebugField(), name: inc.name, value: inc.value, enabled: inc.enabled });
    }
  }
  return next;
}

function applyCurlImport() {
  try {
    const parsed = parseCurlCommandToDebugDraft(curlImportText.value, props.detail);
    baseUrl.value = parsed.baseUrl;
    if (parsed.pathParameters.length > 0) {
      paths.value = mergeImportedFields(paths.value, parsed.pathParameters, true);
    }
    queries.value = mergeImportedFields(queries.value.filter(f => f.fixedName), parsed.queryParameters, true);
    headers.value = mergeImportedFields(headers.value.filter(f => f.fixedName), parsed.headers, true);
    authKind.value = parsed.auth.kind;
    if (parsed.auth.kind === 'bearer') {
      bearerToken.value = parsed.auth.token;
    } else if (parsed.auth.kind === 'basic') {
      basicUsername.value = parsed.auth.username;
      basicPassword.value = parsed.auth.password;
    } else {
      bearerToken.value = '';
      basicUsername.value = '';
      basicPassword.value = '';
    }
    if (bodyAllowed.value) {
      bodyKind.value = parsed.body.kind;
      if (parsed.body.kind === 'json') {
        bodyText.value = parsed.body.text;
      } else if (parsed.body.kind === 'raw') {
        bodyText.value = parsed.body.text;
        contentType.value = parsed.body.contentType;
      } else if (parsed.body.kind === 'urlencoded') {
        formFields.value = mergeImportedFields(formFields.value.filter(f => f.fixedName), parsed.body.fields, true);
      }
    }
    showCurlImport.value = false;
    curlImportText.value = '';
    if (parsed.methodMismatchWarning) {
      ElMessage.warning(parsed.methodMismatchWarning);
    } else {
      ElMessage.success('已从 cURL 导入服务地址、参数、鉴权与请求体');
    }
  } catch (err) {
    ElMessage.error(errorMessage(err));
  }
}

function pinAsBaseline() {
  if (!response.value) return;
  baselineResponse.value = response.value;
  ElMessage.success('已将当前响应设为对比基准，再次发送请求即可对比字段与耗时变化');
}

function clearBaseline() {
  baselineResponse.value = undefined;
}

function askAiAboutDiscrepancy() {
  if (!response.value || !contractAssertion.value) return;
  emit(
    'askAi',
    buildDebugDiscrepancyAgentPrompt(
      props.detail,
      props.project,
      response.value,
      contractAssertion.value,
      responseDiff.value,
    ),
  );
}

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
const diffKindLabel: Record<string, string> = { added: '新增字段', removed: '移除字段', type_changed: '类型变更', value_changed: '值变更' };
</script>

<template>
  <section class="request-debugger" aria-label="HTTP 请求调试">
    <div class="debug-target">
      <label for="debug-service-url">服务地址</label>
      <el-autocomplete id="debug-service-url" v-model="baseUrl" :fetch-suggestions="suggestServers" :debounce="0" :disabled="sending" :placeholder="servers.length ? '选择或输入联调服务地址' : '输入实际环境的 HTTP 或 HTTPS 地址'" aria-label="服务地址" clearable><template #default="{ item }"><span>{{ item.value }}</span><small v-if="item.description"> · {{ item.description }}</small></template></el-autocomplete>
      <el-button v-if="!sending" type="primary" :disabled="!baseUrl" @click="send"><Send :size="14" />发送请求</el-button>
      <el-button v-else @click="cancel"><Square :size="14" />取消请求</el-button>
      <el-button :disabled="sending" aria-label="导入 cURL" @click="showCurlImport = !showCurlImport"><Terminal :size="14" />{{ showCurlImport ? '收起导入' : '导入 cURL' }}</el-button>
      <el-button :disabled="sending || !baseUrl" aria-label="复制 cURL" @click="copyCurl"><Copy :size="14" />复制 cURL</el-button>
    </div>
    <div v-if="showCurlImport" class="debug-curl-import-box">
      <div class="debug-curl-import-head">
        <span>粘贴浏览器 DevTools「Copy as cURL」或后端日志命令，一键解析地址、路径参数、Query、Bearer/Basic 鉴权与请求体：</span>
        <div class="debug-curl-import-actions">
          <el-button size="small" @click="showCurlImport = false">取消</el-button>
          <el-button size="small" type="primary" :disabled="!curlImportText.trim()" @click="applyCurlImport">解析并填入</el-button>
        </div>
      </div>
      <el-input
        v-model="curlImportText"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 8 }"
        placeholder="curl --request POST 'http://127.0.0.1:8080/api/v1/orders/42?dryRun=true' -H 'Authorization: Bearer ...' --data-raw '{&quot;sku&quot;:&quot;A1&quot;}'"
        spellcheck="false"
      />
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
      <header>
        <h3>响应</h3>
        <template v-if="response">
          <el-tag :type="response.status >= 400 ? 'danger' : response.status >= 300 ? 'warning' : 'success'" size="small">{{ response.status }} {{ response.statusText }}</el-tag>
          <span>{{ response.durationMs }} ms</span>
          <span>{{ sizeLabel(response.sizeBytes) }}</span>
          <el-tag v-if="response.truncated" size="small" type="info">仅显示前 2 MB</el-tag>
          <button
            v-if="contractAssertion"
            type="button"
            class="debug-assertion-pill"
            :class="contractAssertion.passed ? 'is-pass' : 'is-fail'"
            @click="responseTab = 'assertions'"
          >
            <Check v-if="contractAssertion.passed" :size="12" />
            <ShieldAlert v-else :size="12" />
            <span>{{ contractAssertion.summary }}</span>
          </button>
        </template>
        <div v-if="response" class="debug-response-actions">
          <el-button text size="small" title="固定当前响应为对比基准，用于对比改代码前后的字段与耗时差异" @click="pinAsBaseline">
            <Bookmark :size="13" />{{ baselineResponse ? '更新基准' : '设为基准' }}
          </el-button>
          <el-button v-if="baselineResponse" text size="small" @click="clearBaseline">清除基准</el-button>
          <el-button
            v-if="canAskAi && (!contractAssertion?.passed || response.status >= 400)"
            text
            type="primary"
            size="small"
            @click="askAiAboutDiscrepancy"
          >
            <Sparkles :size="13" />AI 排查偏差
          </el-button>
          <el-button text size="small" aria-label="复制响应原文" @click="copyResponse"><Copy :size="13" />复制响应</el-button>
        </div>
      </header>
      <el-empty v-if="!response && !sending" :description="responseMessage || '发送请求后查看响应'" :image-size="58" />
      <el-tabs v-else-if="response" v-model="responseTab" class="debug-tabs">
        <el-tab-pane :label="response.bodyEncoding === 'base64' ? '响应原文（Base64）' : '响应原文'" name="body">
          <pre class="debug-response-body">{{ prettyResponseBody }}</pre>
        </el-tab-pane>
        <el-tab-pane
          v-if="contractAssertion"
          :label="`契约断言 (${contractAssertion.passedCount}/${contractAssertion.checkedCount})`"
          name="assertions"
        >
          <div class="debug-assertion-panel">
            <ul class="debug-check-list">
              <li v-for="chk in contractAssertion.checks" :key="chk.id" :class="chk.passed ? 'is-ok' : 'is-err'">
                <strong>{{ chk.passed ? '✓' : '✕' }} {{ chk.label }}</strong>
                <span>{{ chk.detail }}</span>
              </li>
            </ul>
            <div v-if="contractAssertion.issues.length" class="debug-issue-list">
              <h4>字段与结构偏差明细</h4>
              <div v-for="(issue, idx) in contractAssertion.issues" :key="idx" class="debug-issue-row">
                <code>{{ issue.jsonPath }}</code>
                <span>{{ issue.message }}</span>
                <small>期望：<code>{{ issue.expected }}</code> · 实测：<code>{{ issue.actual }}</code></small>
              </div>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane
          v-if="responseDiff"
          :label="`基准对比 (${responseDiff.identical ? '无变化' : `Δ ${responseDiff.changes.length}`})`"
          name="diff"
        >
          <div class="debug-diff-panel">
            <div class="debug-diff-summary">
              <span><Layers :size="13" /> {{ responseDiff.summary }}</span>
              <span class="debug-diff-metrics">
                耗时变化：{{ responseDiff.durationDeltaMs >= 0 ? `+${responseDiff.durationDeltaMs}` : responseDiff.durationDeltaMs }} ms ·
                体积变化：{{ responseDiff.sizeDeltaBytes >= 0 ? `+${responseDiff.sizeDeltaBytes}` : responseDiff.sizeDeltaBytes }} B
              </span>
            </div>
            <div v-if="responseDiff.changes.length" class="debug-diff-list">
              <div v-for="(ch, idx) in responseDiff.changes" :key="idx" class="debug-diff-row" :data-kind="ch.kind">
                <span class="debug-diff-kind">{{ diffKindLabel[ch.kind] || ch.kind }}</span>
                <code class="debug-diff-path">{{ ch.path }}</code>
                <span class="debug-diff-values">
                  <del v-if="ch.kind !== 'added'">{{ ch.beforePreview }}</del>
                  <span v-if="ch.kind !== 'added' && ch.kind !== 'removed'">→</span>
                  <ins v-if="ch.kind !== 'removed'">{{ ch.afterPreview }}</ins>
                </span>
              </div>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="`响应头 (${response.headers.length})`" name="headers">
          <dl class="debug-response-headers"><template v-for="(header, index) in response.headers" :key="index"><dt>{{ header.name }}</dt><dd>{{ header.value }}</dd></template></dl>
        </el-tab-pane>
      </el-tabs>
    </section>
  </section>
</template>

<style scoped>
.request-debugger{min-width:0;font-size:12px;color:var(--ui-text)}.debug-target{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.debug-target>label{font-size:12px;flex-shrink:0}.debug-target>.el-autocomplete{flex:1;min-width:230px}.debug-target>.el-button{margin:0;gap:5px}.debug-request-line{display:flex;gap:10px;align-items:flex-start;margin:14px 0;line-height:1.7}.debug-request-line>strong{color:var(--el-color-primary);font-size:11px;flex-shrink:0}.debug-request-line>code{overflow-wrap:anywhere;flex:1;min-width:0}.debug-request-line>span{color:var(--ui-muted);white-space:nowrap}.debug-tabs :deep(.el-tabs__item){font-size:12px;padding:0 12px}.debug-fields{margin-bottom:18px}.debug-fields>header,.debug-response>header{display:flex;align-items:center;gap:10px;min-height:32px;flex-wrap:wrap}.debug-fields h3,.debug-response h3{font-size:12px;font-weight:600;margin:0}.debug-fields>header>.el-button{margin-left:auto;gap:4px}.debug-field-row{display:flex;align-items:center;gap:8px;margin:8px 0;min-width:0}.debug-field-row>.el-checkbox{margin:0;flex-shrink:0}.debug-field-row>.el-input{flex:1;min-width:0}.debug-field-row>.el-input:nth-of-type(2){flex:1.5}.debug-required{width:25px;flex-shrink:0;font-size:10px;color:var(--ui-muted)}.debug-field-row>.el-button{margin:0;padding:5px;width:24px;flex-shrink:0}.debug-remove-space{width:24px;flex-shrink:0}.debug-muted{color:var(--ui-muted);font-size:12px;line-height:1.7}.debug-auth{max-width:520px;padding-top:6px}.debug-auth :deep(.el-form-item__label){font-size:12px}.debug-content-type{display:flex;gap:12px;align-items:center;margin:14px 0}.debug-content-type>label{flex-shrink:0}.debug-body-input{margin-top:14px}.debug-body-input :deep(textarea){font:12px/1.7 var(--ds-code,monospace)}.debug-options{display:flex;align-items:center;gap:12px;padding:10px 0 18px;color:var(--ui-muted)}.debug-options>.el-input-number{width:110px}.debug-response{border-top:1px solid var(--ui-border);padding-top:14px;min-height:160px}.debug-response>header>span{color:var(--ui-muted);font-size:11px}.debug-response-actions{margin-left:auto;display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}.debug-response-actions :deep(.el-button){margin:0;gap:4px}.debug-response-body{font:12px/1.75 var(--ds-code,monospace);margin:0;max-height:480px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;min-height:24px}.debug-response-headers{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,3fr);gap:10px 16px;font:11px/1.7 var(--ds-code,monospace);max-height:480px;overflow:auto}.debug-response-headers>dt{color:var(--ui-muted);overflow-wrap:anywhere}.debug-response-headers>dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.debug-curl-import-box{margin:8px 0 12px;padding:10px 12px;border:1px solid var(--ui-border);border-radius:8px;background:color-mix(in srgb,var(--ui-raised) 65%,var(--ui-surface));display:flex;flex-direction:column;gap:8px}
.debug-curl-import-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--ui-secondary)}
.debug-curl-import-actions{display:inline-flex;gap:6px}
.debug-curl-import-box :deep(textarea){font:11.5px/1.6 var(--ds-code,monospace)}
.debug-assertion-pill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:5px;border:1px solid var(--ui-border);background:var(--ui-raised);font:600 11px/1 var(--sans);cursor:pointer}
.debug-assertion-pill.is-pass{border-color:color-mix(in srgb,var(--ui-success) 36%,var(--ui-border));background:var(--ui-success-bg);color:var(--ui-success)}
.debug-assertion-pill.is-fail{border-color:color-mix(in srgb,var(--ui-danger) 38%,var(--ui-border));background:var(--ui-danger-bg);color:var(--ui-danger)}
.debug-assertion-panel,.debug-diff-panel{display:flex;flex-direction:column;gap:12px;padding:4px 0}
.debug-check-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.debug-check-list li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:6px 10px;border-radius:6px;border:1px solid var(--ui-border);background:var(--ui-raised)}
.debug-check-list li.is-ok strong{color:var(--ui-success)}
.debug-check-list li.is-err strong{color:var(--ui-danger)}
.debug-issue-list{display:flex;flex-direction:column;gap:6px}
.debug-issue-list h4{margin:4px 0;font-size:12px}
.debug-issue-row{display:flex;flex-direction:column;gap:3px;padding:7px 10px;border-radius:6px;border:1px solid color-mix(in srgb,var(--ui-danger) 32%,var(--ui-border));background:var(--ui-danger-bg)}
.debug-issue-row>code{font:600 11.5px/1.4 var(--mono);color:var(--ui-danger)}
.debug-issue-row>small{color:var(--ui-secondary)}
.debug-diff-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:7px 10px;border-radius:6px;border:1px solid var(--ui-border);background:var(--ui-raised)}
.debug-diff-summary>span{display:inline-flex;align-items:center;gap:5px;font-weight:600}
.debug-diff-metrics{font:500 11px/1.4 var(--mono);color:var(--ui-secondary);font-weight:500 !important}
.debug-diff-list{display:flex;flex-direction:column;gap:5px;max-height:360px;overflow:auto}
.debug-diff-row{display:grid;grid-template-columns:72px minmax(120px,1.2fr) minmax(0,2fr);gap:8px;align-items:baseline;padding:6px 10px;border-radius:6px;border:1px solid var(--ui-border);background:var(--ui-surface);font-size:11.5px}
.debug-diff-kind{font-weight:600;font-size:10.5px}
.debug-diff-row[data-kind='added'] .debug-diff-kind{color:var(--ui-success)}
.debug-diff-row[data-kind='removed'] .debug-diff-kind{color:var(--ui-danger)}
.debug-diff-row[data-kind='type_changed'] .debug-diff-kind,.debug-diff-row[data-kind='value_changed'] .debug-diff-kind{color:var(--ui-warning)}
.debug-diff-path{font:600 11px/1.4 var(--mono);overflow-wrap:anywhere}
.debug-diff-values{display:inline-flex;align-items:baseline;gap:6px;flex-wrap:wrap;font:11px/1.4 var(--mono);overflow-wrap:anywhere}
.debug-diff-values del{color:var(--ui-danger);text-decoration:line-through}
.debug-diff-values ins{color:var(--ui-success);text-decoration:none}
@media(max-width:650px){.debug-target>.el-autocomplete{flex-basis:calc(100% - 65px)}.debug-target>.el-button{font-size:11px;padding:8px 10px}.debug-field-row{gap:5px}.debug-field-row :deep(.el-input__inner){font-size:11px}.debug-required{width:22px;font-size:9px}.debug-response-headers{grid-template-columns:90px minmax(0,1fr)}.debug-diff-row{grid-template-columns:1fr}}
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
