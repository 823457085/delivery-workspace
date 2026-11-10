import type { GroupChatDashboard, GroupConfig, GroupRoomDetail, GroupSendInput, GroupTemplate, GroupReviseInput, GroupRerunInput, GroupSteerInput } from '../../../shared/agent-group-chat';
import type { RemoteDeliveryAttempt, RemoteDeliveryPreview, RemoteDeliverySubmit } from '../../../shared/agent-remote-delivery';
import type { AgentAccessMode } from '../../../shared/agent-runtime';
const base = '/api/agent-runtimes/group-chat';
async function request<T>(path = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + path, { method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '团队群聊操作失败');
  return result;
}
export const readGroupDashboard = (signal?: AbortSignal) => request<GroupChatDashboard>('', 'GET', undefined, signal);
export const readGroupRoom = (id: string, signal?: AbortSignal) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}`, 'GET', undefined, signal);
export const renameGroupRoom = (id: string, title: string, expectedTitle: string) =>
  request<{ id: string; title: string }>(`/rooms/${encodeURIComponent(id)}/title`, 'POST', { title, expectedTitle });
export const sendGroupMessage = (input: GroupSendInput) => request<GroupRoomDetail>('/messages', 'POST', input);
export const removeGroupRoom = (id: string) => request<{ id: string; deleted: boolean }>(`/rooms/${encodeURIComponent(id)}/delete`, 'POST', {});
export const pauseGroupMessage = (id: string, messageId: string) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/pause-edit`, 'POST', {});
export const steerGroupMessage = (id: string, input: GroupSteerInput) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/messages/steer`, 'POST', input);
export const reviseGroupMessage = (id: string, messageId: string, input: GroupReviseInput) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/revise`, 'POST', input);
export const saveGroupConfig = (config: GroupConfig) => request<GroupConfig>('/config', 'PUT', { expectedRevision: config.revision, name: config.name, members: config.members });
export const importGroupConfig = (template: unknown, expectedRevision: number) => request<GroupConfig>('/import', 'POST', { template, expectedRevision });
export const readGroupTemplate = () => request<GroupTemplate>('/template');
export const actOnGroup = (id: string, action: 'pause' | 'continue' | 'cancel' | 'rerun', options?: GroupRerunInput | { accessMode?: AgentAccessMode }) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/action`, 'POST', { action, ...options });

export const trustGroupTurn = (id: string, input: { turnId: string; runId: string; workspacePath: string; accessMode?: AgentAccessMode }) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/trust`, 'POST', input);
export const retryGroupTurn = (id: string, input: { turnId: string; runId: string; accessMode?: AgentAccessMode }) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/retry`, 'POST', input);
export const fallbackGroupTurn = (id: string, input: { turnId: string; runId: string; accessMode?: AgentAccessMode }) => request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/fallback`, 'POST', input);
export const readRemoteDelivery = (id: string, signal?: AbortSignal) => request<RemoteDeliveryPreview>(`/rooms/${encodeURIComponent(id)}/delivery`, 'GET', undefined, signal);
export const submitRemoteDelivery = (id: string, input: RemoteDeliverySubmit) => request<RemoteDeliveryAttempt>(`/rooms/${encodeURIComponent(id)}/delivery`, 'POST', input);

export const resumeGroupLogin = (id: string, input: { roundId: string; runId: string; accessMode?: AgentAccessMode }) =>
  request<GroupRoomDetail>(`/rooms/${encodeURIComponent(id)}/resume-login`, 'POST', input);
