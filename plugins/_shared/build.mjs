import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function buildApplication(root, name) {
 const outDir = path.join(root,'package');
 await build({configFile:false,root,plugins:[vue()],define:{'process.env.NODE_ENV':'"production"'},build:{outDir,emptyOutDir:true,lib:{entry:path.join(root,'main.ts'),name,formats:['iife'],fileName:()=> 'ui.js',cssFileName:'ui'},cssCodeSplit:false}});
 await build({configFile:false,root,ssr:{noExternal:['zod']},build:{outDir,emptyOutDir:false,ssr:path.join(root,'application.ts'),rollupOptions:{output:{entryFileNames:'server.mjs',inlineDynamicImports:true}}}});
 await fs.copyFile(path.join(root,'plugin.json'),path.join(outDir,'plugin.json'));
}
