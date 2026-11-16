<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

const props = defineProps<{ loading: boolean; error: Error | null; hasData: boolean }>();
defineEmits<{ retry: [] }>();
const router = useRouter();
const canOpenPluginSettings = computed(() => !!router && !!props.error
  && /(?:插件|模块).*(?:停用|禁用|未启用)|未配置.*(?:凭据|鉴权|Token|连接|Key)/i.test(props.error.message));
function openPluginSettings() {
  void router?.push({ path: '/agent', query: { view: 'settings', settingsTab: 'plugins' } });
}
</script>
<template>
  <el-alert v-if="error" class="section-alert" type="error" :title="error.message" :closable="false" show-icon>
    <div style="display:inline-flex;align-items:center;gap:12px;flex-wrap:wrap">
      <el-button link @click="$emit('retry')">重新读取</el-button>
      <el-button v-if="canOpenPluginSettings" link type="primary" @click="openPluginSettings">前往插件与凭据设置</el-button>
    </div>
  </el-alert>
  <div v-if="loading && !hasData" class="surface loading-panel">
    <el-skeleton :rows="7" animated />
    <p>正在读取工作区数据，不会触发执行任务…</p>
  </div>
  <slot v-if="hasData" />
  <slot v-else-if="!loading && !error" name="empty" />
</template>
