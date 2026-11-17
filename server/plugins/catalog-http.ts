export async function boundedResponse(response: Response, limit: number) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`市场连接失败：HTTP ${response.status}`); }
  if (!response.body) return Buffer.alloc(0);
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('市场响应超过大小上限'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; if ((total += value.length) > limit) throw new Error('市场响应超过大小上限'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
