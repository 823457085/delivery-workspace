import { defineConfig, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createWorkspaceBuild } from './server/workspace-version.ts';
import { parseDeploymentLinks } from './src/features/deployments/native-deployments.ts';

// 本地服务直接读取 dist；保留带 hash 的旧资源，让已打开的页面在更新后仍能加载异步模块。
export default defineConfig(async ({ command }) => {
  const build = await createWorkspaceBuild(fileURLToPath(new URL('.', import.meta.url)), command === 'serve');
  // 本机项目关联不进入源码分享包，也不包含云效凭据。
  const links = await fs.readFile(new URL('./.local/data/yunxiao-deployments.json', import.meta.url), 'utf8')
    .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]'; throw error; });
  const deploymentLinks = JSON.stringify(parseDeploymentLinks(JSON.parse(links)));
  return {
    plugins: [vue(), { name: 'workspace-version', configureServer(server: ViteDevServer) {
      server.middlewares.use('/deployment-links.json', (_request, response) => {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(deploymentLinks);
      });
    }, generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'workspace-version.json', source: JSON.stringify(build) });
      this.emitFile({ type: 'asset', fileName: 'deployment-links.json', source: deploymentLinks });
    } }],
    define: { __DELIVERY_BUILD__: JSON.stringify(build) },
    optimizeDeps: { include: ['monaco-editor'] },
    build: { target: 'es2022', emptyOutDir: false, outDir: process.env.DELIVERY_BUILD_DIR || 'dist' },
  };
});
