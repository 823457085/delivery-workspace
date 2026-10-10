import { createApp } from 'vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import ElementPlus, { ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { router } from './app/router';
import { initializeTheme } from './shared/theme/useTheme';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './style.css';
import './app/hub.css';
import './app/themes.css';
const disposeTheme = initializeTheme();
if (import.meta.hot) import.meta.hot.dispose(disposeTheme);

// 旧版本或网络异常导致模块加载失败时提供恢复入口，不强制刷新丢失用户草稿。
let assetRecoveryPending = false;
window.addEventListener('vite:preloadError', event => {
  event.preventDefault();
  if (assetRecoveryPending) return;
  assetRecoveryPending = true;
  void ElMessageBox.confirm('页面模块加载失败，可能是版本已更新或连接中断。请先保存未发送内容，再重新加载页面。', '页面加载失败', {
    confirmButtonText: '重新加载', cancelButtonText: '暂不刷新', type: 'warning', closeOnClickModal: false,
  }).then(() => window.location.reload()).catch(() => {}).finally(() => { assetRecoveryPending = false; });
});

createApp(App).use(ElementPlus, { locale: zhCn }).use(router).use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 1 } } }) }).mount('#app');
