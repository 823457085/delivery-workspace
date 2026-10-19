import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { createWorkspaceBuild } from './server/workspace-version';

// 本地服务直接读取 dist；保留带 hash 的旧资源，让已打开的页面在更新后仍能加载异步模块。
export default defineConfig(async ({ command }) => {
  const build = await createWorkspaceBuild(fileURLToPath(new URL('.', import.meta.url)), command === 'serve');
  return {
    plugins: [vue(), { name: 'workspace-version', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'workspace-version.json', source: JSON.stringify(build) });
    } }],
    define: { __DELIVERY_BUILD__: JSON.stringify(build) },
    build: { target: 'es2022', emptyOutDir: false },
  };
});
