import type { DeploymentProject } from '../../../shared/deployments';

/** 仅保存原生平台入口；登录、运行权限及审批仍由云效实时校验。 */
export interface NativeDeploymentProject {
  id: string;
  name: string;
  repository: string;
  projectUrl: string;
  environments: { environment: string; name: string; url: string }[];
}

export function parseDeploymentLinks(value: unknown): NativeDeploymentProject[] {
  if (!Array.isArray(value)) throw new Error('云效部署入口配置格式不正确');
  const projects = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.repository !== 'string' || !Array.isArray(item.environments)) throw new Error('云效项目配置不完整');
    const projectUrl = new URL(item.projectUrl);
    if (projectUrl.origin !== 'https://codeup.aliyun.com' || projectUrl.username || projectUrl.password || projectUrl.search || projectUrl.hash
      || !/^\/[a-f0-9]{24}\/[\w./-]+\/pipeline$/.test(projectUrl.pathname)
      || item.repository !== projectUrl.pathname.slice(1, -9)
      || item.id !== `codeup.aliyun.com:${projectUrl.pathname.slice(1, -9)}` || projects.has(item.id)) throw new Error('云效项目入口不匹配');
    projects.add(item.id);
    const environments = new Set<string>();
    for (const binding of item.environments) {
      if (!binding || typeof binding.environment !== 'string' || !binding.environment.trim() || binding.environment.length > 100
        || /[\u0000-\u001f\u007f]/.test(binding.environment) || environments.has(binding.environment)
        || typeof binding.name !== 'string' || !binding.name.trim()) throw new Error('云效环境配置不正确');
      const url = new URL(binding.url);
      if (url.origin !== 'https://flow.aliyun.com' || url.username || url.password || url.search || url.hash
        || !/^\/pipelines\/\d+\/current$/.test(url.pathname)) throw new Error('云效流水线入口不正确');
      environments.add(binding.environment);
    }
  }
  return value;
}

export function mergeDeploymentProjects(projects: DeploymentProject[], native: NativeDeploymentProject[]): DeploymentProject[] {
  const merged = new Map(projects.map(project => [project.id, project]));
  for (const project of native) if (!merged.has(project.id)) merged.set(project.id, {
    id: project.id, name: project.name, repository: project.repository, paths: [], branches: [],
  });
  return [...merged.values()];
}
