<script setup lang="ts">
import type { JiraFixInput, JiraFixContext } from '../../../shared/jira-fix';
const model = defineModel<JiraFixInput>({ required: true });
defineProps<{ context?: JiraFixContext; resolving: boolean; busy: boolean; valid: boolean; selecting: boolean; selectedRepository: string }>();
const emit = defineEmits<{ resolve: []; start: []; chooseDirectory: []; selectProject: [repository: string] }>();
</script>

<template>
  <el-form label-position="top" class="fix-form" :disabled="busy" @submit.prevent="emit('start')">
    <el-form-item label="Jira Key / 链接" required>
      <el-input v-model="model.issueKey" aria-label="Jira Key / 链接" placeholder="例如 TEST-123 或 https://jira.example.com/browse/TEST-123" maxlength="2000">
        <template #append><el-button :loading="resolving" @click="emit('resolve')">读取 Jira 并匹配项目</el-button></template>
      </el-input>
    </el-form-item>
    <div v-if="context" class="issue-summary"><strong>{{ context.issue.key }} · {{ context.issue.summary }}</strong><span>{{ context.issue.projectName }} · {{ context.issue.status }}</span></div>
    <el-form-item label="项目">
      <el-select :model-value="selectedRepository" class="project-select" clearable filterable aria-label="项目" placeholder="选择本地项目，或在下方手动配置仓库" :disabled="!context || resolving" @change="emit('selectProject', $event)">
        <el-option v-for="project in context?.projects || []" :key="project.repository" :label="`${project.name} · ${project.repository}`" :value="project.repository" />
      </el-select>
      <p v-if="context" class="match-hint">{{ context.candidates.length === 1 ? '找到一个匹配项目，可选用或手动调整配置。' : context.candidates.length > 1 ? '存在多个匹配项目，请选择本次修复的仓库。' : '未找到明确匹配，请选择项目或手动填写仓库与目录。' }}</p>
    </el-form-item>
    <div class="form-grid">
      <el-form-item label="Git 仓库地址" required><el-input v-model="model.repository" aria-label="Git 仓库地址" placeholder="git@host:group/repo.git 或 https://host/group/repo.git" @input="emit('selectProject', '')" /></el-form-item>
      <el-form-item label="本地保存目录" required><el-input v-model="model.parentDirectory" aria-label="本地保存目录" placeholder="在所选父目录下新建独立文件夹"><template #append><el-button :loading="selecting" @click="emit('chooseDirectory')">选择目录</el-button></template></el-input></el-form-item>
      <el-form-item label="远端基准分支" required><el-input v-model="model.baseBranch" aria-label="远端基准分支" placeholder="master / main / 其他远端分支" /></el-form-item>
      <el-form-item label="修复分支" required><el-input v-model="model.branch" aria-label="修复分支" placeholder="feature/TEST-123" /></el-form-item>
    </div>
    <el-form-item label="补充说明"><el-input v-model="model.notes" type="textarea" :rows="3" aria-label="补充说明" placeholder="复现环境、修复范围或验证要求" maxlength="20000" /></el-form-item>
    <el-checkbox v-model="model.rememberProject">记住该 Jira 项目与仓库、基准分支及保存目录的配置</el-checkbox>
    <footer class="fix-actions"><p>新建独立目录后启动修复会话，读取 Jira、修改代码并验证。提交、推送和 Jira 写入需另行明确要求。</p><el-button native-type="submit" type="primary" :loading="busy" :disabled="!valid || resolving">创建独立目录并开始修复</el-button></footer>
  </el-form>
</template>

<style scoped>
.fix-form{padding:20px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-surface)}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}.project-select{width:100%}
.issue-summary{display:flex;flex-direction:column;gap:6px;margin:0 0 18px;overflow-wrap:anywhere}.issue-summary span,.match-hint{font-size:12px;color:var(--ui-secondary)}.match-hint{margin:5px 0 0}
.fix-actions{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:20px}.fix-actions p{font-size:12px;color:var(--ui-secondary);line-height:1.8;margin:0}
@media(max-width:800px){.form-grid{grid-template-columns:1fr}.fix-actions{align-items:flex-start;flex-direction:column}}
</style>
