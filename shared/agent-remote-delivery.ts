/** 群聊结果中的远端交付预览；只有用户确认具体预览后才执行外部写入。 */
export type RemoteDeliveryKind = 'design' | 'jira' | 'git';
export interface RemoteDeliveryAttempt {
  id: string; kind: RemoteDeliveryKind; projectId?: string; fingerprint: string;
  status: 'submitting' | 'completed' | 'failed' | 'uncertain';
  updatedAt: string; detail: string; url?: string; revision?: string;
}
export interface RemoteDeliveryProject {
  id: string; path: string; branch: string; head: string; remote: string; url: string; pushUrl: string;
  files: { path: string; status: string; recommended: boolean }[]; message: string; available: boolean; reason: string;
}
export interface RemoteDeliveryJiraTask {
  key: string; url: string; summary: string; role?: string; action?: string; state?: string;
}
export interface RemoteDeliveryI18nArtifact {
  id: string; projectId: string; path: string; name: string; size: number; sha256: string; downloadUrl: string;
}
export interface RemoteDeliveryPreview {
  roomId: string; taskId: string; fingerprint: string;
  issue: { key: string; url: string; title: string };
  design: { path: string; body: string; title: string; available: boolean; reason: string;
    destination?: { site: string; spaceKey: string; parentId: string; title: string; url: string }; url?: string; version?: number };
  jira: { body: string; available: boolean; reason: string };
  projects: RemoteDeliveryProject[]; attempts: RemoteDeliveryAttempt[];
  jiraTasks?: RemoteDeliveryJiraTask[];
  i18nArtifacts?: RemoteDeliveryI18nArtifact[];
  reviewArtifact?: RemoteDeliveryI18nArtifact;
  previewLinks?: { url: string; label: string; mode: 'i18n-test' | 'mock'; evidence: string }[];
}
export interface RemoteDeliverySubmit {
  requestId: string; fingerprint: string; kind: RemoteDeliveryKind; projectId?: string;
  files?: string[]; message?: string;
}
