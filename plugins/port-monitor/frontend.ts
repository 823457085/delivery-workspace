import { defineAsyncComponent } from 'vue';

export default {
  components: {
    panel: defineAsyncComponent(() => import('../../src/features/port-monitor/PortMonitor.vue')),
  },
};
