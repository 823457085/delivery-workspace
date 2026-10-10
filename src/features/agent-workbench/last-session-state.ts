/**
 * 设计说明：最后打开的会话只是当前浏览器的导航偏好，不属于 Agent 运行数据，因此只保存会话 ID。
 * 这里不缓存会话内容，也不决定页面何时完成加载；有效性仍由上层用当前会话列表校验，避免形成第二数据源。
 */
export const LAST_AGENT_SESSION_STORAGE_KEY = 'delivery-workspace.agent-last-session.v1';

export function parseLastAgentSessionId(value: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readLastAgentSessionId(storage: Pick<Storage, 'getItem'>): string {
  try { return parseLastAgentSessionId(storage.getItem(LAST_AGENT_SESSION_STORAGE_KEY)); }
  catch { return ''; }
}

export function saveLastAgentSessionId(storage: Pick<Storage, 'setItem' | 'removeItem'>, conversationId: string): boolean {
  try {
    const id = conversationId.trim();
    if (id) storage.setItem(LAST_AGENT_SESSION_STORAGE_KEY, id);
    else storage.removeItem(LAST_AGENT_SESSION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
