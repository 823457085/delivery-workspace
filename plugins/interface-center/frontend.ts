import { defineAsyncComponent } from 'vue';

export default {
  components: {
    panel: defineAsyncComponent(() => import('../../src/features/interface-center/InterfaceCenter.vue')),
  },
};
