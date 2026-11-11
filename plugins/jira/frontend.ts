import { defineAsyncComponent } from 'vue';
export default { components: {
 development: defineAsyncComponent(() => import('../../src/features/jira-dev/JiraDevTask.vue')),
 sync: defineAsyncComponent(() => import('../../src/features/requirement-development/JiraDevSyncButton.vue')),
 import: defineAsyncComponent(() => import('../../src/features/requirement-development/JiraRequirementImport.vue')),
 workbench: defineAsyncComponent(() => import('./WorkbenchCards.vue')),
 tasks: defineAsyncComponent(() => import('../../src/features/task-calendar/TaskWorkspace.vue')),
 fix: defineAsyncComponent(() => import('../../src/features/jira-fix/JiraFix.vue')),
} };
