<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
/**
 * 设计说明：首屏查询期间只保留工作台主题背景和单一加载状态，避免骨架条在刷新时造成内容闪烁。
 * 该组件不持有数据状态；显示与移除仍完全由上层查询的 isPending 控制。
 */

</script>

<template>
  <div class="agent-initial-loading" role="status" aria-live="polite" aria-label="正在加载 Agent 工作台">
    <div class="loading-mark" aria-hidden="true">
      <span><AgentAvatar :size="40" /></span>
      <i></i>
    </div>
    <strong>正在加载工作台</strong>
    <div class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></div>
  </div>
</template>

<style scoped>
.agent-initial-loading{display:grid;place-items:center;align-content:center;width:100%;height:100%;gap:14px;background-color:var(--agent-bg);background-image:linear-gradient(var(--agent-wallpaper-empty-shade),var(--agent-wallpaper-empty-shade)),radial-gradient(circle at 50% 38%,color-mix(in srgb,var(--agent-accent) 18%,transparent) 0,transparent 34%),var(--agent-wallpaper);background-position:center,center,var(--agent-wallpaper-position);background-size:auto,auto,cover;background-repeat:no-repeat;color:var(--agent-muted)}.loading-mark{position:relative;display:grid;place-items:center;width:64px;height:64px}.loading-mark>span{position:relative;z-index:1;display:grid;place-items:center;width:42px;height:42px;border:1px solid color-mix(in srgb,var(--agent-accent) 48%,var(--agent-border));border-radius:13px;background:color-mix(in srgb,var(--agent-panel-strong) 88%,transparent);color:color-mix(in srgb,var(--agent-accent) 55%,#fff);box-shadow:0 12px 34px #0004;backdrop-filter:blur(12px)}.loading-mark>i{position:absolute;inset:0;border:1px solid color-mix(in srgb,var(--agent-accent) 50%,transparent);border-top-color:var(--agent-accent);border-radius:50%;animation:agent-loading-spin 1.2s linear infinite}.agent-initial-loading>strong{color:var(--agent-secondary);font-size:11px;font-weight:550;letter-spacing:.08em}.loading-dots{display:flex;gap:5px}.loading-dots i{width:4px;height:4px;border-radius:50%;background:var(--agent-accent);animation:agent-loading-pulse 1.1s ease-in-out infinite}.loading-dots i:nth-child(2){animation-delay:.14s}.loading-dots i:nth-child(3){animation-delay:.28s}@keyframes agent-loading-spin{to{transform:rotate(360deg)}}@keyframes agent-loading-pulse{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}@media(prefers-reduced-motion:reduce){.loading-mark>i,.loading-dots i{animation:none}.loading-dots i{opacity:.7}}
</style>
