/** 工作台只通过此入口使用 Jira 研发助手的任务模块（版本见 sync-state.json）；模块保持插件原实现，便于后续对照同步。 */
export { createConnectionSettings } from './connection-settings.mjs';
export { createRequirementStore } from './requirements.mjs';
export { createProjectPreferences, readBranchOptions } from './project-preferences.mjs';
export { scanProjects } from './project-scan.mjs';
export { readProjectStatus } from './project-status.mjs';
export { groupRepositories, repositoryIdentity } from './repository-groups.mjs';
export { createTaskRecords } from './task-records.mjs';
export { createTaskWorkspace, inspectTaskWorkspace } from './task-workspace.mjs';
export { prepareTask } from './tasks.mjs';
export { readTaskIssue } from './task-materials.mjs';
export { sourceIdentity } from './jira-client.mjs';
export { createTaskMaterialContext } from './task-context.mjs';
