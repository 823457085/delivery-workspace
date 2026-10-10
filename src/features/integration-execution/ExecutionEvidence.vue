<script setup lang="ts">
/** 证据表只呈现台账实测结论，运行完成不转换为接口通过；链接限于已有本地证据目录。 */
import { computed, shallowRef } from 'vue';
import type { IntegrationScopeCategory } from '../../../shared/apex-integration-scope';
import type { ExecutionProgress, ExecutionInterface } from './execution-plan';
const props = defineProps<{ progress: ExecutionProgress; interfaces: ExecutionInterface[]; reviewStatus: Record<string, string> }>();
const tab = shallowRef('issues');
const category = shallowRef<IntegrationScopeCategory | ''>('');
const filteredInterfaces = computed(() => props.interfaces.filter(item => !category.value || item.category === category.value));
function evidenceUrl(value?: string) { return value?.startsWith('/integration-runs/') && !/[\\\s]/.test(value) ? value : undefined; }
</script>

<template>
  <section class="execution-evidence surface">
    <el-tabs v-model="tab">
      <el-tab-pane :label="`问题与截图（${progress.issues.length}）`" name="issues">
        <el-table :data="progress.issues" row-key="id" empty-text="尚未发现问题">
          <el-table-column label="问题" min-width="290"><template #default="{ row }"><strong>{{ row.id }}</strong><p>{{ row.summary }}</p><small>{{ row.kind }}</small></template></el-table-column>
          <el-table-column label="状态" min-width="150"><template #default="{ row }">{{ row.status }}<small v-if="row.deferredReason" class="task-detail">暂不联调 · {{ row.deferredReason }}</small></template></el-table-column>
          <el-table-column label="群反馈" prop="notification" min-width="240" />
          <el-table-column label="现场证据" width="140"><template #default="{ row }"><a v-if="evidenceUrl(row.report || row.description)" :href="evidenceUrl(row.report || row.description)" target="_blank" rel="noreferrer">查看说明</a><a v-if="evidenceUrl(row.screenshot)" :href="evidenceUrl(row.screenshot)" target="_blank" rel="noreferrer">问题截图</a></template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane :label="`接口（${interfaces.length}）`" name="interfaces">
        <el-select v-model="category" clearable placeholder="全部联调分类" aria-label="执行接口分类" class="category-filter"><el-option label="本轮联调" value="本轮联调" /><el-option label="暂不联调" value="暂不联调" /></el-select>
        <el-table :data="filteredInterfaces" row-key="id" empty-text="当前分类没有接口">
          <el-table-column label="模块" prop="module" min-width="120" />
          <el-table-column label="菜单 / 页面" prop="page" min-width="190" />
          <el-table-column label="请求" prop="request" min-width="340" />
          <el-table-column label="联调分类" min-width="150"><template #default="{ row }">{{ row.category }}<small v-if="row.deferredReason" class="task-detail">{{ row.deferredReason }}</small></template></el-table-column>
          <el-table-column label="人工审核" width="120"><template #default="{ row }">{{ reviewStatus[row.id] }}</template></el-table-column>
          <el-table-column label="实测状态" prop="status" width="140" />
          <el-table-column label="结果" prop="result" min-width="260" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="页面检查" name="pages"><el-table :data="progress.pages" row-key="name"><el-table-column label="页面" prop="name" min-width="170" /><el-table-column label="联调分类" prop="category" width="130" /><el-table-column label="状态" prop="status" width="140" /><el-table-column label="结果" prop="result" min-width="400" /></el-table></el-tab-pane>
      <el-tab-pane :label="`回测结果（${progress.retests?.length || 0}）`" name="retests">
        <el-table :data="progress.retests || []" row-key="requestId" empty-text="后端部署并提交申请后，自动复验结果会显示在这里">
          <el-table-column label="问题" prop="issueId" width="170" /><el-table-column label="环境 / 版本" min-width="190"><template #default="{ row }">{{ row.environment }} / {{ row.version }}</template></el-table-column>
          <el-table-column label="回测结论" prop="status" min-width="180" /><el-table-column label="结果" prop="result" min-width="260" /><el-table-column label="证据" width="100"><template #default="{ row }"><a v-if="evidenceUrl(row.report)" :href="evidenceUrl(row.report)" target="_blank" rel="noreferrer">查看现场</a></template></el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.execution-evidence{padding:10px 18px 18px}.execution-evidence p{margin:8px 0;line-height:1.6}.execution-evidence small{color:var(--ui-secondary)}
.execution-evidence a{display:block;color:var(--ui-accent);margin:7px 0;text-decoration:underline}
.category-filter{width:160px;margin-bottom:12px}.task-detail{display:block;margin-top:4px}
</style>
