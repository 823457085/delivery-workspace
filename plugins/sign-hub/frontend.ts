import { defineAsyncComponent } from 'vue';

export default { components: { panel: defineAsyncComponent(() => import('../../src/features/sign-hub/SignHubPanel.vue')) } };
