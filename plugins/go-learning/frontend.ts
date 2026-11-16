import { defineAsyncComponent } from 'vue';

export default { components: { panel: defineAsyncComponent(() => import('../../src/features/go-learning/GoLearningStudio.vue')) } };
