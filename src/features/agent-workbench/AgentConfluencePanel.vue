<script setup lang="ts">
import AgentMarkdown from './AgentMarkdown.vue';
/** Confluence 复用知识侧栏与标准预览；配置只保存当前工作区的搜索范围。 */
import { shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, X } from '@lucide/vue';
import type { ConfluencePageContent, ConfluenceScope } from '../../../shared/confluence-knowledge';
import { confluenceRequest, useConfluenceKnowledge } from './useConfluenceKnowledge';

const props = defineProps<{ workspacePath: string; relatedText: string }>();
const emit = defineEmits<{ compose: [prompt: string] }>();
const knowledge = useConfluenceKnowledge(() => props.workspacePath, () => props.relatedText);
const scope = shallowRef<ConfluenceScope>({ spaceKey: '', requirementParentId: '', designParentId: '' });
const saving = shallowRef(false);
const reference = shallowRef('');
const preview = shallowRef<ConfluencePageContent>();
const previewLoading = shallowRef(false);
watch(() => knowledge.config.data.value, value => { scope.value = value ? { ...value.scope } : { spaceKey: '', requirementParentId: '', designParentId: '' }; }, { immediate: true });
watch(() => knowledge.config.error.value || knowledge.pages.error.value || knowledge.related.error.value,
  error => { if (error) ElMessage.error(error.message); });
watch(() => props.workspacePath, () => { reference.value = ''; });
watch(() => knowledge.related.data.value?.unavailable, count => { if (count) ElMessage.error('部分关联文档无法读取，请检查原链接及访问权限'); });
watch(reference, async (value, _old, onCleanup) => {
  preview.value = undefined;
  previewLoading.value = false;
  if (!value) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  previewLoading.value = true;
  try { preview.value = await confluenceRequest<ConfluencePageContent>(`page?reference=${encodeURIComponent(value)}`, undefined, controller.signal); }
  catch (error) { if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { if (!controller.signal.aborted) previewLoading.value = false; }
});
async function saveScope() {
  saving.value = true;
  try { await knowledge.configure({ ...scope.value }); ElMessage.success('已保存当前工作区的检索范围'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { saving.value = false; }
}
function cite() {
  const page = preview.value;
  if (!page) return;
  emit('compose', `@${page.reference} ${page.title}（v${page.version}）\n${page.url}\n`);
  reference.value = '';
}
</script>

<template>
  <section class="confluence-panel" aria-label="Confluence 文档知识库">
    <header>
      <details class="confluence-scope">
        <summary>检索范围 · {{ knowledge.config.data.value?.scope.spaceKey || '全部可访问空间' }}</summary>
        <a v-if="knowledge.config.data.value" :href="knowledge.config.data.value.site" target="_blank" rel="noopener noreferrer">{{ knowledge.config.data.value.site }}</a>
        <label>空间 Key<input v-model="scope.spaceKey" placeholder="例如 SOP，留空搜索全部空间" maxlength="100" :disabled="saving" /></label>
        <label>需求目录<input v-model="scope.requirementParentId" placeholder="父页面 ID 或链接，可留空" maxlength="2000" :disabled="saving" /></label>
        <label>方案目录<input v-model="scope.designParentId" placeholder="父页面 ID 或链接，可留空" maxlength="2000" :disabled="saving" /></label>
        <el-button size="small" :loading="saving" :disabled="!workspacePath || knowledge.config.isFetching.value" @click="saveScope">保存到当前工作区</el-button>
      </details>
      <label class="confluence-search"><select v-model="knowledge.field.value" aria-label="Confluence 检索字段"><option value="title">标题</option><option value="text">正文</option></select><Search :size="14" /><input v-model="knowledge.search.value" type="search" placeholder="搜索 Confluence 标题或正文" aria-label="搜索 Confluence 标题或正文" maxlength="200" /><button v-if="knowledge.search.value" type="button" aria-label="清空 Confluence 搜索" @click="knowledge.search.value = ''"><X :size="13" /></button></label>
    </header>
    <div class="confluence-results">
      <template v-if="!knowledge.search.value && knowledge.related.data.value?.pages.length">
        <h4>当前任务关联文档</h4>
        <button v-for="page in knowledge.related.data.value.pages" :key="page.reference" type="button" class="confluence-result" @click="reference = page.reference"><strong>{{ page.title }}</strong><small>{{ page.spaceKey }} · v{{ page.version }}</small></button>
      </template>
      <el-skeleton v-if="knowledge.config.isFetching.value || knowledge.pages.isFetching.value" :rows="6" animated />
      <el-empty v-else-if="knowledge.config.error.value || knowledge.pages.error.value" description="来源读取失败" :image-size="48" />
      <template v-else>
        <h4 v-if="!knowledge.search.value">最近更新</h4>
        <button v-for="page in knowledge.pages.data.value?.pages || []" :key="page.reference" type="button" class="confluence-result" @click="reference = page.reference">
          <strong>{{ page.title }}</strong><small>{{ page.spaceKey }} · v{{ page.version }}<template v-if="page.updatedAt"> · {{ page.updatedAt.slice(0, 10) }}</template></small>
        </button>
        <el-empty v-if="!knowledge.pages.data.value?.pages.length" description="没有匹配文档" :image-size="48" />
      </template>
    </div>
    <footer v-if="knowledge.start.value || knowledge.pages.data.value?.hasMore" class="confluence-pagination">
      <button type="button" :disabled="!knowledge.start.value || knowledge.pages.isFetching.value" @click="knowledge.start.value -= 12">上一页</button><span>{{ knowledge.start.value / 12 + 1 }}</span><button type="button" :disabled="!knowledge.pages.data.value?.hasMore || knowledge.pages.isFetching.value" @click="knowledge.start.value += 12">下一页</button>
    </footer>
    <el-dialog :model-value="!!reference" title="Confluence 文档预览" width="min(760px, 92vw)" append-to-body @update:model-value="!$event && (reference = '')">
      <el-skeleton v-if="previewLoading" :rows="6" animated />
      <template v-else-if="preview">
        <h3>{{ preview.title }}</h3><p class="confluence-metadata">{{ preview.spaceKey }} · v{{ preview.version }} · {{ preview.updatedAt }}</p>
        <AgentMarkdown class="confluence-preview" :source="preview.content" />
        <p v-if="preview.truncated">预览已截断，请打开原文查看完整文档。</p>
      </template>
      <template #footer><a v-if="preview" :href="preview.url" target="_blank" rel="noopener noreferrer">打开原文</a><el-button @click="reference = ''">关闭</el-button><el-button type="primary" :disabled="!preview || preview.truncated || preview.content.length > 40000" @click="cite">引用到输入框</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.confluence-panel{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.confluence-panel header{flex-shrink:0}.confluence-scope{margin-bottom:12px;color:var(--agent-muted);font-size:12px}.confluence-scope summary{cursor:pointer}.confluence-scope a{display:block;margin:8px 0;overflow-wrap:anywhere}.confluence-scope label{display:grid;gap:4px;margin:8px 0}.confluence-scope input{box-sizing:border-box;width:100%;height:30px;padding:0 7px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-bg);color:var(--agent-text);font-size:12px}
.confluence-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 9px;border:1px solid var(--agent-border);border-radius:7px;background:var(--agent-bg);color:var(--agent-muted)}.confluence-search select{max-width:55px;border:0;background:var(--agent-bg);color:var(--agent-secondary);font-size:12px}.confluence-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--agent-text);font-size:12px}.confluence-search input::-webkit-search-cancel-button{display:none}.confluence-search button{display:flex;padding:0;border:0;background:transparent;color:inherit;cursor:pointer}
.confluence-results{flex:1;min-height:0;overflow:auto;margin-top:10px}.confluence-results h4{margin:8px 0;font-size:12px;color:var(--agent-muted);font-weight:500}.confluence-result{display:grid;gap:4px;width:100%;padding:10px 0;text-align:left;border:0;border-bottom:1px solid var(--agent-border);background:transparent;color:var(--agent-text);cursor:pointer}.confluence-result:hover strong{text-decoration:underline}.confluence-result strong{font-size:13px;font-weight:500;line-height:1.6;overflow-wrap:anywhere}.confluence-result small,.confluence-results>small{font-size:11px;color:var(--agent-muted)}.confluence-pagination{display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding-top:10px;font-size:12px;color:var(--agent-muted)}.confluence-pagination button{padding:5px 9px;border:1px solid var(--agent-border);border-radius:5px;background:var(--agent-bg);color:var(--agent-text);cursor:pointer}.confluence-pagination button:disabled{opacity:.4;cursor:default}
.confluence-preview{max-height:52vh;overflow:auto;overflow-wrap:anywhere;font-size:13px;line-height:1.7}.confluence-metadata{font-size:12px;color:var(--agent-muted)}:deep(.el-dialog__footer)>a{margin-right:12px}
</style>
