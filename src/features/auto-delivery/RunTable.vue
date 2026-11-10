<script setup lang="ts">
import type { ScanRun } from '../../../shared/hub';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
defineProps<{ items: ScanRun[] }>();
defineEmits<{ inspect: [item: ScanRun] }>();
</script>
<template>
  <template v-if="items.length">
    <el-table :data="items" row-key="id" class="execution-desktop">
      <el-table-column label="运行时间" min-width="150"><template #default="{ row }"><strong class="row-title">{{ dateTime(row.completedAt || row.startedAt) }}</strong><span class="row-secondary">{{ row.localDate }}</span></template></el-table-column>
      <el-table-column label="触发 / 数据来源" width="160"><template #default="{ row }">{{ row.trigger === 'schedule' ? '定时巡检' : row.trigger === 'callback' ? '完成回传' : '手动巡检' }}<span class="row-secondary"><StatusPill :value="row.source" :label="row.source" /></span></template></el-table-column>
      <el-table-column label="Jira / 工作区" min-width="180"><template #default="{ row }"><strong class="row-title">{{ row.issueCount }} 项 / {{ row.workspaceCount }} 个</strong><span class="row-secondary">识别已做过 {{ row.alreadyDoneCount }} 项</span></template></el-table-column>
      <el-table-column label="新增队列" width="110"><template #default="{ row }">{{ row.enqueuedCount }} 个</template></el-table-column>
      <el-table-column label="Jira 推进结果" min-width="170"><template #default="{ row }"><el-tag type="success" effect="plain">更新 {{ row.transitionUpdatedCount }}</el-tag><span class="row-secondary">阻塞 {{ row.transitionBlockedCount }}</span></template></el-table-column>
      <el-table-column label="明细" width="72"><template #default="{ row }"><el-button link type="primary" @click="$emit('inspect', row)">查看</el-button></template></el-table-column>
    </el-table>
    <ul class="execution-cards">
      <li v-for="item in items" :key="item.id" class="execution-card">
        <div class="execution-card-header"><strong class="execution-card-title">{{ dateTime(item.completedAt || item.startedAt) }}</strong><StatusPill :value="item.source" :label="item.source" /></div>
        <p class="execution-card-meta">{{ item.localDate }} · {{ item.trigger === 'schedule' ? '定时巡检' : item.trigger === 'callback' ? '完成回传' : '手动巡检' }}</p>
        <dl class="execution-card-facts">
          <div><dt>Jira / 工作区</dt><dd>{{ item.issueCount }} 项 / {{ item.workspaceCount }} 个</dd></div>
          <div><dt>识别已做过</dt><dd>{{ item.alreadyDoneCount }} 项</dd></div>
          <div><dt>新增队列</dt><dd>{{ item.enqueuedCount }} 个</dd></div>
          <div><dt>Jira 推进结果</dt><dd>更新 {{ item.transitionUpdatedCount }} · 阻塞 {{ item.transitionBlockedCount }}</dd></div>
        </dl>
        <div class="execution-card-actions"><el-button link type="primary" @click="$emit('inspect', item)">查看</el-button></div>
      </li>
    </ul>
  </template>
  <slot v-else name="empty"><el-empty description="当前范围没有巡检日志" :image-size="56" /></slot>
</template>
