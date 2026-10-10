import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledRoot = fileURLToPath(new URL('../../support/', import.meta.url));

/** 显式支持包配置优先；新克隆默认使用仓库内支持包，不依赖作者的 Codex 目录。 */
export function resolveDesignSupportPaths(environment: NodeJS.ProcessEnv = process.env) {
  return {
    skillRoot: path.resolve(environment.DELIVERY_SKILLS_ROOT || path.join(bundledRoot, 'skills')),
    kitRoot: path.resolve(environment.AI_DELIVERY_KIT_ROOT || path.join(bundledRoot, 'ai-delivery-kit')),
  };
}
