<script setup lang="ts">
/**
 * 设计说明：团队流程的岗位、模型与权限由岗位配置决定，输入框当前选择的模型和访问模式不参与。
 * 这里只收集模板、验收标准与允许修改范围，并如实展示每个岗位将使用的执行器与模型。
 */
import { computed, reactive, watch } from 'vue';
import type { AgentTeamTemplateId } from '../../../shared/agent-runtime';
import { agentModelLabel, agentTeamTemplates, teamTemplateLineup } from '../../../shared/agent-roles';

export interface AgentTeamRequest { templateId: AgentTeamTemplateId; acceptanceCriteria: string[]; allowedPaths: string[] }
const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ objective: string; changing?: boolean }>();
const emit = defineEmits<{ submit: [request: AgentTeamRequest] }>();
const form = reactive({ templateId: 'engineering' as AgentTeamTemplateId, criteria: '', paths: '' });
const lineup = computed(() => teamTemplateLineup(form.templateId));
const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const paths = computed(() => form.paths.split(/[\r\n,，]/).map(item => item.trim()).filter(Boolean));
watch(open, (value) => { if (value) { form.criteria = ''; form.paths = ''; } });

function submit() {
  if (!props.objective.trim() || props.changing) return;
  emit('submit', { templateId: form.templateId, acceptanceCriteria: lines(form.criteria), allowedPaths: paths.value });
}
</script>

<template>
  <el-dialog v-model="open" title="交给团队" width="min(560px, 92vw)" append-to-body>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="流程">
        <el-radio-group v-model="form.templateId">
          <el-radio-button v-for="template in agentTeamTemplates" :key="template.id" :value="template.id">{{ template.label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="目标（输入框中的内容）"><p class="team-objective">{{ objective }}</p></el-form-item>
      <el-form-item label="验收标准（每行一条，可以为空）">
        <el-input v-model="form.criteria" type="textarea" :rows="4" maxlength="12000" placeholder="例如：接口在空列表时返回 200 和空数组" />
      </el-form-item>
      <el-form-item label="允许修改的路径（逗号或换行分隔，可以为空）">
        <el-input v-model="form.paths" placeholder="例如：server/**, shared/agent-*.ts" />
        <small class="team-hint">运行结束后检查实际改动，超出范围不进入验证，不会自动回滚。</small>
      </el-form-item>
      <el-form-item label="岗位与模型">
        <ol class="team-lineup">
          <li v-for="item in lineup" :key="item.label"><span>{{ item.label }}</span><code>{{ agentModelLabel(item.choice) }}</code></li>
        </ol>
        <small class="team-hint">全部岗位使用 Agent 完全访问，按职责分工协作。验证在一次性副本中运行，审查使用独立会话核验证据，支持 Codex 审查 Codex 产物。Claude 未就绪或额度用尽时，Claude 岗位自动改用 Codex 继续（审查改用与实现者不同的 Codex 模型），流程卡片会标明。</small>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :loading="changing" :disabled="!objective.trim()" @click="submit">开始</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.team-objective{max-height:96px;margin:0;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6}
.team-hint{display:block;margin-top:4px;color:var(--agent-muted, #929caf);font-size:11px;line-height:1.5}
.team-lineup{display:grid;gap:4px;width:100%;margin:0;padding:0;list-style:none}.team-lineup li{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.team-lineup code{font-size:11px}
</style>
