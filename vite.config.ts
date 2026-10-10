import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 本地服务直接读取 dist；保留带 hash 的旧资源，让已打开的页面在更新后仍能加载异步模块。
export default defineConfig({ plugins: [vue()], build: { target: 'es2022', emptyOutDir: false } });
