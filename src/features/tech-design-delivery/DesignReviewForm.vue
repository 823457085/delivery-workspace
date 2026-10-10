<script setup lang="ts">
/** 核验表保存人的证据声明，不签署 G2a，也不更新原系统任务状态。 */
import { reactive, shallowRef, watch } from 'vue';
import { emptyReview, type DesignCard, type DesignReview } from './domain';
const props = defineProps<{ card: DesignCard }>();
const emit = defineEmits<{ save: [review: DesignReview, blockedReason: string] }>();
const form = reactive(emptyReview());
const blockedReason = shallowRef('');
watch([() => props.card.key, () => props.card.local?.review], () => {
  Object.assign(form, props.card.local?.review || emptyReview());
  blockedReason.value = props.card.local?.blockedReason || '';
}, { immediate: true });
</script>
<template>
  <div class="review-form">
    <p class="review-notice">请在实际阅读后记录证据。可以分次保存；六项资料与核验完整后才进入“人工核验已登记”。该记录仅在本浏览器保存，不是服务端验证或审批签署。</p>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="资料核对证据"><el-input v-model="form.sources" type="textarea" :rows="2" placeholder="已读 PRD / 原型版本、代码路径与分支、待决问题、缺失资料边界" maxlength="8000" /></el-form-item>
      <el-form-item label="技术方案核验"><el-input v-model="form.design" type="textarea" :rows="2" placeholder="S2a 模板与 US/AC/EX/NFR 覆盖、API 证据、测试/风险/回滚、未签署 G2a；填写文档位置" maxlength="8000" /></el-form-item>
      <el-form-item label="已核对的 Confluence 文档链接"><el-input v-model="form.publication" placeholder="实际打开并核验目录、标题、版本后的 https://…" maxlength="2000" /></el-form-item>
      <el-form-item label="Jira 层级核验"><el-input v-model="form.hierarchy" type="textarea" :rows="3" placeholder="DEV 父任务 Key、方案/实现子任务 Key；负责人、Fix Version、原需求关联、去重及方案链接核对结果" maxlength="8000" /></el-form-item>
      <el-form-item label="最终回读记录"><el-input v-model="form.readback" type="textarea" :rows="2" placeholder="逐项回读的文档与 Jira 链接、关键字段和核验结果；未确认事项不能写通过" maxlength="8000" /></el-form-item>
      <el-form-item label="核验人"><el-input v-model="form.reviewer" placeholder="实际核验者姓名" maxlength="120" /></el-form-item>
      <el-form-item label="本机阻塞说明"><el-input v-model="blockedReason" type="textarea" :rows="2" placeholder="有阻塞请填写原因；清空仅移除本机标记，不会恢复或重试远端任务" maxlength="4000" /></el-form-item>
      <el-button type="primary" @click="emit('save', { ...form }, blockedReason)">保存人工核验记录</el-button>
    </el-form>
  </div>
</template>
<style scoped>
.review-notice{font-size:12px;line-height:1.9;color:var(--ui-secondary);padding:14px;background:var(--ui-warning-bg);border-left:3px solid var(--ui-warning);border-radius:5px;margin:0 0 18px}.review-form{padding-top:8px}
</style>
