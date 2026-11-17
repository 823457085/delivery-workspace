<script setup lang="ts">
import { computed, ref } from 'vue';
import { Download, Paperclip } from '@lucide/vue';
import type { JiraIssueDetail } from '../../../shared/jira-issue';
import { jiraAttachmentMediaType } from '../../../shared/jira-attachment-media';
const props = defineProps<{ issueKey: string; files: JiraIssueDetail['attachments'] }>();
const failed = ref<Record<string, boolean>>({});
const url = (id: string, inline = false) => `/api/jira/issues/${encodeURIComponent(props.issueKey)}/attachments/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}`;
const images = computed(() => props.files.filter(f => jiraAttachmentMediaType(f)?.startsWith('image/')).map(f => url(f.id, true)));
</script>
<template>
  <div class="jira-attachments">
    <article v-for="file in files" :key="`${issueKey}:${file.id}`" class="jira-attachment">
      <el-image v-if="jiraAttachmentMediaType(file)?.startsWith('image/')" class="attachment-image" :src="url(file.id, true)" :alt="file.filename" fit="contain" loading="lazy" :preview-src-list="images" :initial-index="images.indexOf(url(file.id, true))" preview-teleported hide-on-click-modal>
        <template #placeholder><span class="media-message">图片加载中…</span></template>
        <template #error><span class="media-message" role="status">图片加载失败，可下载查看</span></template>
      </el-image>
      <template v-else-if="jiraAttachmentMediaType(file)?.startsWith('video/')">
        <video v-if="!failed[file.id]" class="attachment-video" :src="url(file.id, true)" :aria-label="file.filename" controls preload="metadata" playsinline @error="failed[file.id] = true" />
        <div v-else class="media-message" role="status">视频加载失败或浏览器不支持此编码，请下载查看。<button type="button" @click="failed[file.id] = false">重试</button></div>
      </template>
      <footer><Paperclip :size="15"/><div class="attachment-info"><strong :title="file.filename">{{ file.filename }}</strong><small>{{ Math.ceil(file.size / 1024) }} KB · {{ file.author }}</small></div><a :href="url(file.id)" download :aria-label="`下载 ${file.filename}`" title="下载附件"><Download :size="15"/></a></footer>
    </article>
  </div>
</template>
<style scoped>
.jira-attachments{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:10px}.jira-attachment{min-width:0;overflow:hidden;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface)}.attachment-image,.attachment-video{display:block;width:100%;height:180px;object-fit:contain;background:var(--ui-raised)}.attachment-image{cursor:zoom-in}.attachment-video{background:#101318}.media-message{min-height:100px;padding:16px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;color:var(--ui-muted);font-size:12px;text-align:center}.media-message button{border:1px solid var(--ui-border);border-radius:4px;background:var(--ui-surface);color:var(--ui-accent);padding:4px 8px;cursor:pointer}.jira-attachment footer{display:flex;align-items:center;gap:8px;padding:10px;color:var(--ui-muted)}.attachment-info{flex:1;min-width:0}.attachment-info strong{display:block;overflow-wrap:anywhere;color:var(--ui-text);font-size:12px;font-weight:500}.attachment-info small{display:block;margin-top:4px;font-size:11px}.jira-attachment footer>a{flex:none;display:grid;place-items:center;padding:6px;border-radius:4px;color:var(--ui-accent)}.jira-attachment footer>a:hover{background:var(--ui-raised)}
</style>
