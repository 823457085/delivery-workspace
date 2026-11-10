<script setup lang="ts">
import { ExternalLink } from '@lucide/vue';
import { RouterLink } from 'vue-router';
import { safeUrl, shortPath } from '../../shared/format';
import AgentCursorButton from './AgentCursorButton.vue';

defineProps<{ path: string; fileCount: number; branch: string; remote?: string; url?: string; head?: string; ahead?: number | null; pushTarget?: boolean }>();
</script>

<template>
  <article class="code-artifact" aria-label="代码产物">
    <header><strong>代码</strong><slot /></header>
    <p>{{ fileCount }} 个待提交文件<template v-if="ahead && ahead > 0"> · {{ ahead }} 个领先提交</template></p>
    <p :title="path">{{ shortPath(path) }}</p>
    <p v-if="pushTarget">目标：{{ remote || '未配置远端' }} / {{ branch || '未识别分支' }}</p>
    <p v-else>分支：{{ branch || '分离 HEAD' }}<template v-if="head"> · <code :title="head">{{ head.slice(0, 8) }}</code></template></p>
    <div class="code-artifact-actions">
      <AgentCursorButton :workspace-path="path" size="small" />
      <RouterLink :to="{ path: '/agent', query: { view: 'projects', q: path, workspace: path, git: '1' } }">项目与 Git 查看</RouterLink>
      <a v-if="safeUrl(url)" :href="safeUrl(url)" target="_blank" rel="noopener noreferrer">远端仓库 <ExternalLink :size="12" /></a>
    </div>
  </article>
</template>

<style scoped>
.code-artifact{min-width:0;padding:12px;border:1px solid var(--agent-border);border-radius:8px;color:var(--agent-secondary);font-size:12px;line-height:1.7}
.code-artifact>header,.code-artifact-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}
.code-artifact>header{justify-content:space-between}.code-artifact>header strong{color:var(--agent-text)}
.code-artifact p{margin:8px 0;overflow-wrap:anywhere}.code-artifact-actions :deep(.el-button){margin:0}
.code-artifact-actions a{display:inline-flex;align-items:center;gap:4px;color:var(--agent-accent);text-decoration:none}
</style>
