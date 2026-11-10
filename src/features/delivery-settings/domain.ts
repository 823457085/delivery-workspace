/** 与原交付设置的输入语义对齐；只校验本页公开编辑的字段，不复制服务端设置清洗或默认值。 */
import type { AutomationProjectProfile, AutomationSettings, LocalProject } from '../../../shared/hub';

export function emptyProjectProfile(id: string): AutomationProjectProfile {
  return { id, name: '', repositoryUrl: '', localPath: '', runtimeCommand: '', runtimeEnvironment: '', targetBranch: '', jiraProjects: [], components: [], labels: [] };
}
export function selectProfileProject(profile: AutomationProjectProfile, project: LocalProject): AutomationProjectProfile {
  const sameProject = profile.localPath === project.path || !!profile.repositoryUrl && profile.repositoryUrl === project.remoteUrl;
  return { ...profile, name: project.displayName || project.projectName || project.folderName, localPath: project.path,
    repositoryUrl: project.remoteUrl || '', ...(!sameProject ? { runtimeCommand: '', runtimeEnvironment: '', targetBranch: '' } : {}) };
}
export function projectProfileError(profile: AutomationProjectProfile): string {
  const missing = [!profile.name.trim() && '项目名称', !profile.repositoryUrl.trim() && '仓库地址',
    !profile.runtimeCommand.trim() && '启动命令', !profile.runtimeEnvironment.trim() && '运行环境', !profile.targetBranch.trim() && '目标分支'].filter(Boolean);
  return missing.length ? `请填写${missing.join('、')}` : '';
}

export function validDeliverySettings(value?: AutomationSettings) {
  return !!value && value.dailyTimes.length > 0 && value.dailyTimes.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    && Number.isInteger(value.maxDispatchPerRun) && value.maxDispatchPerRun >= 0
    && !!value.startStatus.trim() && !!value.completedStatus.trim()
    && (value.projectProfiles ? value.projectProfiles.every(profile => !projectProfileError(profile)) : !!value.targetBranch.trim());
}
