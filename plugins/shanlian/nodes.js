export const hasDelay = node => Number.isFinite(node?.delay) && node.delay >= 0;

export function visibleNodes(nodes, { query = '', country = '', sort = 'default' } = {}) {
  query = query.trim().toLowerCase();
  const result = nodes.filter(node => (!country || node.country === country) &&
    `${node.name} ${node.id} ${node.country}`.toLowerCase().includes(query));
  if (sort === 'asc' || sort === 'desc') {
    result.sort((a, b) => {
      if (hasDelay(a) !== hasDelay(b)) return hasDelay(a) ? -1 : 1;
      return hasDelay(a) ? (sort === 'asc' ? a.delay - b.delay : b.delay - a.delay) : 0;
    });
  }
  return result;
}

// Keep individual requests short enough for reverse proxies, and report results
// as they arrive. Stopping leaves in-flight probes to finish without new work.
export async function runDelayTests(ids, { probe, onResult, onProgress, shouldStop }) {
  const queue = [...new Set(ids)];
  const progress = { total: queue.length, completed: 0, succeeded: 0, failed: 0 };
  let next = 0;
  onProgress({ ...progress });
  async function worker() {
    while (!shouldStop() && next < queue.length) {
      const id = queue[next++];
      let value, error;
      try { value = await probe(id); } catch (failure) { error = failure; }
      progress.completed++;
      if (!error && hasDelay(value)) progress.succeeded++;
      else progress.failed++;
      onResult(id, value, error);
      onProgress({ ...progress });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return { ...progress, skipped: queue.length - progress.completed };
}
