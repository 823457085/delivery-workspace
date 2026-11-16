import { defineAsyncComponent } from 'vue';

export default {
  components: {
    panel: defineAsyncComponent(() => import('../../src/features/refactor-control/RefactorControl.vue')),
  },
};
