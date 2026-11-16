import { defineAsyncComponent } from 'vue';

export default {
  components: {
    panel: defineAsyncComponent(() => import('../../src/features/deployments/DeploymentWorkspace.vue')),
  },
};
