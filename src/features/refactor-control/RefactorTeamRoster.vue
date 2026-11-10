<script setup lang="ts">
import { ArrowUpRight, UsersRound } from '@lucide/vue';
import { useRouter } from 'vue-router';
import type { GroupConfig } from '../../../shared/agent-group-chat';
import { agentProviderLabels, type AgentRuntimeHealth } from '../../../shared/agent-runtime';
import AgentAvatar from '../agent-workbench/AgentAvatar.vue';

const props = defineProps<{ config: GroupConfig; runtimes: AgentRuntimeHealth[]; compact?: boolean }>();
const router = useRouter();
const ready = (provider: string) => props.runtimes.find(runtime => runtime.provider === provider)?.ready;
const modelLabel = (provider: string, model: string) => props.runtimes.find(runtime => runtime.provider === provider)?.models.find(item => item.id === model)?.label || model;
</script>

<template>
  <section class="refactor-team-roster" :class="{ compact }" :aria-label="config.name">
    <header><div class="roster-heading"><UsersRound :size="18" /><h2>{{ config.name }}</h2><span>配置 v{{ config.revision }} · {{ config.members.filter(member => member.enabled).length }} 名成员</span></div><button v-if="!compact" type="button" @click="router.push('/agent?group=1')">团队设置<ArrowUpRight :size="14" /></button></header>
    <div class="roster-members"><article v-for="member in config.members" :key="member.id" :data-member="member.id">
      <AgentAvatar v-if="member.binding" :provider="member.binding.provider" :model="member.binding.model" :size="compact ? 28 : 32" />
      <UsersRound v-else :size="compact ? 28 : 32" />
      <div><strong>{{ member.name }}</strong><span :class="{ unready: !member.enabled || !member.binding || !ready(member.binding.provider) }"><i></i>{{ !member.enabled ? '已停用' : member.binding ? `${agentProviderLabels[member.binding.provider]} · ${ready(member.binding.provider) ? '就绪' : '未就绪'}` : '未配置模型' }}</span></div>
      <code v-if="member.binding">{{ member.binding.catalogAlias?.label || modelLabel(member.binding.provider, member.binding.model) }}<small v-if="member.binding.reasoningEffort"> · {{ member.binding.reasoningEffort }}</small><small v-if="member.fallbackBinding" class="member-fallback">备用 {{ member.fallbackBinding.catalogAlias?.label || modelLabel(member.fallbackBinding.provider, member.fallbackBinding.model) }}</small></code>
    </article></div>
    <footer v-if="!compact"><span>沿用团队群聊已保存的成员、职责、模型与备用；负责人按任务安排协作。</span><button type="button" @click="router.push('/agent?group=1')">进入团队群聊<ArrowUpRight :size="14" /></button></footer>
  </section>
</template>

<style scoped>
.refactor-team-roster{min-width:0;padding:16px 22px;border:1px solid var(--ui-border);border-radius:12px;background:var(--ui-surface);font-family:var(--sans);color:var(--ui-text)}
.refactor-team-roster>header,.roster-heading{display:flex;align-items:center;gap:10px}.refactor-team-roster>header{justify-content:space-between;margin-bottom:14px}.roster-heading>svg{color:var(--ui-accent)}.roster-heading h2{margin:0;font:600 16px var(--sans)}.roster-heading>span{padding:3px 7px;border-radius:5px;background:var(--ui-raised);color:var(--ui-secondary);font-size:11px}
.refactor-team-roster button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:0 3px;border:0;background:transparent;color:var(--ui-secondary);font:12px var(--sans);cursor:pointer}.refactor-team-roster button:hover{color:var(--ui-accent)}.refactor-team-roster button:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px;border-radius:3px}
.roster-members{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.roster-members article{display:grid;grid-template-columns:32px minmax(0,1fr);align-content:start;align-items:center;gap:7px 10px;min-width:0;padding-right:14px;border-right:1px solid var(--ui-divider,var(--ui-border))}.roster-members article:last-child{border:0;padding-right:0}.roster-members article>div{min-width:0}.roster-members strong{display:block;font-size:13px;font-weight:600;line-height:1.5}.roster-members article>div>span{display:flex;align-items:center;gap:4px;margin-top:2px;white-space:nowrap;color:var(--ui-secondary);font-size:11px}.roster-members i{width:4px;height:4px;flex-shrink:0;border-radius:50%;background:var(--ui-success)}.roster-members .unready i{background:var(--ui-warning)}.roster-members code{grid-column:1/-1;overflow-wrap:anywhere;font:12px/1.6 var(--mono);color:var(--ui-secondary)}.roster-members small{grid-column:1/-1;font-size:11px;color:var(--ui-muted)}
.refactor-team-roster>footer{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:12px;padding-top:8px;border-top:1px solid var(--ui-divider,var(--ui-border));font-size:12px;line-height:1.7;color:var(--ui-secondary)}.refactor-team-roster>footer>button{white-space:nowrap;flex-shrink:0}
.member-fallback{display:block}.roster-members code small{font:10px var(--sans);color:var(--ui-secondary);white-space:nowrap}
.compact{padding:16px}.compact>header{margin-bottom:12px}.compact .roster-members{grid-template-columns:1fr;gap:0}.compact .roster-members article{grid-template-columns:28px 100px minmax(0,1fr);gap:10px;padding:8px 0;border-right:0;border-bottom:1px solid var(--ui-divider,var(--ui-border))}.compact .roster-members article:last-child{border-bottom:0}.compact .roster-members code,.compact .roster-members small{grid-column:auto}
@media(max-width:1050px){.roster-members{gap:14px}.roster-members article{grid-template-columns:1fr;padding-right:10px;gap:7px}.roster-members .agent-avatar{display:none}.roster-members code{font-size:11px}.compact .roster-members .agent-avatar{display:block}}
@media(max-width:600px){.refactor-team-roster{padding:16px}.roster-members{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.roster-members article{grid-template-columns:28px minmax(0,1fr);padding:0;border:0;gap:8px}.roster-members .agent-avatar{display:block;width:28px!important;height:28px!important}.roster-members article:first-child{grid-column:1/-1;grid-template-columns:28px minmax(0,1fr) auto}.roster-members article:first-child code{grid-column:3;grid-row:1;max-width:150px}.roster-members article:first-child small{grid-column:2}.roster-members article>div>span{font-size:10px}.refactor-team-roster>footer{align-items:flex-start}.refactor-team-roster>footer>span{max-width:220px}.refactor-team-roster button{min-height:44px}.compact .roster-members article{grid-template-columns:28px minmax(0,1fr)}.compact .roster-members code{grid-column:2}.compact .roster-members small{grid-column:2}.compact .roster-members article:first-child code{grid-column:2;grid-row:auto;max-width:none}.compact .roster-members article:first-child{grid-column:auto}}
</style>

<style scoped>
.compact .roster-members{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px}.compact .roster-members article{grid-template-columns:28px minmax(0,1fr);padding:5px 0;border:0}.compact .roster-members code{grid-column:1/-1;font-size:11px}
@media(max-width:600px){.compact .roster-members{grid-template-columns:repeat(2,minmax(0,1fr))}.compact .roster-members article:first-child{grid-column:1/-1}.compact .roster-members article:first-child code{grid-column:2}.compact .roster-members code{grid-column:1/-1}}
</style>
