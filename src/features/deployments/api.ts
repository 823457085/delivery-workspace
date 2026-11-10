export async function deploymentApi<T>(path = '', options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/deployments${path}`, {
    signal: options.signal,
    ...(options.body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify(options.body),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.details || result?.message || result?.error || `请求失败 (${response.status})`);
  return result;
}
