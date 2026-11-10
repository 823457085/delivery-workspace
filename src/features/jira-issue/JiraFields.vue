<script setup lang="ts">
import type {JiraField,JiraPerson} from '../../../shared/jira-issue';
import JiraDescriptionEditor from './JiraDescriptionEditor.vue';
defineProps<{fields:JiraField[];users?:JiraPerson[];searching?:boolean}>();
const values=defineModel<Record<string,any>>({required:true});
const descriptionExpanded=defineModel<boolean>('descriptionExpanded',{default:false});
const emit=defineEmits<{searchUsers:[query:string]}>();
</script>
<template>
 <el-form-item v-for="field in fields" :key="field.id" class="jira-operation-field" :class="{'jira-field-wide':['summary','description'].includes(field.id)}" :data-field-id="field.id" :label="field.name" :required="field.required">
  <el-select v-if="field.allowedValues?.length" v-model="values[field.id]" :multiple="field.schema?.type==='array'" clearable filterable popper-class="jira-operation-popper" style="width:100%">
   <el-option v-for="option in field.allowedValues" :key="option.id" :value="String(option.id)" :label="option.name || option.value || option.displayName || String(option.id)"/>
  </el-select>
  <el-select v-else-if="field.schema?.type==='user'" v-model="values[field.id]" remote filterable clearable :remote-method="(query:string)=>emit('searchUsers',query)" :loading="searching" popper-class="jira-operation-popper" style="width:100%"><el-option v-for="user in users" :key="user.id" :value="`${user.kind}:${user.id}`" :label="user.label"/></el-select>
  <el-date-picker v-else-if="field.schema?.type==='date'" v-model="values[field.id]" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" :aria-label="field.name" popper-class="jira-operation-popper" style="width:100%"/>
  <el-input-number v-else-if="field.schema?.type==='number'" v-model="values[field.id]"/>
  <el-switch v-else-if="field.schema?.type==='boolean'" v-model="values[field.id]"/>
  <el-select v-else-if="field.schema?.type==='array' && field.schema?.items==='string'" v-model="values[field.id]" multiple filterable allow-create default-first-option popper-class="jira-operation-popper" style="width:100%"/>
  <JiraDescriptionEditor v-else-if="field.id==='description' && (!field.schema?.type || field.schema.type==='string')" v-model="values[field.id]" v-model:expanded="descriptionExpanded"/>
  <el-input v-else-if="!field.schema?.type || field.schema.type==='string'" v-model="values[field.id]" :maxlength="1000"/>
  <span v-else class="unsupported-field">此字段请在 Jira 中填写</span>
 </el-form-item>
</template>
<style scoped>.jira-date{width:100%;height:34px;padding:0 10px;border:1px solid var(--ui-border);border-radius:5px;color:var(--ui-text);background:var(--ui-surface);font:inherit}.unsupported-field{font-size:12px;color:var(--ui-muted)}</style>
