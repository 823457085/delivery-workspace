import { defineAsyncComponent } from 'vue';

export default {
  components: {
    panel: defineAsyncComponent(() => import('../../src/features/system-catalog/SystemCatalog.vue')),
  },
};
