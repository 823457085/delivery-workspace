import type { AutomationProjectProfile, AutomationProjectRouting, AutomationSettings, JiraIssue } from '../../shared/hub';

type Workspace = { path: string; branch?: string; remoteUrl?: string };
export function resolveAutomationProject(
  issue: Pick<JiraIssue, 'key' | 'description' | 'project' | 'components' | 'labels' | 'parent'>,
  projects: Workspace[],
  settings: Partial<Pick<AutomationSettings, 'projectProfiles' | 'repositoryUrl' | 'targetBranch' | 'runtimeEnvironment' | 'runtimeCommand'>>,
  boundWorkspace?: Workspace,
): AutomationProjectRouting & { profile: AutomationProjectProfile | null };
