<script setup lang="ts">
/**
 * 设计说明：当前会话任务与项目重构任务分组展示，均保留来源状态。
 * 项目任务只是入口，不代表当前会话执行或交付；筛选与编辑仍进入原任务页。
 */
import { ChevronRight, ExternalLink, FolderGit2, GitBranch, Network } from '@lucide/vue';
import { computed, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import type { JiraIssue } from '../../../shared/hub';
import type { AgentBusinessContext } from './agent-business-context';
import { interfaceQuickPrompt, jiraQuickPrompt, projectQuickPrompt } from './agent-quick-actions';
import { isDone } from '../../shared/format';

const props = defineProps<{ context: AgentBusinessContext; loading: boolean }>();
const emit = defineEmits<{ compose: [prompt: string] }>();
const router = useRouter();
const expandedGroups = shallowRef<ReadonlySet<string>>(new Set(['refactor']));
const expandedIssues = shallowRef<Record<string, boolean>>({});
const jiraIssues = computed(() => props.context.jiraIssues);
const taskGroups = computed(() => [
  { id: 'conversation', title: '当前会话任务', issues: jiraIssues.value },
  { id: 'refactor', title: '项目重构任务', issues: props.context.refactorIssues || [] },
].filter(group => group.issues.length).map(group => ({ ...group,
  count: group.issues.reduce((count, issue) => count + issue.subtasks.length + 1, 0),
})));

function openProject() {
  if (!props.context.project) return;
  void router.push({ path: '/projects', query: { q: props.context.project.path } });
}

function issueExpanded(issue: JiraIssue, group: string) {
  return expandedIssues.value[`${group}:${issue.key}`] ?? (group !== 'refactor' || !isDone(issue));
}

function toggleIssue(issue: JiraIssue, group: string) {
  expandedIssues.value = { ...expandedIssues.value, [`${group}:${issue.key}`]: !issueExpanded(issue, group) };
}

function toggleGroup(id: string) {
  const next = new Set(expandedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedGroups.value = next;
}

function subtaskUrl(issue: JiraIssue, subtaskKey: string) {
  return issue.url.replace(issue.key, subtaskKey);
}
</script>

<template>
  <section class="context-panel" aria-label="Agent 任务上下文">
    <el-skeleton v-if="loading && !taskGroups.length && !context.project && !context.interfacePage" :rows="5" animated />
    <template v-else>
      <section v-for="group in taskGroups" :key="group.id" class="jira-candidates">
        <button type="button" class="candidate-heading" :aria-expanded="expandedGroups.has(group.id)" @click="toggleGroup(group.id)">
          <span><ChevronRight :size="13" :class="{ expanded: expandedGroups.has(group.id) }" />{{ group.title }}</span>
          <small>{{ group.count }} 项</small>
        </button>
        <div v-if="expandedGroups.has(group.id)" class="candidate-list">
          <article v-for="issue in group.issues" :key="issue.key" class="candidate-item">
            <div class="candidate-main">
              <button v-if="issue.subtasks.length" type="button" class="candidate-toggle" :aria-label="`${issueExpanded(issue, group.id) ? '收起' : '展开'} ${issue.key} 子任务`" :aria-expanded="issueExpanded(issue, group.id)" @click="toggleIssue(issue, group.id)">
                <ChevronRight :size="13" :class="{ expanded: issueExpanded(issue, group.id) }" />
              </button>
              <span v-else class="candidate-toggle-spacer" />
              <div class="candidate-copy">
                <a :href="issue.url" target="_blank" rel="noreferrer">{{ issue.key }} <ExternalLink :size="11" /></a>
                <router-link :to="{ path: '/tasks/list', query: { q: issue.key } }">查看任务</router-link>
                <strong>{{ issue.summary }}</strong>
                <span>{{ issue.status }} · {{ issue.priority }} · {{ issue.fixVersions.join('、') || '未指定版本' }}</span>
              </div>
              <button type="button" @click="emit('compose', jiraQuickPrompt(issue))">带入会话</button>
            </div>
            <ul v-if="issue.subtasks.length && issueExpanded(issue, group.id)" class="candidate-subtasks">
              <li v-for="subtask in issue.subtasks" :key="subtask.key">
                <a :href="subtaskUrl(issue, subtask.key)" target="_blank" rel="noreferrer">{{ subtask.key }}</a>
                <strong>{{ subtask.summary || '—' }}</strong>
                <small>{{ subtask.status }}</small>
              </li>
            </ul>
          </article>
        </div>
      </section>

      <article v-if="context.project" class="context-card project-card">
        <header><span><FolderGit2 :size="13" /> 本地项目</span></header>
        <strong>{{ context.project.displayName || context.project.projectName }}</strong>
        <p :title="context.project.path">{{ context.project.displayPath || context.project.path }}</p>
        <dl>
          <div><dt><GitBranch :size="12" /> 分支</dt><dd>{{ context.project.branch || '未识别' }}</dd></div>
          <div><dt>工作树</dt><dd>{{ context.project.clean ? '干净' : `${context.project.changed} 处变更` }}</dd></div>
          <div><dt>远程差异</dt><dd>领先 {{ context.project.ahead }} · 落后 {{ context.project.behind }}</dd></div>
        </dl>
        <nav><button type="button" @click="emit('compose', projectQuickPrompt(context.project))">检查项目</button><button type="button" @click="openProject">在项目页查看</button></nav>
      </article>

      <article v-if="context.interfacePage" class="context-card interface-card">
        <header><span><Network :size="13" /> 接口联调</span></header>
        <strong>{{ context.interfacePage.page.title }}</strong>
        <p>{{ context.interfacePage.page.menu }} · {{ context.interfacePage.page.operations.length }} 个接口</p>
        <dl v-if="context.interfacePage.progress">
          <div><dt>已联调（人工确认）</dt><dd>{{ context.interfacePage.progress.confirmed }} / {{ context.interfacePage.progress.total }}</dd></div>
          <div><dt>阻塞</dt><dd>{{ context.interfacePage.progress.blocked }}</dd></div>
        </dl>
        <nav><button type="button" @click="emit('compose', interfaceQuickPrompt(context.interfacePage))">检查联调</button><router-link to="/refactor/api-integration">在联调页查看</router-link></nav>
      </article>

      <div v-if="!context.project && !context.interfacePage && !taskGroups.length" class="context-empty">
        <Network :size="28" />
        <strong>尚未关联业务上下文</strong>
        <p>在输入框中输入 @，可选择 Jira、项目或接口页面。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.context-panel{height:100%;min-height:0;padding:16px;overflow-y:auto;background:var(--agent-panel)}.context-card{margin-bottom:10px;padding:13px;border:1px solid var(--agent-border);border-radius:11px;background:color-mix(in srgb,var(--agent-panel-strong) 82%,transparent)}.context-card header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px;color:var(--agent-muted);font-size:13px}.context-card header span{display:flex;align-items:center;gap:5px}.context-card header a{color:var(--agent-accent)}.context-card>strong{display:block;color:var(--agent-text);font-size:14px;line-height:1.55}.context-card>p{margin:7px 0 0;overflow:hidden;color:var(--agent-muted);font-size:13px;line-height:1.55;text-overflow:ellipsis;white-space:nowrap}.context-card dl{display:grid;gap:7px;margin:12px 0}.context-card dl div{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}.context-card dt,.context-card dd{margin:0;font-size:13px;line-height:1.45}.context-card dt{display:flex;align-items:center;gap:4px;color:var(--agent-muted)}.context-card dd{max-width:62%;color:var(--agent-secondary);text-align:right;word-break:break-word}.context-card>a{display:inline-flex;padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:13px;text-decoration:none;cursor:pointer}.context-card>a:hover{color:#fff}.context-empty{display:grid;place-items:center;align-content:center;height:100%;padding:24px;color:var(--agent-muted);text-align:center}.context-empty strong{margin-top:12px;color:var(--agent-secondary);font-size:14px}.context-empty p{margin:7px 0 0;font-size:13px;line-height:1.6}.context-panel:deep(.el-skeleton__item){background:var(--agent-panel-strong)}
.context-card nav{display:flex;align-items:center;gap:12px}.context-card nav a,.context-card nav button{display:inline-flex;padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:13px;text-decoration:none;cursor:pointer}.context-card nav a:hover,.context-card nav button:hover{color:#fff}
.jira-candidates{margin-bottom:10px}.candidate-heading{display:flex;align-items:center;justify-content:space-between;width:100%;padding:4px 2px 9px;border:0;background:transparent;color:var(--agent-secondary);font-size:13px;cursor:pointer}.candidate-heading>span{display:flex;align-items:center;gap:4px}.candidate-heading svg,.candidate-toggle svg{transition:transform .16s ease}.candidate-heading svg.expanded,.candidate-toggle svg.expanded{transform:rotate(90deg)}.candidate-heading small{color:var(--agent-muted);font:12px var(--mono)}.candidate-item{margin-bottom:7px;padding:10px;border:1px solid var(--agent-border);border-radius:9px;background:color-mix(in srgb,var(--agent-panel-strong) 82%,transparent)}.candidate-main{display:flex;align-items:center;justify-content:space-between;gap:7px}.candidate-toggle{display:grid;flex:0 0 18px;place-items:center;width:18px;height:18px;padding:0;border:0;background:transparent;color:var(--agent-muted);cursor:pointer}.candidate-toggle:hover{color:var(--agent-text)}.candidate-toggle-spacer{flex:0 0 18px}.candidate-copy{min-width:0;flex:1}.candidate-copy a{display:inline-flex;align-items:center;gap:3px;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font:13px var(--mono);text-decoration:none}.candidate-copy strong,.candidate-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.candidate-copy strong{margin-top:5px;color:var(--agent-text);font-size:13px}.candidate-copy span{margin-top:4px;color:var(--agent-muted);font-size:12px}.candidate-main>button:last-child{flex-shrink:0;padding:5px 7px;border:1px solid color-mix(in srgb,var(--agent-accent) 36%,var(--agent-border));border-radius:7px;background:color-mix(in srgb,var(--agent-accent) 10%,transparent);color:color-mix(in srgb,var(--agent-accent) 48%,#fff);font-size:12px;cursor:pointer}.candidate-main>button:last-child:hover{background:color-mix(in srgb,var(--agent-accent) 18%,transparent)}.candidate-subtasks{display:grid;gap:6px;margin:9px 0 0 25px;padding:9px 0 0;border-top:1px solid var(--agent-border);list-style:none}.candidate-subtasks li{display:grid;grid-template-columns:82px minmax(0,1fr) auto;align-items:center;gap:6px;min-width:0}.candidate-subtasks a{overflow:hidden;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font:12px var(--mono);text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.candidate-subtasks a:hover{color:#fff}.candidate-subtasks strong{overflow:hidden;color:var(--agent-secondary);font-size:13px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.candidate-subtasks small{color:var(--agent-muted);font-size:12px;white-space:nowrap}
.candidate-copy strong,.candidate-subtasks strong{white-space:normal;overflow-wrap:anywhere;line-height:1.6}.candidate-main{align-items:flex-start}.context-card nav{flex-wrap:wrap}.context-card dt{flex-shrink:0}
.candidate-copy a+a{margin-left:8px}
</style>
