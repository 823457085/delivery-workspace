<script setup lang="ts">
/** 侧栏只编排分类、搜索与结果；不混入笔记库，长描述交给结果行按需展开。 */
import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, Folder, X } from '@lucide/vue';
import type { AgentProvider } from '../../../shared/agent-runtime';
import { useAgentKnowledgeSearch } from './useAgentKnowledgeSearch';
import { useKnowledgeCatalog } from './useKnowledgeCatalog';
import AgentKnowledgeResults from './AgentKnowledgeResults.vue';
const props = defineProps<{ workspacePath: string; provider: AgentProvider }>();
const emit = defineEmits<{ compose: [prompt: string] }>();
const knowledge = useAgentKnowledgeSearch(() => props.workspacePath, () => props.provider);
const { tab, source, directory, directories, page, pages, entries, visible } = useKnowledgeCatalog(knowledge, () => props.workspacePath);
const workspaceName = computed(() => props.workspacePath.split('/').filter(Boolean).at(-1) || '尚未选择工作区');
const placeholder = computed(() => tab.value === 'skills' ? '搜索 Skill 名称或描述' : tab.value === 'files' ? '搜索文件名或路径' : '搜索文件正文（至少 2 个字）');
watch(knowledge.error, error => { if (error) ElMessage.error(error); });
</script>
<template>
  <section class="knowledge-panel" aria-label="Agent 知识检索">
    <header class="knowledge-toolbar">
      <details class="knowledge-scope">
        <summary><Folder :size="13" /><span :title="workspacePath">{{ workspaceName }}</span><small>{{ knowledge.scope.value.branch }}</small></summary>
        <p>{{ workspacePath }}<br v-if="knowledge.scope.value.headSha" />{{ knowledge.scope.value.headSha }}</p>
      </details>
      <div class="knowledge-tabs" role="group" aria-label="知识分类">
        <button type="button" :aria-pressed="tab === 'skills'" @click="tab = 'skills'">Skills <small>{{ knowledge.skills.value.length }}</small></button>
        <button type="button" :aria-pressed="tab === 'files'" @click="tab = 'files'">文件 <small>{{ knowledge.files.value.length }}</small></button>
        <button type="button" :aria-pressed="tab === 'matches'" @click="tab = 'matches'">正文检索</button>
      </div>
      <label class="knowledge-search"><Search :size="14" /><input v-model="knowledge.search.value" type="search" :placeholder="placeholder" :aria-label="placeholder" maxlength="200" /><button v-if="knowledge.search.value" type="button" aria-label="清空搜索" @click="knowledge.search.value = ''"><X :size="13" /></button></label>
      <div class="knowledge-filter">
        <select v-if="tab === 'skills'" v-model="source" aria-label="Skill 来源"><option value="">全部来源</option><option value="project">当前项目</option><option value="personal">个人</option><option value="system">系统</option><option value="plugin">插件</option></select>
        <select v-else-if="tab === 'files'" v-model="directory" aria-label="文件目录"><option value="">全部目录</option><option v-for="item in directories" :key="item" :value="item">{{ item === '.' ? '根目录' : item }}</option></select>
        <span>{{ entries.length }} 项结果</span>
      </div>
    </header>
    <div :key="`${tab}:${page}:${source}:${directory}:${knowledge.search.value}:${workspacePath}`" class="knowledge-body">
      <el-skeleton v-if="knowledge.loading.value" :rows="6" animated />
      <el-empty v-else-if="!workspacePath" description="先选择工作区" :image-size="48" />
      <el-empty v-else-if="knowledge.error.value" description="来源读取失败" :image-size="48" />
      <el-empty v-else-if="tab === 'matches' && knowledge.search.value.trim().length < 2" description="输入关键词检索文件正文" :image-size="48" />
      <AgentKnowledgeResults v-else-if="visible.length" :entries="visible" @compose="emit('compose', $event)" />
      <el-empty v-else :description="tab === 'skills' && provider !== 'codex' ? '当前执行器没有可用 Skills' : '没有匹配结果'" :image-size="48" />
      <p v-if="tab === 'matches' && knowledge.truncated.value" class="knowledge-limit">结果已截断，请增加关键词缩小范围。</p>
      <p v-if="tab === 'files' && knowledge.files.value.length === 60" class="knowledge-limit">当前返回前 60 项，可搜索文件名或路径继续查找。</p>
    </div>
    <footer v-if="pages > 1" class="knowledge-pagination"><button type="button" :disabled="page === 1" @click="page--">上一页</button><span>{{ page }} / {{ pages }}</span><button type="button" :disabled="page === pages" @click="page++">下一页</button></footer>
  </section>
</template>
<style scoped>
.knowledge-panel{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;padding:14px 16px;background:var(--agent-panel);color:var(--agent-text)}
.knowledge-toolbar{flex-shrink:0}.knowledge-scope{margin-bottom:12px;color:var(--agent-muted);font-size:12px}.knowledge-scope summary{display:flex;align-items:center;gap:6px;cursor:pointer}.knowledge-scope summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;color:var(--agent-secondary)}.knowledge-scope small{margin-left:auto;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.knowledge-scope p{overflow-wrap:anywhere;line-height:1.5}
.knowledge-tabs{display:flex;gap:4px;margin-bottom:12px;padding:3px;border-radius:8px;background:var(--agent-bg)}.knowledge-tabs button{flex:1;min-width:0;padding:7px 3px;border:0;border-radius:6px;background:transparent;color:var(--agent-muted);font-size:12px;cursor:pointer}.knowledge-tabs button[aria-pressed=true]{background:var(--agent-panel-strong);color:var(--agent-text)}.knowledge-tabs small{margin-left:3px;font-size:10px;color:var(--agent-muted)}
.knowledge-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 9px;border:1px solid var(--agent-border);border-radius:7px;background:var(--agent-bg);color:var(--agent-muted)}.knowledge-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--agent-text);font-size:12px}.knowledge-search input::placeholder{color:var(--agent-muted)}.knowledge-search button{display:flex;padding:0;border:0;background:transparent;color:inherit;cursor:pointer}
.knowledge-filter{display:flex;align-items:center;gap:8px;margin:10px 0;font-size:11px;color:var(--agent-muted)}.knowledge-filter select{min-width:0;max-width:70%;height:28px;padding:0 6px;border:1px solid var(--agent-border);border-radius:5px;background:var(--agent-bg);color:var(--agent-secondary);font-size:12px}.knowledge-filter>span{margin-left:auto;white-space:nowrap}
.knowledge-body{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin}.knowledge-limit{font-size:11px;line-height:1.5;color:var(--agent-muted)}.knowledge-pagination{display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding-top:10px;color:var(--agent-muted);font-size:12px}.knowledge-pagination button{border:1px solid var(--agent-border);border-radius:5px;padding:5px 9px;background:var(--agent-bg);color:var(--agent-text);cursor:pointer}.knowledge-pagination button:disabled{opacity:.4;cursor:default}.knowledge-panel :deep(.el-skeleton__item){background:var(--agent-panel-strong)}
</style>
