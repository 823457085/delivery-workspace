<script setup lang="ts">
/** 菜单分配独立于单行编辑：沿用看板模块/页面名展示整份待审核任务，选择实际 Jira 人员后由父级保存。 */
import { computed, shallowRef, watch } from 'vue';
import type { ApexBffAssignee, ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { ReviewCatalogItem } from './review-catalog';
import { pendingMenuItems, reviewAssignmentMenus } from './review-assignment';
import ReviewAssigneePicker from './ReviewAssigneePicker.vue';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ items: ReviewCatalogItem[]; records: ApexBffReviewState; saving: boolean; initialMenu: string }>();
const emit = defineEmits<{ assign: [ids: string[], assignee: ApexBffAssignee] }>();
const menus = shallowRef<string[]>([]);
const assignee = shallowRef<ApexBffAssignee>();
const options = computed(() => reviewAssignmentMenus(props.items, props.records));
const targets = computed(() => pendingMenuItems(props.items, props.records, menus.value));
watch(open, value => {
  if (!value) return;
  menus.value = props.initialMenu && options.value.some(group => group.children.some(menu => menu.value === props.initialMenu)) ? [props.initialMenu] : [];
  assignee.value = undefined;
});
function assign() { if (assignee.value && targets.value.length && !props.saving) emit('assign', targets.value.map(item => item.id), assignee.value); }
</script>

<template>
  <el-dialog v-model="open" title="按菜单分配联调任务" width="640px" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
    <el-form label-position="top" @submit.prevent="assign">
      <el-form-item label="待联调菜单">
        <el-cascader v-model="menus" :options="options" :props="{ multiple: true, emitPath: false }" filterable clearable
          :disabled="saving" placeholder="选择模块下的菜单，可多选" aria-label="选择分配菜单" class="assignment-input" />
      </el-form-item>
      <el-form-item label="负责人">
        <ReviewAssigneePicker v-model="assignee" :disabled="saving" class="assignment-input" label="菜单负责人" />
      </el-form-item>
      <p class="assignment-summary">共 {{ menus.length }} 个菜单、{{ targets.length }} 条待人工审核接口；已联调、已替代和不再使用的接口不参与分配。所选菜单已有负责人会被本次选择覆盖。</p>
      <p v-if="assignee" class="assignment-summary">负责人：{{ assignee.displayName }}（{{ assignee.name }}）</p>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!assignee || !targets.length" @click="assign">分配 {{ targets.length }} 条接口</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.assignment-input{width:100%}.assignment-summary{color:var(--ui-muted);font-size:12px;line-height:1.7}
</style>
