import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import './style.css';
import Studio from './GoLearningStudio.vue';
createApp(Studio).use(ElementPlus).mount('#app');
