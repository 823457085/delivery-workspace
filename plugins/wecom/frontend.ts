import { defineAsyncComponent } from 'vue';

export default {
  components: {
    messages: defineAsyncComponent(() => import('../../src/features/wecom-messages/WecomMessages.vue')),
  },
};
