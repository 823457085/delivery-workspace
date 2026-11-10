import { sourceIdentity } from './jira-client.mjs';

/** Jira 断连只影响实时核验；明确来源与已有材料仍可用于本地实现和草稿。 */
export async function readTaskIssue(jira, source, { details = '', cachedIssue } = {}) {
  try { return await jira.readIssue(source); }
  catch (error) {
    if (['JIRA_SOURCE', 'JIRA_SITE_MISMATCH', 'JIRA_CONTRACT'].includes(error.code) || (!details.trim() && !cachedIssue)) throw error;
    const identity = jira.sourceIdentity ? await jira.sourceIdentity(source) : sourceIdentity(source);
    if (cachedIssue && (cachedIssue.key !== identity.key || (cachedIssue.url && identity.url && cachedIssue.url !== identity.url))) throw new Error('已保存材料与当前 Jira 来源不一致。');
    const materialStatus = cachedIssue ? cachedIssue.materialStatus || 'cached' : 'provided';
    return {
      ...(cachedIssue || {}), key: identity.key, url: identity.url || cachedIssue?.url || '',
      summary: cachedIssue?.summary || details.split(/\r?\n/).find(line => line.trim()) || identity.key,
      description: cachedIssue?.description || details,
      materialStatus, materialWarning: `${error.message}；本次使用${cachedIssue ? '已保存' : '用户提供'}材料，未实时刷新 Jira。`,
    };
  }
}
