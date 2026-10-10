<script setup lang="ts">
/** 交付设置中的单一执行器卡片：显示真实进程与持久会话；任务业务详情仍留在各自队列。 */
import { computed } from 'vue';
import { useCliExecutor } from './useCliExecutor';
import QueryState from '../../shared/ui/QueryState.vue';
const { query, changing, change } = useCliExecutor();
const { data, isPending, error } = query;
const label = computed(() => data.value?.status === 'running' ? '运行中' : data.value?.status === 'draining' ? '等待当前任务结束' : data.value?.status === 'blocked' ? '需要处理' : '已暂停');
</script>
<template>
  <section class="surface cli-card">
    <div class="surface-header"><div><h2>Codex CLI 执行器</h2><p>本机执行 · 持久会话 · 同任务续跑</p></div><el-tag :type="data?.status === 'running' ? 'success' : 'info'">{{ label }}</el-tag></div>
    <div class="surface-body">
      <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()">
        <template v-if="data">
          <p class="cli-description">Jira、追平还原、分支合入由 CLI 执行；技术方案保留 Mastra 分阶段门禁，也使用同一本机 CLI。关闭网页不影响执行。</p>
          <div class="cli-facts"><span>CLI {{ data.version || '不可用' }} · {{ data.authenticated ? '已登录' : '未登录' }}</span><span>队列并发上限 {{ data.maxConcurrent }} · 同一工作区串行</span></div>
          <p class="cli-path">会话目录：{{ data.codexHome }}</p>
          <p class="cli-description">CLI 任务共用桌面端会话目录，可在 Codex 查看和续聊；运行中请勿同时在桌面端发送新指令。</p>
          <el-alert v-if="data.error" :title="data.error" type="error" :closable="false" show-icon />
          <el-table v-if="data.runs.length" :data="data.runs" size="small">
            <el-table-column prop="jobId" label="已领取任务" min-width="190" /><el-table-column prop="phase" label="执行阶段" min-width="120" />
            <el-table-column prop="threadId" label="Codex 会话 ID" min-width="290" /><el-table-column prop="pid" label="进程 PID" width="100" />
          </el-table>
          <p v-else class="cli-description">当前没有本执行器持有的任务。历史结果和待审核内容仍在各业务队列中。</p>
          <div class="cli-actions"><el-button type="primary" :disabled="data.status === 'running' || data.status === 'draining' || !data.authenticated" :loading="changing" @click="change('start')">启动已授权队列</el-button><el-button :disabled="data.status !== 'running'" :loading="changing" @click="change('pause')">暂停新任务领取</el-button></div>
        </template>
      </QueryState>
    </div>
  </section>
</template>
<style scoped>
.cli-card{margin-bottom:24px;border-top:3px solid var(--el-color-primary)}.cli-description,.cli-path{color:var(--ui-muted);font-size:12px;line-height:1.9}.cli-path{overflow-wrap:anywhere}.cli-facts{display:flex;gap:24px;flex-wrap:wrap;color:var(--ui-secondary);font-size:13px}.cli-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
</style>
