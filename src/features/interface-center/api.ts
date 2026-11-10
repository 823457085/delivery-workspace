/** 本机接口工作区协议；调试与远端同步仅由用户显式提交触发。 */
export async function interfaceApi<T>(path = '', input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/interface-center${path}`, {
    cache: 'no-store', signal,
    ...(input === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify(input),
    }),
  });
  const result = await response.json().catch(error => {
    if (signal?.aborted) throw error;
    throw new Error(response.ok ? '工作台接口响应格式不正确' : `工作台请求失败（HTTP ${response.status}）`);
  });
  if (!response.ok) throw new Error(typeof result?.message === 'string' && result.message ? result.message : `工作台请求失败（HTTP ${response.status}）`);
  return result as T;
}

export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
