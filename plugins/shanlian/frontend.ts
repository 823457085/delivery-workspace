import { defineAsyncComponent } from 'vue';

export default { components: { panel: defineAsyncComponent(() => import('../../src/features/shanlian/ShanlianPanel.vue')) } };
