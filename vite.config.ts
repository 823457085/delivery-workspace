import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceBuild, pruneStaleBuildAssets } from './server/workspace-version.ts';
import { parseDeploymentLinks } from './src/features/deployments/native-deployments.ts';

// 本地服务直接读取 dist；保留本次与最近上一代带 hash 的资源，让已打开页面在热更新后仍能加载异步模块，同时自动清理更早的陈旧构建产物。
export default defineConfig(async ({ command }) => {
  const build = await createWorkspaceBuild(fileURLToPath(new URL('.', import.meta.url)), command === 'serve');
  // 本机项目关联不进入源码分享包，也不包含云效凭据。
  const links = await fs.readFile(new URL('./.local/data/yunxiao-deployments.json', import.meta.url), 'utf8')
    .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]'; throw error; });
  const deploymentLinks = JSON.stringify(parseDeploymentLinks(JSON.parse(links)));
  let resolvedOutDir = '';
  let buildStartedAtMs = Date.now();
  return {
    plugins: [vue(), {
      name: 'workspace-version',
      configResolved(config) {
        resolvedOutDir = path.resolve(config.root, config.build.outDir);
      },
      buildStart() {
        buildStartedAtMs = Date.now();
      },
      configureServer(server: ViteDevServer) {
        server.middlewares.use('/deployment-links.json', (_request, response) => {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(deploymentLinks);
        });
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'workspace-version.json', source: JSON.stringify(build) });
        this.emitFile({ type: 'asset', fileName: 'deployment-links.json', source: deploymentLinks });
      },
      async writeBundle(_options, bundle) {
        if (resolvedOutDir) {
          await pruneStaleBuildAssets(resolvedOutDir, Object.keys(bundle), { buildStartedAtMs });
        }
      },
    } satisfies Plugin],
    define: { __DELIVERY_BUILD__: JSON.stringify(build) },
    optimizeDeps: { include: ['monaco-editor'] },
    build: {
      target: 'es2022',
      emptyOutDir: false,
      outDir: process.env.DELIVERY_BUILD_DIR || 'dist',
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('?worker') || /\.worker(?:\.|-)/.test(id)) return;
            if (id.startsWith('\0') || id.includes('preload-helper')) return 'vendor-vue';
            if (!id.includes('node_modules')) return;
            if (id.includes('/element-plus/') || id.includes('/@element-plus/')
              || id.includes('/@floating-ui/') || id.includes('/@ctrl/tinycolor/')
              || id.includes('/lodash-es/') || id.includes('/dayjs/') || id.includes('/async-validator/')) {
              return 'vendor-element';
            }
            if (id.includes('/@lucide/vue/')) return 'vendor-icons';
            if (id.includes('/markdown-it') || id.includes('/dompurify/')) return 'vendor-markdown';
            if (id.includes('/vue/') || id.includes('/@vue/') || id.includes('/vue-router/') || id.includes('/@tanstack/')) {
              return 'vendor-vue';
            }
          },
        },
      },
    },
  };
});
