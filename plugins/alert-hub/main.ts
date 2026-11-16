import { createApp } from 'vue';
import App from './App.vue';
import { host } from '../../shared/plugin-application-sdk';
import './theme.css';
host.theme.subscribe(({ mode }) => {
  document.body.style.colorScheme = mode;
});

createApp(App).mount('#app');
