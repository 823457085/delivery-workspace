<script setup lang="ts">
/** 独立入口只承接联调布局；复用原功能组件与数据接口，避免复制页面后分配和审核记录分叉。 */
import { onMounted } from 'vue';
import ApexBffReview from '../../features/api-integration/ApexBffReview.vue';

onMounted(() => { document.title = 'APEX 接口联调'; });
</script>

<template>
  <main class="hub integration-page">
    <h1 class="integration-title">APEX 接口联调</h1>
    <ApexBffReview />
  </main>
</template>

<style scoped>
.integration-page{padding:24px}
.integration-title{margin:0 0 12px;font-size:22px;line-height:1.4}
@media(max-width:550px){.integration-page{padding:16px}}
</style>
